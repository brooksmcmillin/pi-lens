/**
 * #4521: the born-after-start phase of the nightly LSP witness
 * (`runCreatedModuleWitness`), driven over a real stdio language-server wire
 * instead of a scripted answer.
 *
 * The hermetic cases in `smoke-tools-lsp-gate.test.ts` script `execute`, so
 * they cannot say whether the phase reds when the PRODUCT fails to pick up a
 * file born after the server started. These cases run the phase through the
 * real `lsp_diagnostics` handler, LSPService and client, against the shared
 * fake server in two profiles:
 *
 *  - stale lookup (Pyrefly's and pyright's measured shape): a failed module
 *    lookup is cached and only a watched-files Created clears it. Both
 *    creation routes must clear within the deadline. Run on the pre-fix
 *    products (#4344 for the pi write, #4368 for the outside copy) this is the
 *    red-first transcript for #4320 and #4346;
 *  - a server that never picks the file up: the phase must red at its
 *    deadline after polling, not after one call.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import {
	pollUntil,
	runBornAfterStartConfigWitness,
	runCreatedModuleWitness,
} from "../../scripts/smoke-tools.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4521-born-");
const workspace = env.tmpDir;

// The fake's stale-lookup profile reports `import "./name"` as a missing
// module until a Created for `name<ext>` arrives. `.ts` is the extension the
// review graph's import extraction reads, which the outside route needs (#4346).
const reportsMissing = (text: string, name: string) =>
	text.includes(`Cannot find module ${name}`);
const importerText = (name: string) => `import "./${name}"\nconst v = 1;\n`;

const staleLookupFixture = {
	lang: "typescript",
	serverHint: "stale-lookup fake",
	createdModuleWitness: {
		ext: ".ts",
		importerText,
		moduleText: "export {};\n",
		reportsMissing,
	},
};

// Resolves the module to a name the witness never creates, so the importer's
// finding can never clear: a server that never picks the file up.
// Answers each importer once, then goes silent: the module is genuinely
// unresolvable and every later check of it times out (review r1 of #4533, F1).
const silentAfterReportFixture = {
	lang: "silent",
	serverHint: "silent-after-report fake",
	createdModuleWitness: {
		ext: ".sl",
		importerText,
		moduleText: "return {}\n",
		reportsMissing,
	},
};

// #4532: a server hosted as "python" whose module search path is read once from
// `pyrightconfig.json` at its root (the fake's FAKE_LSP_CONFIG_FILE profile).
// The module sits in `libs/`, which only the config puts on the path.
const configBoundFixture = {
	lang: "python",
	serverHint: "config-bound fake",
	bornAfterStartConfig: {
		ext: ".py",
		importerText,
		moduleText: "VALUE = 1\n",
		reportsMissing,
		moduleDir: "libs",
		configFile: "pyrightconfig.json",
		configText: JSON.stringify({ extraPaths: ["libs"] }),
		ancestorMarker: "requirements.txt",
		rootMarker: "setup.py",
	},
};

const neverPicksUpFixture = {
	lang: "teal",
	serverHint: "never-picks-up fake",
	createdModuleWitness: {
		ext: ".tl",
		importerText,
		moduleText: "return {}\n",
		reportsMissing,
	},
};

describe("the born-after-start phase over a real language-server wire (#4521)", () => {
	let service: {
		shutdown: () => Promise<void>;
		touchFile: (...args: never[]) => Promise<unknown>;
		livePrimaryClientRoots?: () => Array<{ root: string }>;
	};

	beforeAll(async () => {
		// Host-boundary stub: a project-configured server in a project pi has
		// trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		const shim = (
			name: string,
			vars: Record<string, string>,
			prelude: string[] = [],
		) => {
			const file = path.join(workspace, name);
			fs.writeFileSync(
				file,
				[
					...Object.entries(vars).map(
						([key, value]) => `process.env.${key} = ${JSON.stringify(value)};`,
					),
					...prelude,
					`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
					"",
				].join("\n"),
			);
			return file;
		};
		const stale = shim("stale-lookup-server.mjs", {
			FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
			FAKE_LSP_STALE_MODULE_LOOKUP: "1",
			FAKE_LSP_STALE_MODULE_EXT: ".ts",
		});
		const never = shim("never-picks-up-server.mjs", {
			FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
			FAKE_LSP_STALE_MODULE_LOOKUP: "1",
			FAKE_LSP_STALE_MODULE_EXT: ".never-created",
		});
		const configBound = shim("config-bound-server.mjs", {
			FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
			FAKE_LSP_STALE_MODULE_LOOKUP: "1",
			FAKE_LSP_STALE_MODULE_EXT: ".py",
			FAKE_LSP_CONFIG_FILE: "pyrightconfig.json",
		});
		const silent = shim(
			"silent-after-report-server.mjs",
			{
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
				FAKE_LSP_STALE_MODULE_LOOKUP: "1",
				FAKE_LSP_STALE_MODULE_EXT: ".never-created",
			},
			[
				// Drop every publish after the first one for a document.
				"const published = new Set();",
				"const write = process.stdout.write.bind(process.stdout);",
				"process.stdout.write = (chunk, ...rest) => {",
				"  const text = String(chunk);",
				'  if (text.includes("textDocument/publishDiagnostics")) {',
				'    const uri = /"uri":"([^"]+)"/.exec(text)?.[1] ?? text;',
				"    if (published.has(uri)) return true;",
				"    published.add(uri);",
				"  }",
				"  return write(chunk, ...rest);",
				"};",
			],
		);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"born-after-start","version":"0.0.0"}\n',
		);
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					"stale-ts": {
						name: "stale lookup server",
						extensions: [".ts"],
						command: process.execPath,
						args: [stale],
						rootMarkers: ["package.json"],
					},
					"silent-fake": {
						name: "silent after report",
						extensions: [".sl"],
						command: process.execPath,
						args: [silent],
						rootMarkers: ["package.json"],
					},
					"never-fake": {
						name: "never picks up",
						extensions: [".tl"],
						command: process.execPath,
						args: [never],
						rootMarkers: ["package.json"],
					},
				},
				// #4532: the built-in python server (id `python`, the one the config
				// routing names) runs the config-bound fake.
				serverOverrides: {
					python: { command: [process.execPath, configBound] },
				},
				// The built-in servers are replaced; ast-grep, opengrep and typos never
				// confirm here, so a call would wait on them.
				disabledServers: [
					"typescript",
					"deno",
					"python-jedi",
					"opengrep",
					"ast-grep",
					"typos",
				],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService() as unknown as typeof service;
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4521-born-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
	});

	async function phase(
		fixture: unknown,
		poll: { deadlineMs: number; intervalMs: number },
	) {
		const { createLspDiagnosticsTool } =
			await import("../../tools/lsp-diagnostics.js");
		return runCreatedModuleWitness(fixture as never, {
			workspace,
			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: undefined,
				onUpdate: null,
				ctx: { cwd: string },
			) =>
				createLspDiagnosticsTool().execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					ctx,
				),
			getLSPService: () => service,
			...poll,
		});
	}

	// Recurrence: #4320 (a module born after the server stayed unresolved for
	// the server's life, pi write route) and #4346 (the same for a module
	// copied in from outside pi-lens). Pre-fix products leave the importer
	// stale, so both rows red at the deadline.
	it("clears the importer after a module is born from a pi write and from outside pi-lens", async () => {
		const rows = await phase(staleLookupFixture, {
			deadlineMs: 10_000,
			intervalMs: 100,
		});
		expect(rows.map((row) => [row.runner, row.state])).toEqual([
			["stale-lookup fake created (pi write)", "pass"],
			["stale-lookup fake created (outside pi-lens)", "pass"],
		]);
	}, 60_000);

	// Recurrence: a phase that can only pass (a witness that cannot red) is a
	// vacuous nightly row. A server that never picks the file up must red it at
	// the deadline, and only after polling: one call is the flake the deadline
	// replaced (2 of 5 local pyright runs).
	it("reds at its deadline, after polling, when the server never picks the file up", async () => {
		const rows = await phase(neverPicksUpFixture, {
			deadlineMs: 1_500,
			intervalMs: 100,
		});
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		for (const row of rows) {
			const calls = Number(
				/after (\d+) calls over/.exec(String(row.detail))?.[1],
			);
			expect(calls).toBeGreaterThan(3);
			expect(row.detail).toMatch(/still reports .* missing/);
		}
	}, 60_000);

	// Recurrence: review r1 of #4533 (F1). A server that reports the missing
	// import once and then never answers makes the tool print "check timed out
	// - NOT the same as 0 diagnostics", which carries no finding. The poll read
	// that as cleared, so a regressed product on a slow runner went green.
	it("reds when the server goes silent after it reports the missing import", async () => {
		const rows = await phase(silentAfterReportFixture, {
			deadlineMs: 3_000,
			intervalMs: 100,
		});
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		for (const row of rows)
			expect(row.detail).toContain("answers inconclusively");
	}, 60_000);

	// ---- #4532 gap 12 / #4521: what configures the server, born after start ----

	async function configPhase(
		look: (root: string) => Promise<unknown>,
		fixture: unknown = configBoundFixture,
	) {
		const { createLspDiagnosticsTool } =
			await import("../../tools/lsp-diagnostics.js");
		return runBornAfterStartConfigWitness(fixture as never, {
			workspace,
			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: undefined,
				onUpdate: null,
				ctx: { cwd: string },
			) =>
				createLspDiagnosticsTool().execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					ctx,
				),
			look,
			// #4532 gap 14: the row names the live primary roots, so a cell can assert
			// the subdirectory hosts its own client and not only that the finding
			// cleared.
			clientRoots: () =>
				(service.livePrimaryClientRoots?.() ?? []).map(
					(entry) => path.relative(workspace, entry.root) || ".",
				),
			deadlineMs: 10_000,
			intervalMs: 100,
		});
	}

	// Recurrence: #4532 gap 12 (a `pyrightconfig.json` created after pyright
	// answered stayed unread for the server's life: 20 polls over 11.9 s) and
	// #4521's parked config and root-marker fixtures. The look is the one pi
	// runs at every `tool_call`; the pre-fix product forwarded no config file, so
	// the config row reds at its deadline. The root-marker row is green on the
	// pre-fix product (a marker is resolved at each call); it reds when the
	// project-boundary check is neutered (mutation row in the PR).
	it("clears the importer after the server's config file is born, and after a root marker is", async () => {
		const rows = await configPhase((root) =>
			lookForOutOfBandChanges(root, "tool_call"),
		);
		// The third row is the gap-14 case. It PASSES here for a reason worth
		// naming: this fixture root carries the shared `.git`, which the built-in
		// python detector counts as a project root, so a file in a subdirectory
		// resolves to the workspace and the boundary verdict is never consulted.
		// The defect needs a marker-less workspace above the subdirectory — the
		// nightly's own fixture (no `.git`, no manifest) and the pyright transcript
		// in the PR body. The verdict itself is pinned by
		// tests/clients/lsp/client-registry-direct.test.ts, both directions.
		expect(rows.map((row) => [row.runner, row.state])).toEqual([
			["config-bound fake born after start (config file)", "pass"],
			["config-bound fake born after start (root marker)", "pass"],
			[
				"config-bound fake born after start (root marker, no ancestor marker)",
				"pass",
			],
		]);
		// The row's evidence, not only its verdict: the subdirectory hosts its own
		// client by the time the importer reads clean.
		expect(String(rows[2].detail)).toContain("witness_sub_");
	}, 60_000);

	// #4532 gap 5: the ANSWER route forwards the late config for itself. The
	// injected look above stands in for pi's `tool_call` hook; a tool run whose
	// hook looked nothing at all still answers clean on the FIRST call, because
	// `lsp_diagnostics` now runs the same out-of-band look (with a forced walk)
	// before it answers. That is what the MCP route and any direct caller get
	// too, and it is why the config row can no longer be redded by removing the
	// hook's look: the red direction for it is the mutation that removes the
	// tool's own look (PR body, mutation rows).
	it("forwards the config on the first call even when the hook's look did nothing", async () => {
		const rows = await configPhase(async () => undefined);
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass", "pass"]);
		expect(rows[0].detail).toContain("cleared on call 1");
	}, 60_000);

	async function diagnoseText(file: string): Promise<string> {
		const { createLspDiagnosticsTool } =
			await import("../../tools/lsp-diagnostics.js");
		const result = (await createLspDiagnosticsTool().execute(
			"cfg-4532",
			{ path: file, waitMs: 3000, serverScope: "primary" },
			undefined,
			null,
			{ cwd: workspace },
		)) as { content: Array<{ text?: string }> };
		return String(result.content[0]?.text);
	}

	/** Look, then diagnose, until the finding reads `want` (the witness's own poll). */
	async function pollMissing(
		file: string,
		name: string,
		want: boolean,
		look: () => Promise<unknown>,
	): Promise<boolean> {
		const polled = await pollUntil(
			async () => {
				await look();
				return reportsMissing(await diagnoseText(file), name) === want;
			},
			{ deadlineMs: 10_000, intervalMs: 100 },
		);
		return polled.ok;
	}

	// Control: the config present when the server starts resolves on the first
	// call (pyright, measured). Its own directory is a project root of its own
	// (`setup.py`), so a fresh client reads the config at initialize.
	it("reads clean when the config exists before the server starts", async () => {
		const dir = path.join(workspace, "ctrl");
		fs.mkdirSync(path.join(dir, "libs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "setup.py"), "");
		fs.writeFileSync(path.join(dir, "libs", "ctrlmod.py"), "VALUE = 1\n");
		fs.writeFileSync(
			path.join(dir, "pyrightconfig.json"),
			JSON.stringify({ extraPaths: ["libs"] }),
		);
		const importer = path.join(dir, "ctrl_user.py");
		fs.writeFileSync(importer, importerText("ctrlmod"));
		expect(reportsMissing(await diagnoseText(importer), "ctrlmod")).toBe(false);
	}, 60_000);

	// Recurrence: gap 12's mirror image. A config removed after the server read
	// it must put the finding back, which only a Deleted event does.
	it("puts the finding back when the config is deleted after the server read it", async () => {
		const dir = path.join(workspace, "del");
		fs.mkdirSync(path.join(dir, "libs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "setup.py"), "");
		fs.writeFileSync(path.join(dir, "libs", "delmod.py"), "VALUE = 1\n");
		const configFile = path.join(dir, "pyrightconfig.json");
		fs.writeFileSync(configFile, JSON.stringify({ extraPaths: ["libs"] }));
		const importer = path.join(dir, "del_user.py");
		fs.writeFileSync(importer, importerText("delmod"));
		const look = () => lookForOutOfBandChanges(dir, "tool_call");
		expect(await pollMissing(importer, "delmod", false, look)).toBe(true);
		fs.rmSync(configFile);
		expect(await pollMissing(importer, "delmod", true, look)).toBe(true);
	}, 60_000);

	// Recurrence: the observability record. One row per look that forwarded a
	// config, naming it, never one per server or per poll.
	it("records one lsp_out_of_band_change row naming the forwarded config", async () => {
		const dir = path.join(workspace, "obs");
		fs.mkdirSync(path.join(dir, "libs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "setup.py"), "");
		fs.writeFileSync(path.join(dir, "libs", "obsmod.py"), "VALUE = 1\n");
		const importer = path.join(dir, "obs_user.py");
		fs.writeFileSync(importer, importerText("obsmod"));
		const saved = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const look = () => lookForOutOfBandChanges(dir, "tool_call");
			expect(await pollMissing(importer, "obsmod", true, look)).toBe(true);
			fs.writeFileSync(
				path.join(dir, "pyrightconfig.json"),
				JSON.stringify({ extraPaths: ["libs"] }),
			);
			expect(await pollMissing(importer, "obsmod", false, look)).toBe(true);
			await flushLatencyLog();
			const { rows: all, skipped } = readNdjsonRows<{
				phase?: string;
				filePath?: string;
				result?: string;
				metadata?: { configs?: string[] };
			}>(getLatencyLogPath());
			expect(skipped).toBe(0);
			const rows = all.filter(
				(row) => row.phase === "lsp_out_of_band_change" && row.filePath === dir,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].result).toBe("config");
			expect(rows[0].metadata?.configs).toEqual(["created:pyrightconfig.json"]);
		} finally {
			if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = saved;
		}
	}, 60_000);
});
