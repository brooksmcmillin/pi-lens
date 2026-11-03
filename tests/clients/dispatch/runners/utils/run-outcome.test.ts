import { describe, expect, it } from "vitest";
import {
	classifyRunOutcome,
	firstOutputLine,
	processCutShort,
	spawnFailedWithNoOutput,
} from "../../../../../clients/dispatch/runners/utils/spawn-outcome.js";
import type { Diagnostic } from "../../../../../clients/dispatch/types.js";
import {
	faultIfCutShort,
	formatRunOutcomeFailure,
	formatToolFailure,
	skipUnlessToolRan,
} from "../../../../../clients/dispatch/runners/utils/tool-failure.js";
import type { SpawnResult } from "../../../../../clients/safe-spawn.js";
import {
	capKilledSpawnResult,
	capThenTimedOutSpawnResult,
} from "../../../../support/spawn-shapes.js";

function spawnResult(partial: Partial<SpawnResult>): SpawnResult {
	return { stdout: "", stderr: "", status: 0, ...partial };
}

describe("firstOutputLine", () => {
	it("skips leading blank lines the hand-rolled copies returned as empty", () => {
		expect(firstOutputLine("\n\n  error: bad config\nmore")).toBe(
			"error: bad config",
		);
	});

	it('strips the carriage return that split("\\n")[0] left behind', () => {
		expect(firstOutputLine("first\r\nsecond")).toBe("first");
	});

	it("bounds the line and marks the elision", () => {
		expect(firstOutputLine("x".repeat(400))).toBe(`${"x".repeat(200)}…`);
	});

	it("returns an empty string for silence, so callers can || a fallback", () => {
		expect(firstOutputLine("   \n\n")).toBe("");
		expect(firstOutputLine(undefined)).toBe("");
	});
});

describe("classifyRunOutcome", () => {
	it("calls a clean exit a run", () => {
		expect(classifyRunOutcome({ result: spawnResult({}) }).kind).toBe("ran");
	});

	it("calls a nonzero exit WITH output a run — linters exit nonzero on findings", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 1, stdout: '[{"line":1}]' }),
		});
		expect(outcome.kind).toBe("ran");
	});

	it("calls a nonzero exit with nothing to parse did-not-run", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 2, stderr: "unknown flag --nope" }),
		});
		expect(outcome.kind).toBe("did-not-run");
		expect(outcome.status).toBe(2);
		expect(outcome.firstOutputLine).toBe("unknown flag --nope");
	});

	it("names the signal that killed the tool", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({
				status: null,
				signal: "SIGKILL",
				error: new Error("Process killed by signal: SIGKILL"),
				failure: "signal",
			}),
		});
		expect(outcome.kind).toBe("did-not-run");
		expect(outcome.signal).toBe("SIGKILL");
	});

	it("calls a null status with no error did-not-run, never a clean run", () => {
		expect(
			classifyRunOutcome({ result: spawnResult({ status: null }) }).kind,
		).toBe("did-not-run");
	});

	// A null status is decisive on its own: a process that never reported an
	// exit code did not complete an analysis, even if it printed something
	// first. Without this the partial output would read as a clean run.
	it("calls a null status did-not-run even when output arrived", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: null, stdout: '[{"line":1}]' }),
			}).kind,
		).toBe("did-not-run");
	});

	// The declared exit table is the only thing that can catch a rejection that
	// still printed to stdout. Deleting the table branch must red this.
	it("calls a nonzero status outside the declared table a rejected invocation", () => {
		const outcome = classifyRunOutcome({
			result: spawnResult({ status: 78, stdout: "[]" }),
			exitCodes: { ran: [2] },
		});
		expect(outcome.kind).toBe("rejected-invocation");
	});

	it("respects a declared findings code as a real run", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 2, stdout: "[]" }),
				exitCodes: { ran: [2] },
			}).kind,
		).toBe("ran");
	});

	it("calls a missing report after a nonzero exit report-missing", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 1 }),
				reportMissing: true,
			}).kind,
		).toBe("report-missing");
	});

	it("calls a missing report after a CLEAN exit a run — nothing to report is clean", () => {
		expect(
			classifyRunOutcome({
				result: spawnResult({ status: 0 }),
				reportMissing: true,
			}).kind,
		).toBe("ran");
	});
});

// The delegation must not widen the old predicate: existing callers depend on
// a partial-output spawn failure still reaching their parser.
describe("spawnFailedWithNoOutput keeps its historical semantics", () => {
	it("is false when a spawn failure still produced output", () => {
		expect(
			spawnFailedWithNoOutput(
				spawnResult({
					status: null,
					error: new Error("Process timed out after 30000ms"),
					stdout: "[]",
				}),
			),
		).toBe(false);
	});
});

describe("formatToolFailure", () => {
	it("names the signal instead of a null exit status", () => {
		expect(
			formatToolFailure({
				tool: "mypy",
				status: null,
				signal: "SIGKILL",
				stderr: "",
			}),
		).toBe("mypy was killed by SIGKILL with no output: no stderr");
	});

	it("uses one wording for an exit-code failure", () => {
		expect(
			formatToolFailure({
				tool: "vulture",
				status: 2,
				stderr: "error: bad config\ntrace",
			}),
		).toBe("vulture exited 2 with no output: error: bad config");
	});

	it("keeps discriminating fields, so knip's binary source survives", () => {
		expect(
			formatToolFailure({
				tool: "knip",
				status: 2,
				stderr: "config not found",
				fields: { source: "project", command: "npx knip" },
			}),
		).toBe(
			"knip (source=project, command=npx knip) exited 2 with no output: config not found",
		);
	});

	it("says report file, not output, for artifact tools", () => {
		expect(
			formatToolFailure({
				tool: "jscpd",
				status: 1,
				stderr: "boom",
				reportMissing: true,
			}),
		).toBe("jscpd exited 1 with no report file: boom");
	});

	it("truncates once, at the ledger bound", () => {
		const reason = formatToolFailure({
			tool: "vale",
			status: 1,
			stderr: "y".repeat(500),
		});
		expect(reason.length).toBeLessThanOrEqual(201);
		expect(reason.endsWith("…")).toBe(true);
	});

	it("falls back to stdout when stderr is silent", () => {
		expect(
			formatToolFailure({ tool: "taplo", status: 1, stdout: "usage: taplo" }),
		).toBe("taplo exited 1 with no output: usage: taplo");
	});

	// #2100 review F3: an output-cap kill reaches this seam as a plain SIGTERM,
	// so the ledger row read "killed by SIGTERM" — the tool blamed for a kill we
	// sent because WE stopped reading. The cap is the stronger explanation and
	// displaces the signal, exactly as the signal displaces a null exit status.
	it("names the output cap instead of the signal it killed with", () => {
		expect(
			formatToolFailure({
				tool: "oxlint",
				status: null,
				signal: "SIGTERM",
				outputCapped: true,
				stderr: "",
			}),
		).toBe("oxlint was stopped at its output cap with no output: no stderr");
	});
});

describe("classifyRunOutcome output-cap evidence (#2100)", () => {
	it("carries the cap verdict without moving the classification", () => {
		const capped = classifyRunOutcome({
			result: capKilledSpawnResult({ stdout: "partial" }),
		});
		expect(capped.kind).toBe("did-not-run");
		expect(capped.outputCapped).toBe(true);

		// A timeout that also truncated is a timeout, not a cap kill.
		const timedOut = classifyRunOutcome({
			result: capThenTimedOutSpawnResult({ stdout: "partial" }),
		});
		expect(timedOut.kind).toBe("did-not-run");
		expect(timedOut.outputCapped).toBe(false);

		// And an ordinary run is untouched.
		const ran = classifyRunOutcome({
			result: { stdout: "findings", stderr: "", status: 0 },
		});
		expect(ran.kind).toBe("ran");
		expect(ran.outputCapped).toBe(false);
	});

	it("routes the cap wording all the way into the ledger reason", () => {
		const outcome = classifyRunOutcome({
			result: capKilledSpawnResult({ stdout: "partial" }),
		});
		expect(formatRunOutcomeFailure("oxlint", outcome)).toContain(
			"was stopped at its output cap",
		);
	});
});

// RECURRENCE THIS PREVENTS: #4130 item 3. A timeout, a signal death and a
// rejected invocation all reached the smoke classifier as a bare skipped
// result, indistinguishable from an absent tool. `skipUnlessToolRan` already
// knows the outcome kind; the skip carries it.
describe("skipUnlessToolRan names the fault on the skip it returns (#4130)", () => {
	it.each([
		[
			"did-not-run (killed by a signal)",
			{ result: spawnResult({ status: null, signal: "SIGKILL" }) },
			"did-not-run",
		],
		[
			"did-not-run (timeout)",
			{
				result: spawnResult({
					status: null,
					error: new Error("Process timed out after 30000ms"),
				}),
			},
			"did-not-run",
		],
		[
			"rejected-invocation (status outside the declared table)",
			{
				result: spawnResult({ status: 2, stderr: "unknown flag" }),
				exitCodes: { ran: [1] },
			},
			"rejected-invocation",
		],
		[
			"report-missing (artifact tool wrote no report)",
			{ result: spawnResult({ status: 3 }), reportMissing: true },
			"report-missing",
		],
	])("%s", (_name, input, skipFault) => {
		const skipped = skipUnlessToolRan("some-tool", input);
		expect(skipped?.status).toBe("skipped");
		expect(skipped?.skipFault).toBe(skipFault);
	});

	it("returns null when the tool ran", () => {
		expect(
			skipUnlessToolRan("some-tool", {
				result: spawnResult({ status: 1, stdout: "findings" }),
			}),
		).toBeNull();
	});
});

// RECURRENCE THIS PREVENTS: #4130 round 2. Five runner arms (cue-vet,
// gleam-check, prisma-validate, terragrunt, trivy-config) each judged a
// cut-short run on their own, and each one's guard missed a different slice:
// partial output, a negative errno status, a killed run that printed progress
// only. `faultIfCutShort` is the one rule they all call after the parse.
describe("faultIfCutShort, the one rule for a cut-short run (#4130)", () => {
	const finding = (semantic: "blocking" | "warning"): Diagnostic => ({
		id: `t:${semantic}`,
		message: "partial finding",
		filePath: "a.txt",
		line: 1,
		column: 1,
		severity: semantic === "blocking" ? "error" : "warning",
		semantic,
		tool: "t",
	});

	it.each([
		[
			"a spawn error with a negative errno status",
			{ status: -2, error: new Error("ENOENT") },
		],
		[
			"a spawn error with no status",
			{ status: null, error: new Error("timed out") },
		],
		["a signal", { status: null, signal: "SIGKILL" as const }],
		["no exit status and no error", { status: null }],
	])("treats %s as cut short", (_name, partial) => {
		const result = spawnResult(partial);
		expect(processCutShort(result)).toBe(true);
		expect(faultIfCutShort(result, [])).toEqual({
			status: "skipped",
			diagnostics: [],
			semantic: "none",
			skipFault: "did-not-run",
		});
	});

	it("keeps partial findings as a non-blocking-kind failure, blocking by their own semantic", () => {
		const cut = spawnResult({ status: null, signal: "SIGKILL" });
		expect(faultIfCutShort(cut, [finding("blocking")])).toMatchObject({
			status: "failed",
			semantic: "blocking",
			failureKind: "did-not-run",
			diagnostics: [{ id: "t:blocking" }],
		});
		expect(faultIfCutShort(cut, [finding("warning")])).toMatchObject({
			status: "failed",
			semantic: "warning",
			failureKind: "did-not-run",
		});
	});

	it.each([
		["a clean exit", { status: 0 }],
		["a findings exit", { status: 1, stdout: "findings" }],
		[
			"a nonzero exit with nothing printed (the output-based rule is not process-level)",
			{ status: 2 },
		],
	])("returns null for %s", (_name, partial) => {
		const result = spawnResult(partial);
		expect(processCutShort(result)).toBe(false);
		expect(faultIfCutShort(result, [finding("blocking")])).toBeNull();
	});
});
