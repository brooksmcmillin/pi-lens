/**
 * scripts/lib/ci-runtime-cap.mjs (#3920 item 3, #4691): the ONE rule that
 * compares a required CI job's runtime with its `timeout-minutes`. Two readers
 * share it: `scripts/ci-verdict.mjs` (the last completed run of one head,
 * `runtimeCapLines`) and the nightly `scripts/check-ci-job-p90.mjs` (the p90
 * over recent master runs, `p90CapReport`). One ratio, one job-name matcher,
 * one cap entry shape, one gating predicate: a second copy of any of them is
 * how the first cut of #4691 measured 2 of the 9 required contexts.
 *
 * Nothing here fetches or loads a compiled `clients/` file: callers pass the
 * parsed caps (and `escapeRegExp`) in, so this module loads in a checkout that
 * never ran `npm run build` (#4680 r4 F1).
 */
import {
	isGatingCheckName,
	REQUIRED_CHECKS,
	resolveLatestByName,
	resolveTriggerAdvisoryNames,
	shardAggregateName,
} from "./ci-checks.mjs";

// #3920 item 3: a required job's recent runtime against its `timeout-minutes`.
//
// The TLA+ shard cap was found only when pull requests started timing out
// (623-881 s against a 720 s cap), and #4672 then showed the other half: a
// 735 s shard `cancelled` at its own timeout reddens a REQUIRED check with no
// violation. Nothing compared a job's runtime to its cap, so the cap sat at the
// measured maximum and nobody could see it coming.
//
// This is a non-gating REPORT, never a verdict: it prints one line per job whose
// last completed run reached `RUNTIME_CAP_WARN_RATIO` of its own cap, and it can
// never change this script's exit code. It is printed from the check-runs this
// run already fetched (each row carries `started_at`/`completed_at`), so it
// costs no extra API call and no network access of its own. A MATRIX shard is
// its own subject: `TLA+ models (shard 4/4)` warns on its own even while the
// `TLA+ models` aggregate is momentarily fine, which is exactly the shard that
// was cancelled.
//
// The caps come from the workflow YAML itself -- ONE source, no second table
// that can drift from the file the runner enforces. `${{ matrix.shard }}` and
// `${{ strategy.job-total }}` in a job's `name:` are expanded to patterns so a
// check-run's real name still resolves to its job's cap.
// ---------------------------------------------------------------------------

/** Warn at 70% of the cap: the headroom the repo's own size rule (#3123)
 * assumes, and what surfaces a shard "running at the cap" before it lands. */
export const RUNTIME_CAP_WARN_RATIO = 0.7;

/** Most runtime lines one report prints; the rest are counted (#3166 shape 10:
 * a bound on a human-facing surface discloses its truncation). */
export const MAX_RUNTIME_CAP_LINES = 12;

/**
 * A workflow job's `name:` (or its id, which GitHub uses when `name:` is
 * absent) as a RegExp that matches the EXPANDED check-run name. Matrix and
 * job-total placeholders expand; any other expression admits any token, so an
 * unrecognised placeholder still matches its job rather than silently dropping
 * the job from the report.
 *
 * `escapeRegExp` is the ONE runtime copy (`clients/string-utils.ts`, #2558),
 * passed in rather than imported: that file is build output, and this script
 * must load in a checkout that never ran `npm run build` (#4680 r4 F1).
 * `readJobTimeCaps` loads it lazily beside the YAML parser, the other compiled
 * file this report needs, so an unbuilt checkout loses this report alone.
 *
 * @param {string} jobName
 * @param {(text: string) => string} escapeRegExp
 * @returns {RegExp}
 */
export function checkNamePattern(jobName, escapeRegExp) {
	// Split on the placeholders FIRST and escape only the literal chunks: a
	// name is escaped after expansion would leave `matrix\.shard` behind, and
	// an expansion pattern escaped with the rest would stop being a pattern.
	const raw = String(jobName);
	const placeholder = /\$\{\{\s*([^}]*?)\s*\}\}/g;
	const parts = [];
	let previous = 0;
	for (const match of raw.matchAll(placeholder)) {
		parts.push(escapeRegExp(raw.slice(previous, match.index)));
		// `strategy.job-total` is always a count; everything else (a matrix leg,
		// an env value this reader cannot resolve) admits any one token, so an
		// unrecognised placeholder matches its own job instead of dropping it.
		parts.push(match[1] === "strategy.job-total" ? "[0-9]+" : "[^()\\s]+");
		previous = match.index + match[0].length;
	}
	parts.push(escapeRegExp(raw.slice(previous)));
	return new RegExp(`^${parts.join("")}$`);
}

/**
 * The cap entries of one parsed workflow document.
 *
 * @param {object} doc a `yaml.load` of a workflow file
 * @param {string} file the workflow's path, for the printed line
 * @param {(text: string) => string} escapeRegExp see `checkNamePattern`
 * @returns {Array<{ file: string, jobId: string, name: string, capMinutes: number, pattern: RegExp }>}
 */
export function jobCapEntries(doc, file, escapeRegExp) {
	const jobs = doc?.jobs;
	if (!jobs || typeof jobs !== "object") return [];
	const entries = [];
	for (const [jobId, job] of Object.entries(jobs)) {
		if (!job || typeof job !== "object") continue;
		const cap = Number(job["timeout-minutes"]);
		if (!Number.isFinite(cap) || cap <= 0) continue;
		const name = typeof job.name === "string" && job.name ? job.name : jobId;
		entries.push({
			file,
			jobId,
			name,
			capMinutes: cap,
			pattern: checkNamePattern(name, escapeRegExp),
		});
	}
	return entries;
}

/** Seconds a completed check-run took, or null when GitHub omitted either end. */
function checkRunSeconds(run) {
	const start = Date.parse(String(run?.started_at ?? ""));
	const end = Date.parse(String(run?.completed_at ?? ""));
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return null;
	return Math.round((end - start) / 1000);
}

/**
 * The report lines: one per check-run at or above the ratio of its job's cap,
 * heaviest ratio first, with a counted remainder past the print bound. A job
 * whose name matches no cap entry, or whose run has no duration, is simply not
 * reported (it is not a finding, and this report never gates).
 *
 * @param {{ checkRuns: object[], caps: Array<{ name: string, capMinutes: number, pattern: RegExp }>, requiredChecks?: string[], ratio?: number, limit?: number }} args
 * @returns {string[]}
 */
export function runtimeCapLines({
	checkRuns,
	caps,
	requiredChecks = REQUIRED_CHECKS,
	ratio = RUNTIME_CAP_WARN_RATIO,
	limit = MAX_RUNTIME_CAP_LINES,
}) {
	const payload = Array.isArray(checkRuns) ? checkRuns : [];
	const latest = resolveLatestByName(payload);
	const required = new Set(requiredChecks);
	// The same #4090 resolution the verdict applies: a nightly lane's check-run
	// attaches to whatever head it ran on, so its name is not a gate on THIS
	// commit. Without it the marker labelled seven schedule-only jobs
	// `(gating)` while `computeVerdict` scored the same names `gating: false`
	// (V5a).
	const triggerAdvisoryNames = resolveTriggerAdvisoryNames(payload);
	const measured = [];
	for (const [name, run] of latest) {
		const entry = caps.find((candidate) => candidate.pattern.test(name));
		if (!entry) continue;
		const seconds = checkRunSeconds(run);
		if (seconds === null) continue;
		const capSeconds = entry.capMinutes * 60;
		const used = seconds / capSeconds;
		measured.push({
			name,
			seconds,
			capSeconds,
			used,
			jobId: entry.jobId,
			file: entry.file,
			// A row is gating when branch protection requires its name -- the
			// live read's list, else `REQUIRED_CHECKS` -- or when the name is
			// neither on the advisory allowlist nor a schedule-only lane. The
			// printed line reads it, and `computeVerdict` answers the same
			// question through the same owner, so the two markers cannot
			// disagree again (V5a).
			gating: isGatingCheckName(name, {
				required,
				triggerAdvisoryNames,
			}),
		});
	}
	// A matrix shard is its own subject: the aggregate's row measures seconds of
	// `echo`, and the shard that gets cancelled is the one worth naming.
	const over = measured
		.filter((row) => row.used >= ratio)
		.sort(
			(left, right) =>
				right.used - left.used || left.name.localeCompare(right.name),
		);
	if (over.length === 0) {
		return [
			`Runtime vs cap: no job is at ${Math.round(ratio * 100)}% of its timeout (${measured.length} job(s) measured)`,
		];
	}
	const printed = over.slice(0, limit).map((row) => {
		const percent = Math.round(row.used * 100);
		const verdict =
			row.used >= 1
				? "at or over its cap -- a slower runner turns finished work into `cancelled` (#4672)"
				: `within ${Math.round((1 - ratio) * 100)}% of its cap`;
		return `Runtime vs cap: ${row.name} ${row.seconds}s of ${row.capSeconds}s (${percent}%) -- ${verdict} [${row.file} job \`${row.jobId}\`]${row.gating ? " (gating)" : " (advisory)"}`;
	});
	const hidden = over.length - printed.length;
	if (hidden > 0)
		printed.push(
			`Runtime vs cap: +${hidden} more job(s) at or above ${Math.round(ratio * 100)}% of their cap, not printed`,
		);
	return printed;
}

// ---------------------------------------------------------------------------
// #4691: the same rule over a WINDOW of recent runs. `runtimeCapLines` reads the
// last completed run of one head; the nightly asks whether the p90 of the last
// N master runs of a workflow sits at `RUNTIME_CAP_WARN_RATIO` of the cap, so a
// slow trend surfaces before one run is `cancelled` at its timeout.
// ---------------------------------------------------------------------------

/**
 * Nearest-rank p90: the value at rank ceil(0.9 n) of the ascending samples.
 * Returns undefined for no samples.
 *
 * @param {number[]} values
 */
export function p90(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/**
 * The required context a check-run name belongs to, or null: the name itself
 * when it is required (`Install test (ubuntu-latest)`), else the aggregate of
 * its matrix shard (`TLA+ models (shard 2/4)` -> `TLA+ models`).
 *
 * @param {string} name
 * @param {Set<string>} required
 */
function requiredContextOf(name, required) {
	if (required.has(name)) return name;
	const aggregate = shardAggregateName(name);
	return aggregate !== null && required.has(aggregate) ? aggregate : null;
}

/**
 * The p90-over-window report for ONE workflow's recent runs. Each job name is
 * its own subject (a matrix shard warns on its own, like `runtimeCapLines`), and
 * its samples are pooled over the window, so a name yields at most one warning
 * per invocation, never one per sample (#4691 acceptance 3). Only names that
 * belong to a required context are measured; a context with no measured name
 * is absent from `measuredContexts`, and the caller names it (fail visible).
 *
 * A row that did not run (skipped, unfinished, equal or inverted timestamps)
 * has no positive duration and is not a sample.
 *
 * @param {object} input
 * @param {Array<{ name: string, capMinutes: number, pattern: RegExp, file: string, jobId: string }>} input.caps
 *   cap entries of the workflow the runs belong to
 * @param {Array<{ id: number, created_at: string, jobs: Array<{ name?: string, started_at?: string | null, completed_at?: string | null }> }>} input.runs
 *   the selected runs with their job rows (gh api shape)
 * @param {Iterable<string>} [input.requiredChecks]
 * @param {number} [input.ratio]
 * @returns {{
 *   warnings: Array<{ name: string, file: string, jobId: string, context: string,
 *     p90Seconds: number, capSeconds: number, ratio: number, samples: number,
 *     window: { runs: number, from: string, to: string } }>,
 *   measuredContexts: string[],
 * }}
 */
export function p90CapReport({
	caps,
	runs,
	requiredChecks = REQUIRED_CHECKS,
	ratio = RUNTIME_CAP_WARN_RATIO,
}) {
	const required = new Set(requiredChecks);
	const byName = new Map();
	for (const run of runs) {
		for (const job of run.jobs ?? []) {
			const name = String(job?.name ?? "");
			const context = requiredContextOf(name, required);
			if (context === null) continue;
			const entry = caps.find((candidate) => candidate.pattern.test(name));
			if (!entry) continue;
			const seconds = checkRunSeconds(job);
			if (seconds === null || seconds <= 0) continue;
			const group = byName.get(name) ?? { entry, context, samples: [] };
			group.samples.push(seconds);
			byName.set(name, group);
		}
	}
	// The window is every SELECTED run, not the runs that happened to contribute
	// a sample: the label says how many runs the p90 was read over (CodeRabbit
	// thread on #4825, F5).
	const days = runs.map((run) => String(run.created_at).slice(0, 10)).sort();
	const window = {
		runs: runs.length,
		from: days[0],
		to: days[days.length - 1],
	};
	const warnings = [];
	for (const [name, { entry, context, samples }] of byName) {
		const value = p90(samples);
		const capSeconds = entry.capMinutes * 60;
		if (value / capSeconds < ratio) continue;
		warnings.push({
			name,
			file: entry.file,
			jobId: entry.jobId,
			context,
			p90Seconds: value,
			capSeconds,
			ratio,
			samples: samples.length,
			window,
		});
	}
	warnings.sort(
		(left, right) =>
			right.p90Seconds / right.capSeconds - left.p90Seconds / left.capSeconds ||
			left.name.localeCompare(right.name),
	);
	return {
		warnings,
		measuredContexts: [
			...new Set([...byName.values()].map((group) => group.context)),
		],
	};
}

/**
 * The one-line warning a workflow annotation carries: the job, the p90, the cap
 * and the window the samples came from.
 *
 * @param {ReturnType<typeof p90CapReport>["warnings"][number]} w
 */
export function formatP90Warning(w) {
	const percent = ((w.p90Seconds / w.capSeconds) * 100).toFixed(1);
	return (
		`${w.file} job \`${w.jobId}\` "${w.name}": p90 ${w.p90Seconds} s is ${percent}% ` +
		`of its ${w.capSeconds} s cap (timeout-minutes ${w.capSeconds / 60}); ` +
		`window ${w.window.runs} master runs ${w.window.from} to ${w.window.to}; ` +
		`${w.samples} samples`
	);
}
