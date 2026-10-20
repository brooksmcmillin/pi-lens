import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyLspGateResult,
	classifyOfficialDockerGateResult,
	LSP_FIXTURES,
	runCreatedModuleWitness,
	runLspGate,
} from "../../scripts/smoke-tools.mjs";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const fixture = { lang: "lua", serverHint: "probe-primary" };

const gateFixture = {
	lang: "typescript",
	dir: "tests/fixtures/tool-smoke/typescript",
	file: "bad.ts",
	serverHint: "probe-primary",
	tools: [],
	setup: undefined,
};

const originalHome = process.env.PI_LENS_HOME;
const tempHomes: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const home of tempHomes.splice(0))
		fs.rmSync(home, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
});

function gateDeps(
	execute: () => Promise<unknown>,
	fixtureOverrides: Record<string, unknown> = {},
	hasDockerBuildx = true,
) {
	const selectedFixture = { ...gateFixture, ...fixtureOverrides };
	return {
		population: {
			eligible: [selectedFixture],
			gated: [selectedFixture],
			exempt: [],
		},
		ensureTool: vi.fn(async () => "/mock/tool"),
		getInstallAttempt: vi.fn(),
		initLSPConfig: vi.fn(async () => undefined),
		bootstrapFixtureWorkspace: vi.fn(async () => ({
			workspace: "/tmp/pi-lens-gate-test-workspace",
			absFile: "/tmp/pi-lens-gate-test-workspace/bad.ts",
			cleanup: vi.fn(),
		})),
		createLspDiagnosticsTool: () => ({ execute }),
		adoptProjectTrustFromContext: vi.fn(),
		hasDockerBuildx: vi.fn(() => hasDockerBuildx),
	};
}

async function runGateWithCensus(
	state: string,
	execute: () => Promise<unknown>,
	fixtureOverrides?: Record<string, unknown>,
	hasDockerBuildx = true,
) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gate-census-"));
	tempHomes.push(home);
	process.env.PI_LENS_HOME = home;
	fs.writeFileSync(
		path.join(home, "lsp-handshake-census.json"),
		JSON.stringify({ typescript: { state } }),
	);
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args) =>
		output.push(args.join(" ")),
	);
	const deps = gateDeps(execute, fixtureOverrides, hasDockerBuildx);
	await runLspGate({
		langs: ["typescript"],
		install: false,
		verbose: false,
		deps,
	});
	return { output: output.join("\n"), deps };
}

describe("LSP diagnostics clean-gate classification (#2780/#2776)", () => {
	it("requires the official Docker BuildKit rule, or discloses unavailable buildx", () => {
		// #3939 recurrence: the official server's old fixture produced an empty
		// list, and allowEmptyBaseline turned that unsupported rule set into green.
		const finding = {
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "JSONArgsRecommended" }],
			},
		};
		expect(classifyOfficialDockerGateResult(finding, true)).toMatchObject({
			state: "pass",
		});
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				true,
			),
		).toMatchObject({ state: "fail" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				false,
			),
		).toMatchObject({ state: "skip", detail: "buildx unavailable" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { unavailable: "official server unavailable" } },
				true,
			),
		).toMatchObject({ state: "skip", detail: "official server unavailable" });
	});

	it("passes only when the real handler reports a primary finding", () => {
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 1,
						auxiliaryDiagnosticsCount: 0,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds diagnostics delivered only outside the primary bucket", () => {
		// #2776 recurrence: a custom primary pushed a finding whose source differed
		// from its server id, so the handler returned a diagnostic but rendered zero
		// primary findings. The nightly gate must catch that provenance drift.
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 0,
						auxiliaryDiagnosticsCount: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("skips a server whose declared tool is unavailable", () => {
		// #3309 recurrence: installer availability can disagree with a real
		// language-toolchain server. The gate must use the handler's no_clients
		// decision, not an ensureTool preflight.
		expect(classifyLspGateResult(undefined, fixture, true)).toMatchObject({
			state: "skip",
		});
	});

	it("fails when the handler ran but returned no primary finding", () => {
		expect(
			classifyLspGateResult(
				{ details: { totalDiagnostics: 0, primaryDiagnosticsCount: 0 } },
				fixture,
			),
		).toMatchObject({ state: "fail" });
	});
});

describe("smoke-tools --lsp-gate census admission (#3309)", () => {
	it("keeps a non-pass handshake census row unavailable", async () => {
		// R2-M1 recurrence: a census row that did not pass was admitted to the
		// diagnostic handler, so an unavailable handshake could look gated.
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { output } = await runGateWithCensus("skip", execute);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps a handler-owned unavailable result out of the gated census", async () => {
		// R2-M1 companion cell: the handler can discover unavailability after the
		// handshake census passed; that result must retain the ⚠ row semantics.
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const execute = vi.fn(async () => {
			await safeSpawnAsync("probe-language-server", []);
			return { details: { unavailable: "probe server unavailable" } };
		});
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(safeSpawnAsync).toHaveBeenCalledOnce();
	});

	it("routes a declared diagnostic code through the gated classifier", async () => {
		const execute = vi.fn(async () => ({
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "DifferentRule" }],
			},
		}));
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		// #3939 recurrence: removing the declared-code routing would let the
		// generic primary-finding classifier accept the wrong rule.
		expect(output).toContain("✗  typescript");
		expect(output).toContain(
			"official Docker server did not return AnyDeclaredRule",
		);
	});

	it("adopts the host trust result before driving diagnostics", async () => {
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { deps } = await runGateWithCensus("pass", execute);

		expect(deps.adoptProjectTrustFromContext).toHaveBeenCalledOnce();
		const context = deps.adoptProjectTrustFromContext.mock.calls[0][0];
		expect(context).toEqual({ isProjectTrusted: expect.any(Function) });
		expect(context.isProjectTrusted()).toBe(true);
	});
});

// #4320/#4346: the witness's verdicts, through its real entry with a scripted
// language-server answer (the server is the process boundary; the nightly
// runs it against pyright). A witness that cannot red, or that passes when the
// missing import was never reported, would be a vacuous nightly row.
describe("smoke-tools created-module witness (#4320/#4346)", () => {
	const python = LSP_FIXTURES.find(
		(fixture) =>
			fixture.lang === "python" &&
			(fixture as { createdModuleWitness?: unknown }).createdModuleWitness,
	);

	// A short deadline keeps a red case fast; the phase's real one is 20 s.
	const POLL = { deadlineMs: 400, intervalMs: 2 };

	async function witness(
		reports: (call: number, name: string) => boolean,
		seen: (name: string, moduleExists: boolean) => void = () => undefined,
		// The phase's own poll settings when `{}` is passed.
		poll: { deadlineMs?: number; intervalMs?: number } = POLL,
		// A call whose answer is not a verdict at all (a timed-out check).
		inconclusive: (call: number) => boolean = () => false,
	) {
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-created-witness-"),
		);
		tempHomes.push(workspace);
		const calls: string[] = [];
		const execute = vi.fn(async (_id: string, params: { path: string }) => {
			const source = fs.readFileSync(params.path, "utf8");
			const name = /import (\w+)/.exec(source)?.[1] ?? "";
			calls.push(name);
			seen(
				name,
				fs.existsSync(path.join(path.dirname(params.path), `${name}.py`)),
			);
			const call = calls.filter((entry) => entry === name).length;
			if (inconclusive(call))
				return {
					content: [
						{
							text: "Primary LSP: check timed out - NOT the same as 0 diagnostics; the file may still have errors",
						},
					],
				};
			const missing = reports(call, name);
			return {
				content: [
					{ text: missing ? `Import "${name}" could not be resolved` : "ok" },
				],
			};
		});
		const touchFile = vi.fn(async () => undefined);
		const rows = await runCreatedModuleWitness(python, {
			workspace,
			execute,
			getLSPService: () => makeLspServiceDouble({ touchFile }),
			...poll,
		});
		return { rows, touchFile, workspace };
	}

	it("passes both cases when the missing import clears on the first call after creation", async () => {
		const { rows, touchFile } = await witness((call) => call === 1);
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass"]);
		// The pi write case syncs the module through the service; the outside
		// case never does.
		expect(touchFile).toHaveBeenCalledOnce();
	});

	it("reds a case whose importer still reports the created module", async () => {
		const { rows } = await witness(() => true);
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		expect(rows[1].detail).toContain("still reports");
	});

	it("runs inside the clean gate and counts its red", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gate-census-"));
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-created-witness-gate-"),
		);
		tempHomes.push(home, workspace);
		process.env.PI_LENS_HOME = home;
		fs.writeFileSync(
			path.join(home, "lsp-handshake-census.json"),
			JSON.stringify({ python: { state: "pass" } }),
		);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) =>
			output.push(args.join(" ")),
		);
		// Every call reports one primary finding, the module included: the
		// clean gate passes and the witness's importer never clears.
		const execute = vi.fn(async (_id: string, params: { path: string }) => {
			const name = /import (\w+)/.exec(
				fs.readFileSync(params.path, "utf8"),
			)?.[1];
			return {
				details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
				content: [{ text: `Import "${name}" could not be resolved` }],
			};
		});
		fs.writeFileSync(path.join(workspace, "bad.py"), "import os\n");
		const failures = await runLspGate({
			langs: ["python"],
			install: false,
			verbose: false,
			deps: {
				population: { eligible: [python], gated: [python], exempt: [] },
				ensureTool: vi.fn(async () => "/mock/tool"),
				getInstallAttempt: vi.fn(),
				initLSPConfig: vi.fn(async () => undefined),
				bootstrapFixtureWorkspace: vi.fn(async () => ({
					workspace,
					absFile: path.join(workspace, "bad.py"),
					cleanup: vi.fn(),
				})),
				createLspDiagnosticsTool: () => ({ execute }),
				adoptProjectTrustFromContext: vi.fn(),
				getLSPService: () => makeLspServiceDouble(),
				createdModulePoll: { deadlineMs: 30, intervalMs: 2 },
			},
		});

		expect(output.join("\n")).toContain("LSP created-module witness");
		expect(failures).toBe(2);
	});

	// Recurrence: the one-call witness red-flaked locally (2 of 5 pyright runs
	// on 2026-10-16: the outside case cleared on the second call, 2.4 s after
	// creation). A verdict that changes late must pass; a verdict
	// that never changes still reds (the next test).
	it("passes a case whose missing import clears only on a later poll", async () => {
		const { rows } = await witness((call) => call < 4);
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass"]);
		// call 1 is the ready gate; creation follows; the post-creation polls are
		// calls 2 and 3 (still stale) and 4 (cleared): its third poll
		expect(rows[0].detail).toContain("cleared on call 3");
	});

	it("reds a case that is still stale at the deadline, naming how many calls it polled", async () => {
		const { rows } = await witness(() => true);
		for (const row of rows) {
			const polled = Number(
				/after (\d+) calls over/.exec(String(row.detail))?.[1],
			);
			// more than one call: the verdict is polled to the deadline, not read once
			expect(polled).toBeGreaterThan(1);
		}
	});

	// Recurrence: a server that has not yet answered for the importer (cold
	// index) read as "not reported", so the witness red-flaked with a
	// precondition failure on pre-fix trees (2 of 3 pyright runs). The module
	// must not exist until the server has reported the missing import.
	it("creates the module only after the server reports the importer's missing import", async () => {
		const moduleExistedAt: boolean[] = [];
		const { rows } = await witness(
			(call) => call === 3,
			(_name, moduleExists) => moduleExistedAt.push(moduleExists),
		);
		// calls 1 and 2 are not-yet-ready answers and call 3 reports the missing
		// import: the module is absent for all three, and exists for call 4, the
		// first poll after creation
		expect(moduleExistedAt.slice(0, 4)).toEqual([false, false, false, true]);
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass"]);
	});

	// Recurrence: review r1 of #4533 (F1). A timed-out check prints no finding,
	// so "the finding is absent" read as clean and one slow answer in 33 polls
	// turned a regressed product green.
	it("does not read a timed-out check as a cleared import", async () => {
		const { rows } = await witness(
			() => true,
			undefined,
			POLL,
			(call) => call === 3,
		);
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		expect(rows[0].detail).toContain("answers inconclusively");
	});

	// Recurrence: review r1 of #4533 (F2). Every other case overrides the poll
	// settings, so a default deadline of 0 or an interval of a minute reverted
	// the nightly to the one-call witness with nothing red. Call 2 is stale, so
	// the second post-creation call must be reached under the defaults.
	it("polls under its default settings until the import clears", async () => {
		const { rows } = await witness((call) => call < 3, undefined, {});
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass"]);
		expect(rows[0].detail).toContain("cleared on call 2");
	});

	it("never creates the module when the server never reports the missing import", async () => {
		const names = new Set<string>();
		const { rows, touchFile, workspace } = await witness(
			() => false,
			(name) => names.add(name),
		);
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		expect(touchFile).not.toHaveBeenCalled();
		expect(names.size).toBe(2);
		for (const name of names)
			expect(fs.existsSync(path.join(workspace, `${name}.py`))).toBe(false);
	});

	it("reds a case whose missing import was never reported first", async () => {
		const { rows } = await witness(() => false);
		expect(rows.map((row) => row.detail)).toEqual([
			expect.stringContaining("precondition"),
			expect.stringContaining("precondition"),
		]);
	});
});
