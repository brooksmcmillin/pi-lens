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
import { runCreatedModuleWitness } from "../../scripts/smoke-tools.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

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
				// The built-in servers are replaced; ast-grep, opengrep and typos never
				// confirm here, so a call would wait on them.
				disabledServers: [
					"typescript",
					"deno",
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
});
