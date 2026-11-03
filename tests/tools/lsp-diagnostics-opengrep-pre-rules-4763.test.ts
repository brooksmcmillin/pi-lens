// flake-shape: in-process-mock — the lsp_aux_wait_outcome and lsp_rules_refreshed rows are outside the getRecentLoggedPhases ring (LAST_PHASE_EXCLUDED) and test mode skips the file sink, so a passed-through logLatency spy is the only reader of the per-touch published counts and held-publish counter (#4763)
/**
 * #4763: Opengrep with `--config auto` loads its rules after `didOpen`. A scan
 * before that logs "Rules not loaded yet, not scanning anything", publishes an
 * EMPTY set, and the real set follows `semgrep/rulesRefreshed` 0.7 to 1.0 s
 * later (measured on 1.30.0 and 1.32.0; opengrep@60ed3b3
 * `Scan_helpers.run_semgrep` and `refresh_rules`). pi-lens read that empty set
 * as the auxiliary's answer, so the cold touch reported "No auxiliary
 * findings." while the finding arrived after the wait (0 of 86 aux waits in
 * the field carried findings).
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real `LSPService`
 * and a real client over stdio. The command of the real `opengrep` registry
 * entry (so the strategy lookup is the production one, keyed by the server id)
 * is overridden to a shim around the shared fake server, which publishes the
 * measured sequence. Each case owns a workspace and so its own client, which is
 * what a cold session is.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// `vi.hoisted`: the factory is hoisted above the static imports, and the
// degradation ledger imports the real logger during that window.
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4763-");
const root = fs.realpathSync(env.tmpDir);
const FINDING = "diagnostic published after the index warmed";
/** Gap between the shim's publishes: the stand-in for the rule-load window. */
const GAP_MS = 250;

/**
 * A workspace whose `opengrep` command is the fake server pinned to one
 * publish sequence, and whose JSON primary answers clean. `.git` is the root
 * marker `OpengrepServer` keys on.
 */
function createWorkspace(name: string, sequence: string): string {
	const workspace = path.join(root, name);
	fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	const shim = (file: string, lines: string[]) => {
		fs.writeFileSync(
			file,
			[
				...lines,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
	};
	const opengrepShim = path.join(workspace, "opengrep-server.mjs");
	shim(opengrepShim, [
		// Push-only, as measured: opengrep advertises no pull provider.
		'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
		`process.env.FAKE_LSP_PUBLISH_SEQUENCE = ${JSON.stringify(sequence)};`,
		`process.env.FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS = ${JSON.stringify(String(GAP_MS))};`,
	]);
	const jsonShim = path.join(workspace, "json-server.mjs");
	shim(jsonShim, ['process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";']);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4763-fixture","private":true}\n',
	);
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				json: { command: [process.execPath, jsonShim] },
				opengrep: { command: [process.execPath, opengrepShim] },
			},
			disabledServers: ["ast-grep", "typos", "zizmor"],
		}),
	);
	return workspace;
}

async function diagnose(
	workspace: string,
	file: string,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4763",
		{ path: file, serverScope: "all", waitMs: 3000 },
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

/** The `lsp_aux_wait_outcome` outcome rows for opengrep, oldest first. */
function opengrepOutcomes(): Array<{
	outcome: string;
	publishedCount?: number;
}> {
	return logLatency.mock.calls
		.map(([row]) => row as { phase?: string; metadata?: { outcomes?: any[] } })
		.filter((row) => row.phase === "lsp_aux_wait_outcome")
		.flatMap((row) => row.metadata?.outcomes ?? [])
		.filter((entry) => entry.serverId === "opengrep");
}

describe("#4763 opengrep's empty publish before its rules load", () => {
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(() => {
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
	});

	beforeEach(() => {
		logLatency.mockClear();
		resetLSPService();
		getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4763-", {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("delivers the finding opengrep publishes after its rules load, not 'No auxiliary findings.'", async () => {
		// The reported defect, verbatim: `[]` first, the notification, then the
		// finding. The empty set used to end the touch as `answered`.
		const workspace = createWorkspace("cold", "empty,refreshed,dirty");
		const file = path.join(workspace, "app.json");
		fs.writeFileSync(file, '{"a": 1}\n');

		const { text } = await diagnose(workspace, file);

		expect(text).toContain("Auxiliary findings (1)");
		expect(text).toContain(FINDING);
		expect(text).not.toContain("No auxiliary findings.");
		// R5: the row says how many diagnostics opengrep published for the touch.
		expect(opengrepOutcomes()).toEqual([
			expect.objectContaining({ outcome: "answered", publishedCount: 1 }),
		]);
	});

	it("still confirms a clean file, on the republish after the rules load", async () => {
		// The overcorrection guard: the hold must release on the server's own
		// notification, so a genuinely clean file is an affirmative clean and
		// never a timeout.
		const workspace = createWorkspace("clean", "empty,refreshed,empty");
		const file = path.join(workspace, "ok.json");
		fs.writeFileSync(file, '{"a": 1}\n');

		const { text, details } = await diagnose(workspace, file);

		expect(text).toContain("No auxiliary findings.");
		expect(details.unconfirmed).not.toBe(true);
		expect(opengrepOutcomes()).toEqual([
			expect.objectContaining({ outcome: "answered", publishedCount: 0 }),
		]);
	});

	it("does not report a scanner whose rules never load as having found nothing", async () => {
		// Offline `auto`: the rules never load, so the only publish is the empty
		// one. That is not an answer, and it must not read as a clean file.
		const workspace = createWorkspace("never", "empty");
		const file = path.join(workspace, "off.json");
		fs.writeFileSync(file, '{"a": 1}\n');

		const { text } = await diagnose(workspace, file);

		// The coverage notice is the honest reading: nothing answered, so the
		// absence of findings says nothing about the file.
		expect(text).toContain(
			"Auxiliary coverage INCOMPLETE — opengrep did not answer within the wait budget",
		);
		expect(opengrepOutcomes()).toEqual([
			expect.objectContaining({ outcome: "silent", publishedCount: 0 }),
		]);
	});

	it("delivers the finding on an edit after the rules loaded (reopen resync)", async () => {
		// The warm edit path: opengrep ignores didChange, so the client closes and
		// reopens the document, and the warm server publishes the scan alone
		// (measured: one publish 0.25 to 0.5 s after the reopen, edit by edit).
		// No empty publish precedes it, so nothing is held.
		const workspace = createWorkspace("warm", "empty,refreshed,dirty");
		const file = path.join(workspace, "edit.json");
		fs.writeFileSync(file, '{"a": 1}\n');
		await diagnose(workspace, file);
		logLatency.mockClear();

		fs.writeFileSync(file, '{"a": 2}\n');
		const edited = await diagnose(workspace, file);

		expect(edited.text).toContain("Auxiliary findings (1)");
		expect(edited.text).toContain(FINDING);
		expect(opengrepOutcomes()).toEqual([
			expect.objectContaining({ outcome: "answered", publishedCount: 1 }),
		]);
	});
});
