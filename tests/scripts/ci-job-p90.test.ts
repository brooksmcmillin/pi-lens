import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { escapeRegExp } from "../../clients/string-utils.js";
import {
	formatP90Warning,
	jobCapEntries,
	p90,
	p90CapReport,
	RUNTIME_CAP_WARN_RATIO,
	runtimeCapLines,
} from "../../scripts/lib/ci-runtime-cap.mjs";

// #4691 (item 3 of #3920): nothing compared a required CI job's measured
// runtime with its `timeout-minutes`. The TLA+ cap (720 s) was found only when
// PRs timed out (623-881 s, #3918). These tests drive the shared rule's p90 mode
// (scripts/lib/ci-runtime-cap.mjs, the module ci-verdict's per-head report also
// uses) on a recorded master-run fixture; the gh fetch is the only host boundary
// and lives in scripts/check-ci-job-p90.mjs.

const ROOT = resolve(import.meta.dirname, "..", "..");
const caps = ["ci.yml", "lint.yml"].flatMap((file) =>
	jobCapEntries(
		yaml.load(readFileSync(resolve(ROOT, ".github/workflows", file), "utf8")),
		`.github/workflows/${file}`,
		escapeRegExp,
	),
);
const fixture = JSON.parse(
	readFileSync(
		resolve(ROOT, "tests/fixtures/ci-job-p90/master-runs.json"),
		"utf8",
	),
) as {
	runs: Parameters<typeof p90CapReport>[0]["runs"];
	required: string[];
};
const REQUIRED = fixture.required;

function withDuration(
	runs: typeof fixture.runs,
	jobName: string,
	seconds: number,
) {
	return runs.map((run) => ({
		...run,
		jobs: run.jobs.map((job) =>
			job.name === jobName
				? {
						...job,
						completed_at: new Date(
							Date.parse(job.started_at as string) + seconds * 1000,
						)
							.toISOString()
							.replace(".000Z", "Z"),
					}
				: job,
		),
	}));
}

const report = (runs = fixture.runs, requiredChecks: string[] = REQUIRED) =>
	p90CapReport({ caps, runs, requiredChecks });

describe("required CI job p90 against timeout-minutes (#4691)", () => {
	// Recurrence: #3918 (TLA+ shards timed out at 623-881 s against a 720 s cap).
	it("warns on jobs at or over 70% of their cap and stays silent below it", () => {
		const names = report().warnings.map((w) => w.name);
		expect(names).toEqual([
			"Unit tests Windows", // 1500 s of 1500 s
			"TLA+ models (shard 2/4)", // 1000 s of 1200 s
			"Lint & type-check", // 450 s of 600 s
		]);
		// Unit tests shards run at 1080 s of 1800 s (60%), Install tests far below.
		expect(names.some((n) => n.startsWith("Unit tests ("))).toBe(false);
	});

	it("names the job, p90, cap and run window in the warning line", () => {
		const lint = report().warnings.find((w) => w.name === "Lint & type-check");
		expect(lint).toMatchObject({
			p90Seconds: 450,
			capSeconds: 600,
			samples: 5,
			window: { runs: 5, from: "2026-10-18", to: "2026-10-22" },
		});
		const line = formatP90Warning(lint as NonNullable<typeof lint>);
		expect(line).toContain('"Lint & type-check"');
		expect(line).toContain("p90 450 s is 75.0% of its 600 s cap");
		expect(line).toContain("timeout-minutes 10");
		expect(line).toContain("window 5 master runs 2026-10-18 to 2026-10-22");
		expect(line).toContain("5 samples");
	});

	// Recurrence: CodeRabbit thread on #4825. `from`/`to` came only from runs that
	// contributed a sample, so "20 master runs 2026-10-18 to 2026-10-20" described
	// three runs.
	it("labels the window from every selected run, and keeps the sample count separate", () => {
		const runs = Array.from({ length: 20 }, (_, i) => ({
			id: i,
			created_at: `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
			jobs:
				i >= 17
					? [
							{
								name: "Lint & type-check",
								started_at: "2026-10-18T10:00:00Z",
								completed_at: "2026-10-18T10:07:30Z",
							},
						]
					: [],
		}));
		const [w] = report(runs).warnings;
		expect(w.window).toEqual({
			runs: 20,
			from: "2026-10-01",
			to: "2026-10-20",
		});
		expect(w.samples).toBe(3);
	});

	it("emits one record per job name per invocation, never one per sample", () => {
		// Recurrence: #4691 acceptance 3. Each shard has 5 samples (one per run);
		// pushing them all over the cap still gives one record per shard.
		const runs = withDuration(
			withDuration(fixture.runs, "Unit tests (shard 1/2)", 1350),
			"Unit tests (shard 2/2)",
			1350,
		);
		const shards = report(runs).warnings.filter((w) =>
			w.name.startsWith("Unit tests ("),
		);
		expect(shards.map((w) => [w.name, w.samples])).toEqual([
			["Unit tests (shard 1/2)", 5],
			["Unit tests (shard 2/2)", 5],
		]);
	});

	// Recurrence: the first cut measured the constant fallback list (2 of the 9
	// branch-protection contexts), so TLA+ models, Unit tests Windows, Install
	// test x3, knip and oxfmt were silent (#4691 F2).
	it("measures the passed required set from the real workflows, not a constant list", () => {
		const measured = report().measuredContexts;
		expect(measured).toEqual(
			expect.arrayContaining([
				"Unit tests Windows",
				"TLA+ models",
				"Install test (ubuntu-latest)",
				"Install test (windows-latest)",
				"Lint & type-check",
				"Unit tests",
			]),
		);
		// No row for macOS in the recording: absent from the measured set, so the
		// caller names it.
		expect(measured).not.toContain("Install test (macos-latest)");
		// A job outside the passed required set is not measured: Unit tests
		// Windows sits at 1500 s of 1500 s and stays silent when not required.
		const narrow = report(fixture.runs, ["Lint & type-check", "Unit tests"]);
		expect(narrow.warnings.map((w) => w.name)).toEqual(["Lint & type-check"]);
		expect(narrow.measuredContexts).not.toContain("Unit tests Windows");
	});

	it("does not measure a required context whose only rows did not run, or whose job has no cap", () => {
		const skipped = [
			{
				id: 1,
				created_at: "2026-10-18T10:00:00Z",
				jobs: [
					// Real skipped rows carry equal or inverted timestamps.
					{
						name: "Lint & type-check",
						started_at: "2026-10-18T10:00:50Z",
						completed_at: "2026-10-18T10:00:43Z",
					},
					{
						name: "knip",
						started_at: "2026-10-18T10:00:00Z",
						completed_at: "2026-10-18T10:00:00Z",
					},
					{ name: "oxfmt format check", started_at: null, completed_at: null },
					// Required by branch protection but declared in no workflow's caps.
					{
						name: "Unknown required job",
						started_at: "2026-10-18T10:00:00Z",
						completed_at: "2026-10-18T10:20:00Z",
					},
				],
			},
		];
		const result = report(skipped, [
			"Lint & type-check",
			"knip",
			"oxfmt format check",
			"Unknown required job",
		]);
		expect(result.warnings).toEqual([]);
		expect(result.measuredContexts).toEqual([]);
	});

	it("uses the ratio ci-verdict's per-head report uses, at the boundary", () => {
		expect(RUNTIME_CAP_WARN_RATIO).toBe(0.7);
		// lint cap is 600 s: 420 s is exactly 70% (warns, like runtimeCapLines),
		// 419 s is under it.
		const at = (s: number) =>
			report(withDuration(fixture.runs, "Lint & type-check", s)).warnings.map(
				(w) => w.name,
			);
		expect(at(419)).not.toContain("Lint & type-check");
		expect(at(420)).toContain("Lint & type-check");
		// The per-head report is the other reader of the one comparator: the same
		// 420 s run prints there too, and 419 s does not.
		const perHead = (s: number) =>
			runtimeCapLines({
				caps,
				checkRuns: [
					{
						name: "Lint & type-check",
						started_at: "2026-10-18T10:00:00Z",
						completed_at: new Date(
							Date.parse("2026-10-18T10:00:00Z") + s * 1000,
						)
							.toISOString()
							.replace(".000Z", "Z"),
					},
				],
			}).join("\n");
		expect(perHead(419)).toContain("no job is at 70%");
		expect(perHead(420)).toContain("Lint & type-check 420s of 600s (70%)");
	});

	it("nearest-rank p90", () => {
		expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
		expect(p90([5])).toBe(5);
		expect(p90([])).toBeUndefined();
	});
});

// Recurrence: #4825 F3. The p90 steps sat after `Detect untriaged issues`, which
// exits 1 whenever an issue is untriaged (8 of the last 10 scheduled runs), and
// GitHub skips every step after a failed one: the nightly was silent on the days
// it ran. The detector now runs last, under `!cancelled()` so a p90 step that
// fails cannot skip it either.
//
// #4989 r3 (run 40690133466, job 122822528606): a GitHub 502 from the `gh api`
// read inside scripts/check-ci-job-p90.mjs exited 1 and, with no
// `continue-on-error`, redded Daily repo health for a step its own comment
// called advisory. The p90 step is continue-on-error now; the warning it emits
// is still read from the run log's annotations, and the DETECTOR below it stays
// able to red the job, which is the whole point of the ordering above.
describe("untriaged-issues.yml step order (#4691)", () => {
	const workflow = yaml.load(
		readFileSync(
			resolve(ROOT, ".github/workflows/untriaged-issues.yml"),
			"utf8",
		),
	) as {
		jobs: Record<
			string,
			{
				steps: Array<{
					name?: string;
					run?: string;
					if?: string;
					"continue-on-error"?: boolean;
				}>;
			}
		>;
	};
	const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
	const indexOfRun = (needle: string) =>
		steps.findIndex((step) => step.run?.includes(needle));

	it("runs the p90 check before the detector, and the detector survives a p90 failure", () => {
		const p90Step = indexOfRun("scripts/check-ci-job-p90.mjs");
		const detector = indexOfRun("scripts/detect-untriaged-issues.mjs");
		expect(p90Step).toBeGreaterThan(-1);
		expect(detector).toBeGreaterThan(p90Step);
		expect(steps[detector].if).toBe("${{ !cancelled() }}");
		expect(steps[detector]["continue-on-error"]).toBeUndefined();
		expect(steps[p90Step]["continue-on-error"]).toBe(true);
	});
});
