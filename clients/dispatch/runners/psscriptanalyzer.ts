import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawnAsync, type SpawnResult } from "../../safe-spawn.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	classifyProbeFailure,
	createAvailabilityLatch,
	isLatchingOutcome,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./utils/availability-policy.js";

interface PSAnalyzerResult {
	RuleName?: string;
	Severity?: string;
	Line?: number;
	Column?: number;
	Message?: string;
}

// The PS script written to a temp file each run. `-File` with a temp script
// keeps the analysis argv free of embedded script text; safe-spawn itself never
// uses a shell (#817), so nothing here is quoting-sensitive.
const PS_SCRIPT = `
param([string]$FilePath)
Import-Module PSScriptAnalyzer -ErrorAction Stop
$results = @(Invoke-ScriptAnalyzer -Path $FilePath | Select-Object RuleName,@{N='Severity';E={$_.Severity.ToString()}},Line,Column,Message)
if ($results.Count -eq 0) { Write-Output '[]'; exit 0 }
$results | ConvertTo-Json -Depth 3 -Compress
`.trim();

const PS_TIMEOUT_MS = 30000;

/**
 * PowerShell spawns go through `safeSpawnAsync` (#1490).
 *
 * The hand-rolled version returned `status: null` for a timeout, a synchronous
 * `spawn UNKNOWN` and a missing binary alike, so the call site had nothing to
 * classify and remembered every one of them as "PowerShell analysis is not
 * available". `safeSpawnAsync` carries the standard taxonomy — `failure`,
 * `spawnFailure.kind` and the errno on `error` — which is what lets the
 * availability policy tell a stall from an absence.
 */
function spawnPs(
	cmd: string,
	args: string[],
	timeoutMs = PS_TIMEOUT_MS,
): Promise<SpawnResult> {
	return safeSpawnAsync(cmd, args, {
		timeout: timeoutMs,
		resourceLabel: "psscriptanalyzer",
	});
}

/**
 * The two verdicts this runner memoizes, both owned by the shared policy.
 *
 * The availability-policy coverage gate never flagged either of them, and the
 * reason is not a bug in the gate: it recognises a probe by a quoted VERSION
 * FLAG, and neither probe below asks for a version. One runs `exit 0` to see if
 * an interpreter answers; the other asks `Get-Module -ListAvailable`. A
 * capability probe with no version flag is invisible to that pre-filter, so this
 * file was skipped before any unit was analysed. The residual gate blindness is
 * tracked with #1489's gate work; the migration here does not depend on it.
 */
const psCmdLatch = createAvailabilityLatch();
const psAnalyzerLatchByCmd = new Map<
	string,
	ReturnType<typeof createAvailabilityLatch>
>();
let psCmd: string | null = null;

/** Record one decision, and report whether the caller may retry later. */
function notePsDecision(
	latch: ReturnType<typeof createAvailabilityLatch>,
	tool: string,
	verdict:
		| { available: true; elapsedMs: number; hostStallMs: number }
		| {
				available: false;
				outcome: AvailabilityOutcome;
				cause: AvailabilityCause;
				elapsedMs: number;
				hostStallMs: number;
			},
): void {
	let retryAfterMs: number | undefined;
	if (verdict.available) {
		latch.noteAvailable();
	} else {
		const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
		if (delay > 0) retryAfterMs = delay;
	}
	logAvailabilityDecision({
		tool,
		verdict: verdict.available ? "available" : "unavailable",
		outcome: verdict.available ? "success" : verdict.outcome,
		cause: verdict.available ? "ok" : verdict.cause,
		elapsedMs: verdict.elapsedMs,
		latched: verdict.available || isLatchingOutcome(verdict.outcome),
		hostStallMs: verdict.hostStallMs,
		...(retryAfterMs !== undefined && { retryAfterMs }),
		budgetMs: PS_TIMEOUT_MS,
	});
}

/**
 * Drop both verdicts at the session boundary (#1490 review).
 *
 * Every other runner gets this for free through
 * `resetDispatchAvailabilityState`'s generation counter; these latches are local
 * to the module, so `session_start` clears them explicitly. Without it, a
 * PowerShell or module install performed mid-process is invisible until the host
 * restarts — the same "suppression outliving its session" defect #1222 fixed for
 * install attempts.
 */
export function resetPsScriptAnalyzerAvailability(): void {
	psCmdLatch.reset();
	psAnalyzerLatchByCmd.clear();
	psCmd = null;
}

/**
 * Resolve the PowerShell binary, once per session per verdict.
 *
 * A candidate that times out is NOT evidence that PowerShell is absent, so the
 * loop only concludes "missing" when every candidate answered with a durable
 * failure. One transient candidate makes the whole verdict transient, and the
 * next turn after the cooldown probes again.
 */
async function resolvePowerShellCmd(): Promise<string | null> {
	const memo = psCmdLatch.read();
	if (memo !== null) return memo ? psCmd : null;

	// Rank what the candidates said, rather than collapsing every failure to
	// "not-found" (#1490 review). A stall outranks everything: it means we never
	// got an answer. A present-but-rejecting interpreter (nonzero exit, EACCES)
	// is durable but is NOT a missing install, and reporting it as one both sends
	// the user to install PowerShell they already have and fabricates the cause in
	// `availability_decision`. Only an all-candidates ENOENT sweep is `missing`.
	let transient: { outcome: AvailabilityOutcome; cause: AvailabilityCause } | null =
		null;
	let rejected: { outcome: AvailabilityOutcome; cause: AvailabilityCause } | null =
		null;
	let elapsedTotalMs = 0;
	let stallTotalMs = 0;
	for (const candidate of ["pwsh", "powershell"]) {
		const sampler = startHostStallSampler();
		const startedAt = Date.now();
		const result = await spawnPs(candidate, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"exit 0",
		]);
		const hostStallMs = sampler.stop();
		const elapsedMs = Date.now() - startedAt;
		elapsedTotalMs += elapsedMs;
		stallTotalMs += hostStallMs;
		if (!result.error && result.status === 0) {
			psCmd = candidate;
			notePsDecision(psCmdLatch, "powershell", {
				available: true,
				elapsedMs,
				hostStallMs,
			});
			return candidate;
		}
		const classified = classifyProbeFailure(result, { hostStallMs });
		if (classified.outcome === "transient") transient ??= classified;
		else if (classified.outcome !== "missing") rejected ??= classified;
	}

	psCmd = null;
	const verdict = transient ??
		rejected ?? {
			outcome: "missing" as AvailabilityOutcome,
			cause: "not-found" as AvailabilityCause,
		};
	notePsDecision(psCmdLatch, "powershell", {
		available: false,
		outcome: verdict.outcome,
		cause: verdict.cause,
		elapsedMs: elapsedTotalMs,
		hostStallMs: stallTotalMs,
	});
	return null;
}

async function checkModuleAvailable(cmd: string): Promise<boolean> {
	let latch = psAnalyzerLatchByCmd.get(cmd);
	if (!latch) {
		latch = createAvailabilityLatch();
		psAnalyzerLatchByCmd.set(cmd, latch);
	}
	const memo = latch.read();
	if (memo !== null) return memo;

	const sampler = startHostStallSampler();
	const startedAt = Date.now();
	const result = await spawnPs(cmd, [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }",
	]);
	const hostStallMs = sampler.stop();
	const elapsedMs = Date.now() - startedAt;
	if (!result.error && result.status === 0) {
		notePsDecision(latch, "psscriptanalyzer", {
			available: true,
			elapsedMs,
			hostStallMs,
		});
		return true;
	}
	// A CLEAN `exit 1` is the module genuinely not being installed — the one
	// outcome an install fixes, so that alone earns the `missing` override.
	//
	// Everything else did not answer the question (#1490 review). A `spawn
	// UNKNOWN`, an EMFILE, an EACCES, or a PowerShell that vanished between the
	// two probes all arrive with an error and no status, and calling those
	// "PSScriptAnalyzer is not installed" latched PowerShell analysis off for the
	// session on hosts where the module was present the whole time.
	const moduleAbsent =
		result.status === 1 && !result.failure && !result.error;
	const classified = classifyProbeFailure(result, {
		hostStallMs,
		...(moduleAbsent && { unclassifiedFailureOutcome: "missing" as const }),
	});
	let { outcome, cause } = classified;
	if (!moduleAbsent && outcome !== "transient") {
		// Nothing here is evidence about the module, so the verdict must expire.
		outcome = "transient";
		cause = "probe-rejected";
	}
	notePsDecision(latch, "psscriptanalyzer", {
		available: false,
		outcome,
		cause,
		elapsedMs,
		hostStallMs,
	});
	return false;
}

function parsePSAnalyzerOutput(raw: string, filePath: string): Diagnostic[] {
	if (!raw.trim() || raw.trim() === "[]") return [];
	let parsed: PSAnalyzerResult | PSAnalyzerResult[];
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items
		.filter((item) => item.Message && item.Line)
		.map((item) => {
			const sev = (item.Severity ?? "Warning").toLowerCase();
			const severity: "error" | "warning" | "info" =
				(sev === "error" || sev === "parseerror") ? "error" : (sev === "information" ? "info" : "warning");
			const rule = item.RuleName ?? "PSScriptAnalyzer";
			return {
				id: `psscriptanalyzer-${rule}-${item.Line}`,
				message: `[${rule}] ${item.Message}`,
				filePath,
				line: item.Line!,
				column: item.Column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "psscriptanalyzer",
				rule,
				fixable: false,
			};
		});
}

const psScriptAnalyzerRunner: RunnerDefinition = {
	id: "psscriptanalyzer",
	appliesTo: ["powershell"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cmd = await resolvePowerShellCmd();
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		if (!(await checkModuleAvailable(cmd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);

		// Write script to temp file so we avoid cmd.exe quoting entirely
		const tmpScript = path.join(os.tmpdir(), `pi-lens-psa-${process.pid}.ps1`);
		await fs.writeFile(tmpScript, PS_SCRIPT, "utf-8");

		try {
			const result = await spawnPs(cmd, [
				"-NoProfile",
				"-NonInteractive",
				"-File", tmpScript,
				"-FilePath", absPath,
			]);

			if (result.status === null) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			const diagnostics = parsePSAnalyzerOutput(result.stdout, ctx.filePath);

			if (diagnostics.length === 0) {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			}

			const hasErrors = diagnostics.some((d) => d.severity === "error");
			return {
				status: hasErrors ? "failed" : "succeeded",
				diagnostics,
				semantic: hasErrors ? "blocking" : "warning",
			};
		} finally {
			await fs.unlink(tmpScript).catch(() => {});
		}
	},
};

export default psScriptAnalyzerRunner;
