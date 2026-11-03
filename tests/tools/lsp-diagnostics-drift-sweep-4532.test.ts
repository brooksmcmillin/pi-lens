/**
 * #4532 gap 13: the first `lsp_diagnostics` answer after a document the
 * server already holds was changed OUTSIDE pi (a `cp`, a bash write) must
 * already read clean. Measured on real pyright 1.1.414 through a real pi
 * `AgentSession` (`lens_diagnostics source=lsp`): the first call kept the
 * finding the changed file's importer carried, and only the second call
 * cleared it, because the only thing that re-pushed the changed held file was
 * the turn-settle drift sweep.
 *
 * Recurrence this file prevents: the tool body answered from the importer's
 * last publication. The importer's own touch sends nothing (its bytes did not
 * change), and the touch's own drift sweep (`clients/lsp/index.ts` `touchFile`)
 * is rate-limited and not awaited, so a held DEPENDENCY edited outside pi was
 * re-pushed only after the answer was read.
 *
 * Production chain under test: the REAL tool body -> the REAL `LSPService`
 * and client -> a stdio JSON-RPC wire to the shared fake server, launched as a
 * project-configured custom server. The server is the fake's closed-file-cache
 * profile: an open document's view is the bytes it was last SENT, and every
 * pull is answered from the views held when it arrives. The wire is the
 * witness for the control: the trace names the bytes every didOpen/didChange
 * carried.
 *
 * The cells cover both tool bodies that answer one file from the server's
 * diagnostics: `lsp_diagnostics` (the `path` and `paths` routes; `lens_diagnostics
 * source=lsp` calls the same body) and `lsp_navigation workspaceDiagnostics`
 * with a file path.
 *
 * Real pyright cannot run in the test lanes (it is not an install of this
 * repo), so the real-server transcript lives in the PR body and this fake
 * profile pins the behaviour in the lanes that do run.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4532-g13-";
const env = setupTestEnvironment(PREFIX);
const workspace = env.tmpDir;
const trace = path.join(workspace, "fake.trace");

/** The held dependency before and after the outside change. */
const MODULE_BEFORE = "export const A = 1;\n";
const MODULE_AFTER = "export const A = 1;\nexport const B = 2;\n";
/** Imports `B`, which the held view of `m.ts` does not export until it changes. */
const IMPORTER = 'import { A, B } from "./m";\n';
const MISSING_B = "has no exported member 'B'";

const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

function traceLines(): string[] {
	return fs.existsSync(trace)
		? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean)
		: [];
}

async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

/** Open `file` on the server the way a pi `read` does (a content push only). */
async function hold(file: string): Promise<void> {
	await (
		await lspService()
	).touchFile(file, fs.readFileSync(file, "utf8"), {
		diagnostics: "none",
		clientScope: "primary",
		source: "lsp_sync",
	});
}

async function diagnose(
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4532-g13",
		{ serverScope: "primary", waitMs: 3000, concurrency: 1, ...params },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

/** A fresh `m.ts` + `a.ts` pair, `m.ts` held by the server. */
async function heldPair(name: string): Promise<{ m: string; a: string }> {
	const dir = path.join(workspace, name);
	fs.mkdirSync(dir, { recursive: true });
	const m = path.join(dir, "m.ts");
	const a = path.join(dir, "a.ts");
	fs.writeFileSync(m, MODULE_BEFORE);
	fs.writeFileSync(a, IMPORTER);
	await hold(m);
	return { m, a };
}

describe("a held document changed outside pi (#4532 gap 13)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: the fixture launches a project-configured server in a
		// project pi has trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		const shim = path.join(workspace, "closed-file-server.mjs");
		fs.writeFileSync(
			shim,
			[
				// Pull mode: each document pull is answered from the views the server
				// holds when it is asked, and the client writes one ordered stream, so
				// a didChange written before the pull is always in that answer. The
				// cells therefore pin the SYNC (was the held file re-pushed before the
				// answer was read), not a republish timer.
				'process.env.FAKE_LSP_CLOSED_FILE_CACHE = "1";',
				'process.env.FAKE_LSP_TRACE_TEXT = "1";',
				`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					"fake-ts": {
						name: "closed file cache server",
						extensions: [".ts"],
						command: process.execPath,
						args: [shim],
						rootMarkers: ["package.json"],
					},
				},
				disabledServers: [
					"typescript",
					"deno",
					"ast-grep",
					"typos",
					"opengrep",
				],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		service = (await lspService()) as unknown as typeof service;
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
	});

	it("reads clean on the first call after a held dependency was copied in outside pi", async () => {
		const { m, a } = await heldPair("single");
		const baseline = await diagnose({ path: a });
		expect(baseline.text).toContain(MISSING_B);

		fs.writeFileSync(m, MODULE_AFTER);
		const first = await diagnose({ path: a });

		expect(first.text).not.toContain(MISSING_B);
		expect(first.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// The `paths` branch of the same body. The baseline uses the scalar route on
	// purpose: a batch baseline records a persisted workspace-cache entry, and a
	// session with no dependency index replays that entry by design (#1793), a
	// different layer from the one this cell pins.
	it("reads clean on the first call of the paths route too", async () => {
		const { m, a } = await heldPair("batch");
		expect((await diagnose({ path: a })).text).toContain(MISSING_B);

		fs.writeFileSync(m, MODULE_AFTER);
		const first = await diagnose({ paths: [a] });

		expect(first.text).not.toContain(MISSING_B);
		expect(first.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// The second tool body that answers from the server's diagnostics for one
	// file: `lsp_navigation operation=workspaceDiagnostics` with a file path.
	it("reads clean on the first lsp_navigation workspaceDiagnostics call too", async () => {
		const { m, a } = await heldPair("navigation");
		const { createLspNavigationTool } =
			await import("../../tools/lsp-navigation.js");
		const navigate = async () =>
			String(
				(
					(await createLspNavigationTool(() => false).execute(
						"probe-4532-g13-nav",
						{ operation: "workspaceDiagnostics", path: a },
						undefined as unknown as AbortSignal,
						null,
						{ cwd: workspace },
					)) as { content: Array<{ text?: string }> }
				).content[0]?.text,
			);
		expect(await navigate()).toContain(MISSING_B);

		fs.writeFileSync(m, MODULE_AFTER);
		const first = await navigate();

		expect(first).not.toContain(MISSING_B);
	}, 30_000);

	// Control: a held file whose bytes did not change must cost no content push.
	// Without it, a sweep that re-pushed every held document would pass the
	// cells above.
	it("sends nothing new for a held document that did not change", async () => {
		const { m, a } = await heldPair("control");
		await diagnose({ path: a });
		const settled = traceLines();
		const heldBytes = `text ${pathToFileURL(m).href} ${sha(MODULE_BEFORE)}`;
		expect(settled.filter((line) => line === heldBytes)).toHaveLength(1);

		const again = await diagnose({ path: a });

		expect(again.text).toContain(MISSING_B);
		const added = traceLines().slice(settled.length);
		expect(added.filter((line) => line.startsWith("text "))).toEqual([]);
		expect(
			added.filter((line) => line.startsWith("recv textDocument/didChange")),
		).toEqual([]);
	}, 30_000);
});
