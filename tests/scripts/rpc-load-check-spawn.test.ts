// flake-shape: real-process-spawn — the subject is the script's own process
// contract: it spawns a `pi` child, reads its JSONL, and its exit code is what
// install-smoke reads. The child is a stand-in at the true process boundary
// (tests/fixtures/rpc-load-check/fake-pi.mjs); an in-process call of the
// classifier cannot prove that a pi that exits, or a signal that arrives on the
// wire, turns the exit code red.
// lane: wall-clock-budget (serialized); no wall-clock assertion. The 20 runs
// of the script go through a width-5 pool in beforeAll and each case asserts
// its own settled run.
/**
 * #4401, recurrences #4400 (pi exited at session start and the old check had
 * no way to see an exit) and #4314 (a failed warm is a log line, not an
 * `extension_error`). Each case injects exactly one signal into the stand-in
 * pi and expects the script's exit code and message.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts/rpc-load-check.mjs");
// A failing run keeps its scratch dir for forensics; keep it out of the shared tmp.
const tmpRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-rpc-load-check-"),
);
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const FAKE_PI = path.resolve("tests/fixtures/rpc-load-check/fake-pi.mjs");

// Each run owns a mkdtemp scratch, an agent dir inside it and a listen(0)
// provider port (scripts/rpc-load-check.mjs run()). The shared inputs are
// read-only (cwd, env, FAKE_PI) plus tmpRoot as the scratch parent, and only
// one run names the install-once marker file.
const POOL_WIDTH = 5;
// The most one case could take before the pool: vitest's default 5 s test
// timeout. A hung child settles as a failed run, never as a failed hook.
const RUN_TIMEOUT_MS = 5_000;

type RunSpec = {
	mode: string;
	args?: string[];
	stageMs?: number;
	marker?: string;
};
type RunResult = { code: number | null; out: string };

// One entry per case, keyed by the case and not the mode: `clean`,
// `host-exit` and `log-warn` each run twice, under different args or
// assertions.
const RUNS = {
	clean: { mode: "clean" },
	hostExit: { mode: "host-exit" },
	extensionError: { mode: "extension-error" },
	warningNotice: { mode: "warning-notice" },
	logWarn: { mode: "log-warn" },
	noCommands: { mode: "no-commands" },
	cleanFailWorker: { mode: "clean", args: ["--fail-worker"] },
	hostExitFailWorker: { mode: "host-exit", args: ["--fail-worker"] },
	turnError: { mode: "turn-error" },
	noProvider: { mode: "no-provider" },
	noWarmup: { mode: "no-warmup", stageMs: 2000 },
	noAgentEnd: { mode: "no-agent-end", stageMs: 2000 },
	noFallback: { mode: "no-fallback", args: ["--fail-worker"], stageMs: 2000 },
	tsLateRefusal: { mode: "ts-late-refusal", stageMs: 20_000 },
	tsLateStart: { mode: "ts-late-start", stageMs: 20_000 },
	tsNever: { mode: "ts-never", stageMs: 2000 },
	untrusted: { mode: "untrusted" },
	logWarnDetail: { mode: "log-warn" },
	installFailOnce: {
		mode: "install-fail-once",
		marker: path.join(tmpRoot, "install-once-marker"),
	},
	installFailAlways: { mode: "install-fail-always" },
} satisfies Record<string, RunSpec>;
type RunName = keyof typeof RUNS;

async function smoke({
	mode,
	args = [],
	stageMs,
	marker,
}: RunSpec): Promise<RunResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_MODE: mode,
		TMPDIR: tmpRoot,
	};
	if (stageMs) env.RPC_LOAD_CHECK_STAGE_TIMEOUT_MS = String(stageMs);
	if (marker) {
		env.FAKE_PI_MARKER = marker;
		fs.rmSync(marker, { force: true });
	}
	// The ambient VITEST variables belong to the outer worker.
	for (const key of Object.keys(env))
		if (key.startsWith("VITEST") || key === "TEST") delete env[key];
	try {
		const { stdout } = await run(
			process.execPath,
			[SCRIPT, FAKE_PI, "--extension", "/unused", ...args],
			{ env, timeout: RUN_TIMEOUT_MS },
		);
		return { code: 0, out: stdout };
	} catch (err) {
		const failure = err as { code: number | null; stdout?: string };
		return { code: failure.code ?? null, out: failure.stdout ?? "" };
	}
}

const results = new Map<RunName, RunResult>();

// `smoke` settles every run (a failed or killed child is a result, not a
// throw), so one broken mode reds its own case and never this hook.
async function runPool(): Promise<void> {
	const queue = Object.entries(RUNS) as Array<[RunName, RunSpec]>;
	await Promise.all(
		Array.from({ length: POOL_WIDTH }, async () => {
			for (let next = queue.shift(); next; next = queue.shift())
				results.set(next[0], await smoke(next[1]));
		}),
	);
}

function outcome(name: RunName): RunResult {
	const result = results.get(name);
	if (!result) throw new Error(`no settled run for ${name}`);
	return result;
}

describe.skipIf(process.platform === "win32")(
	// The fixture is a shebang script; the Windows lane has no way to exec it.
	"scripts/rpc-load-check.mjs exit code (#4401)",
	() => {
		beforeAll(runPool);

		it("passes a pi that loads, warms up and finishes the first turn", () => {
			const result = outcome("clean");
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("fails a pi that exits during start-up (#4400)", () => {
			const result = outcome("hostExit");
			expect(result.out).toContain("FAIL: pi exited during");
			expect(result.code).toBe(1);
		});

		it("fails an extension_error event", () => {
			const result = outcome("extensionError");
			expect(result.out).toContain("FAIL: extension_error: boom");
			expect(result.code).toBe(1);
		});

		it("fails a warning notice", () => {
			const result = outcome("warningNotice");
			expect(result.out).toContain("FAIL: warning notice: something degraded");
			expect(result.code).toBe(1);
		});

		it("fails a pi-lens warn line in extension.log (#4314)", () => {
			const result = outcome("logWarn");
			expect(result.out).toContain(
				"FAIL: extension.log warn [lsp]: LSP warm failed",
			);
			expect(result.code).toBe(1);
		});

		it("fails a pi that registers no lens-* commands", () => {
			const result = outcome("noCommands");
			expect(result.out).toContain("FAIL: pi-lens registered no commands");
			expect(result.code).toBe(1);
		});

		it("failing-worker variant: passes when pi survives and logs the forced fallback", () => {
			const result = outcome("cleanFailWorker");
			expect(result.out).toContain("with the snapshot worker forced to fail");
			expect(result.code).toBe(0);
		});

		it("failing-worker variant: still fails a pi that exits", () => {
			const result = outcome("hostExitFailWorker");
			expect(result.out).toContain("FAIL: pi exited during");
			expect(result.code).toBe(1);
		});
		it("fails a first turn that ends in an error, not a stop", () => {
			const result = outcome("turnError");
			expect(result.out).toContain("first turn did not finish cleanly");
			expect(result.code).toBe(1);
		});

		it("fails a first turn that never reached the provider", () => {
			const result = outcome("noProvider");
			expect(result.out).toContain("never reached the fake provider");
			expect(result.code).toBe(1);
		});

		it("times out (exit 2) when the warm-up never completes", () => {
			const result = outcome("noWarmup");
			expect(result.out).toContain("TIMEOUT waiting for session-start warm-up");
			expect(result.code).toBe(2);
		});

		it("times out (exit 2) when the first turn never ends", () => {
			const result = outcome("noAgentEnd");
			expect(result.out).toContain("TIMEOUT waiting for first turn");
			expect(result.code).toBe(2);
		});

		it("failing-worker variant: times out when the forced fallback is never logged", () => {
			// Without this the variant would be a vacuous green: pi surviving proves
			// nothing if the seam never made the worker fail.
			const result = outcome("noFallback");
			expect(result.out).toContain(
				"TIMEOUT waiting for the forced worker failure",
			);
			expect(result.code).toBe(2);
		});
		// Recurrence: #4441 review F2. The bare-tsc refusal (#4414) logs about a
		// second after the turn ends. A check that reads the logs a fixed second
		// after agent_end passed published 4.4.3 whenever the tsc probe took 2 s
		// or more. The fake logs the refusal 2.5 s after agent_end.
		it("fails a TypeScript server refusal that logs seconds after the turn ends", () => {
			const result = outcome("tsLateRefusal");
			expect(result.out).toContain(
				"the TypeScript language server did not start",
			);
			expect(result.out).toContain("project-local LSP binary refused");
			expect(result.code).toBe(1);
		});

		it("waits for a TypeScript server that starts seconds after the turn ends", () => {
			const result = outcome("tsLateStart");
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("times out (exit 2) when the TypeScript server neither starts nor fails", () => {
			// A smoke that never saw the server start proves nothing about the LSP leg.
			const result = outcome("tsNever");
			expect(result.out).toContain(
				"TIMEOUT waiting for the TypeScript language server to start or fail",
			);
			expect(result.code).toBe(2);
		});

		it("fails, naming it, when the smoke project is not trusted (the LSP leg would be dark)", () => {
			// Recurrence: #4409 round 1. An untrusted CI project refused the LSP
			// spawn; the allow-listed refusal then hid that the leg never ran.
			const result = outcome("untrusted");
			expect(result.out).toContain("FAIL: smoke project is not trusted");
			expect(result.code).toBe(1);
		});

		it("prints the offending record in full and the log tails on failure", () => {
			const result = outcome("logWarnDetail");
			expect(result.out).toContain(
				'offending record (extension.log): {"level":"warn"',
			);
			expect(result.out).toContain("--- sessionstart.log (last 40 lines)");
			expect(result.out).toContain("--- extension.log (last 40 lines)");
			expect(result.out).toContain("project trust = trusted");
		});

		it("retries once when the language-server install failed, and passes on the second run", () => {
			const result = outcome("installFailOnce");
			expect(result.out).toContain("install failure: ");
			expect(result.out).toContain("retrying once");
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("fails after the one retry when the install keeps failing, printing the install lines", () => {
			const result = outcome("installFailAlways");
			expect(result.out.match(/retrying once/g)).toHaveLength(1);
			expect(result.out.match(/install failure: /g)).toHaveLength(2);
			expect(result.code).toBe(1);
		});
	},
);
