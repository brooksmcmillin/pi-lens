// #4405: the repo-wide shuffle census is a nightly, exploratory job (six
// census parts, one confirm-and-report job, one guarded issue writer), not a
// PR check. The real YAML is loaded and judged by one shape function; each
// MUTATION case below plants one regression into the real text and expects the
// function to name it. Modeled on stryker-nightly-workflow.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const FILE = ".github/workflows/shuffle-census-nightly.yml";
const source = readFileSync(resolve(ROOT, FILE), "utf8");

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
type Job = {
	if?: unknown;
	needs?: unknown;
	permissions?: Record<string, string>;
	steps?: Step[];
	env?: Record<string, string>;
	strategy?: { "fail-fast"?: boolean; matrix?: { part?: number[] } };
	"timeout-minutes"?: number;
};
type Workflow = {
	on?: { schedule?: Array<{ cron?: string }> } & Record<string, unknown>;
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	env?: Record<string, string>;
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

const load = (text: string) => yaml.load(text) as Workflow;
const WRITE_GUARD =
	"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";
const WEEKLY = "0 5 * * 0";
const DAILY = "30 4 * * 1-6";
const run = (step: Step) => step.run ?? "";

/** Every way the workflow can stop being the #4405 nightly shape. */
function findings(text: string): string[] {
	const out: string[] = [];
	const workflow = load(text);
	const triggers = Object.keys(workflow.on ?? {});
	// Recurrence: a census is about 1.5 runner-hours; on a PR trigger it would
	// queue behind and double every code PR. G3 (#4423 verify r2): a
	// `workflow_run` trigger runs at refs/heads/master, so the writer's guard
	// would pass for a run another workflow started. Exactly two triggers.
	for (const extra of triggers.filter(
		(name) => name !== "schedule" && name !== "workflow_dispatch",
	))
		out.push(`trigger: ${extra}`);
	const crons = (workflow.on?.schedule ?? []).map((entry) => entry.cron);
	if (crons.length !== 2 || !crons.includes(WEEKLY))
		out.push(`schedule is not a daily plus the weekly ${WEEKLY}`);
	// Recurrence (F-B, #4423 verify r3): a daily `30 4 * * *` also fires on
	// Sunday, so the 04:30 run's stale marker made the 05:00 run red on the
	// same night (the two-night rule counted one night twice).
	if (!crons.includes(DAILY))
		out.push(
			`the daily cron is not ${DAILY} (it must skip the weekly's Sunday)`,
		);
	if (!triggers.includes("workflow_dispatch")) out.push("no workflow_dispatch");
	if (JSON.stringify(workflow.permissions) !== "{}")
		out.push("workflow-level permissions are not {}");
	if (
		workflow.concurrency?.group !== "shuffle-census-nightly" ||
		workflow.concurrency?.["cancel-in-progress"] !== false
	)
		out.push("concurrency is not the non-cancelling shuffle-census-nightly");

	const census = workflow.jobs?.census ?? ({} as Job);
	const report = workflow.jobs?.["confirm-report"] ?? ({} as Job);
	const writer = workflow.jobs?.["publish-issue"] ?? ({} as Job);
	if (Object.keys(workflow.jobs ?? {}).length !== 3)
		out.push("jobs are not census, confirm-report and publish-issue");

	// Recurrence: #4077, a write scope on a job a branch dispatch runs. Only
	// the writer holds `issues: write`; the report job only lists the issue.
	for (const [name, job, expected] of [
		["census", census, { contents: "read" }],
		["confirm-report", report, { contents: "read", issues: "read" }],
		["publish-issue", writer, { contents: "read", issues: "write" }],
	] as const)
		if (
			JSON.stringify(Object.entries(job.permissions ?? {}).sort()) !==
			JSON.stringify(Object.entries(expected).sort())
		)
			out.push(`job permissions ${name} are not ${JSON.stringify(expected)}`);
	for (const [name, job] of [
		["census", census],
		["confirm-report", report],
	] as const)
		if (/github\.ref|event_name/.test(String(job.if ?? "")))
			out.push(`read-only job ${name} is scoped away from branch dispatch`);

	// Recurrence: the part count has two homes (the matrix and `--part k/N`);
	// a part list longer than N runs the same starts twice, a shorter one drops
	// starts, and the census would report a clean tree it never ran.
	const parts = census.strategy?.matrix?.part ?? [];
	const censusSteps = census.steps ?? [];
	const censusRun = censusSteps.find((step) =>
		run(step).includes("scripts/ci-shuffle-census.mjs"),
	);
	const partFlag = /--part "\$\{\{ matrix\.part \}\}\/(\d+)"/.exec(
		run(censusRun ?? {}),
	);
	if (
		parts.length === 0 ||
		parts.some((part, index) => part !== index) ||
		Number(partFlag?.[1]) !== parts.length
	)
		out.push("the matrix parts are not 0..N-1 for --part k/N");
	if (census.strategy?.["fail-fast"] !== false)
		out.push("a failed part would cancel the other parts");
	// Recurrence: a budget at or above the job timeout lets GitHub kill the
	// job with the records still on the runner and nothing uploaded.
	const budget = Number(/--budget-ms (\d+)/.exec(run(censusRun ?? {}))?.[1]);
	if (!(budget > 0) || budget > ((census["timeout-minutes"] ?? 0) - 5) * 60_000)
		out.push("the census budget leaves under 5 minutes below the timeout");

	// Recurrence: the weekly alone pass is chosen by comparing the schedule
	// string; retiming the cron without the comparison would never run it.
	if (
		!String(workflow.env?.WITH_ALONE ?? "").includes(
			`github.event.schedule == '${WEEKLY}'`,
		)
	)
		out.push("the alone pass is not tied to the weekly cron");
	// Recurrence (N1, #4423 verify r2): the report plans the census again to
	// find the starts with no record. Planned from other flags than the parts',
	// it misses the alone starts a weekly part skipped, or reds every night. One
	// home: the workflow env, never a job's own copy, and seeds from the script.
	for (const [name, job] of [
		["census", census],
		["confirm-report", report],
	] as const)
		for (const key of ["WITH_ALONE", "CENSUS_FILES"])
			if (job.env?.[key] !== undefined)
				out.push(`job ${name} redefines ${key}: the plan has two homes`);
	if (
		/--seeds/.test(
			Object.values(workflow.jobs ?? {})
				.flatMap((job) => (job.steps ?? []).map(run))
				.join("\n"),
		)
	)
		out.push("a job passes --seeds: the seeds have one home, the script");
	if (
		!/if \[ "\$WITH_ALONE" != "true" \]; then\n\s*ARGS\+=\(--no-alone\)/.test(
			run(censusRun ?? {}),
		)
	)
		out.push("the daily run does not skip the alone starts");
	// Recurrence: confirming inside a part judges a member the other parts
	// have not been merged with.
	if (/--confirm|--report/.test(run(censusRun ?? {})))
		out.push("a census part confirms or reports");

	// Recurrence: `npm ci --ignore-scripts` skips `prepare` (core grammars),
	// and the LSP fixture tests import dist/; both jobs that start vitest need
	// both before the first start.
	for (const [name, job, marker] of [
		["census", census, "scripts/ci-shuffle-census.mjs"],
		["confirm-report", report, "--confirm"],
	] as const) {
		const steps = job.steps ?? [];
		const first = steps.findIndex((step) => run(step).includes(marker));
		const missingOrLater = (needle: RegExp) => {
			const index = steps.findIndex((step) => needle.test(run(step)));
			return index < 0 || index > first;
		};
		if (
			first < 0 ||
			missingOrLater(/download-grammars\.js --core --dest grammars/) ||
			missingOrLater(/^npm run build$/m) ||
			missingOrLater(/^npm run build:dist$/m)
		)
			out.push(
				`${name} does not build grammars, build and dist before it runs`,
			);
	}

	// Recurrence (rehearsal run 38608471496): a bare `node scripts/...` has no
	// node_modules/.bin on PATH (only `npm run` adds it), so the ast-grep and
	// formatter tests, which look their CLI up on PATH and red under CI=true,
	// reported seven files as failing alone that pass in ci.yml's Unit job.
	for (const [name, step] of [
		["census", censusRun],
		[
			"confirm-report",
			(report.steps ?? []).find((s2) => run(s2).includes("--confirm")),
		],
	] as const)
		if (
			!/export PATH="\$GITHUB_WORKSPACE\/node_modules\/\.bin:\$PATH"/.test(
				run(step ?? {}),
			)
		)
			out.push(`${name} does not put node_modules/.bin on PATH`);

	// The report job: merges all six artifacts, confirms twice, reports.
	if (report.needs !== "census" || !/always\(\)/.test(String(report.if ?? "")))
		out.push("confirm-report does not run after every census part");
	const download = (report.steps ?? []).find((step) =>
		step.uses?.startsWith("actions/download-artifact@"),
	);
	if (
		download?.with?.pattern !== "census-*" ||
		download?.with?.["merge-multiple"] !== true
	)
		out.push("confirm-report does not merge every census-* artifact");
	const confirm = (report.steps ?? []).find((step) =>
		run(step).includes("--confirm"),
	);
	// Recurrence (F3, #4423 review r1): the second confirm pass is the one that
	// plans the chunk reruns; a single pass leaves "chunk not rerun yet".
	if (!/for _pass in 1 2; do/.test(run(confirm ?? {})))
		out.push("the confirm pass does not run twice");
	// Recurrence (N2, #4423 verify r2): two 30 min passes outlived the 45 min
	// job, which then died before its report step, and the writer failed on the
	// missing artifact. Each pass stops at 15 min, both leave 10 for the rest.
	const confirmBudget = Number(
		/--budget-ms (\d+)/.exec(run(confirm ?? {}))?.[1],
	);
	if (
		!(confirmBudget > 0) ||
		confirmBudget > 15 * 60_000 ||
		2 * confirmBudget > ((report["timeout-minutes"] ?? 0) - 10) * 60_000
	)
		out.push("a confirm pass may run past 15 minutes or the job timeout");
	const reportStep = (report.steps ?? []).find((step) => step.id === "report");
	const reportRun = run(reportStep ?? {});
	// Recurrence (F-A, #4423 verify r3): without `author` in the listed fields
	// every issue fails the author filter, and the two-night rule never fires.
	const listed =
		/gh issue list [^\n]*--json ([\w,]+)/.exec(reportRun)?.[1] ?? "";
	if (!listed.split(",").includes("author"))
		out.push("the report lists the issues without their author");
	// The rehearsal surface: a branch dispatch skips the writer, so the body
	// is rendered on the run page instead.
	if (
		!reportRun.includes(
			'cat "$RUNNER_TEMP/census-report/body.md" >> "$GITHUB_STEP_SUMMARY"',
		)
	)
		out.push("the report does not render the issue body in the step summary");
	// Recurrence (N1, #4423 verify r2): an empty record dir reported "clean"
	// and closed the issue. The report plans with the parts' flags and reads
	// the census job's result.
	if (
		!/if \[ "\$WITH_ALONE" != "true" \]; then\n\s*ARGS\+=\(--no-alone\)/.test(
			reportRun,
		) ||
		!reportRun.includes('ARGS+=(--files "$CENSUS_FILES")') ||
		!run(censusRun ?? {}).includes('ARGS+=(--files "$CENSUS_FILES")') ||
		!/"\$\{ARGS\[@\]\}" --report/.test(reportRun)
	)
		out.push("the report does not plan with the census parts' flags");
	if (
		reportStep?.env?.CENSUS_RESULT !== "${{ needs.census.result }}" ||
		!reportRun.includes('--census-result "$CENSUS_RESULT"')
	)
		out.push("the report does not read the census job's result");
	if (
		!/--report --previous-issues "\$RUNNER_TEMP\/census-issues\.json" --title "\$TRACKING_TITLE"/.test(
			reportRun,
		) ||
		!reportRun.includes("--stale-out") ||
		!reportRun.includes("--body-out")
	)
		out.push("the report does not read last night's issue or write the body");
	// Recurrence: a red exit the job swallows; 1 and 3 must red, 4 must not.
	const failStep = (report.steps ?? []).find((step) =>
		String(step.if ?? "").includes("steps.report.outputs.rc"),
	);
	if (
		!failStep ||
		!String(failStep.if).includes("steps.report.outputs.rc != '0'") ||
		!String(failStep.if).includes("steps.report.outputs.rc != '4'")
	)
		out.push("the job does not red on exit 1 or 3 only");

	// Recurrence: #4077/#4053, the issue edit is its own guarded job, fed by
	// the report job's artifact, through the shared upsert CLI.
	const upload = (report.steps ?? []).find(
		(step) =>
			step.uses?.startsWith("actions/upload-artifact@") &&
			step.with?.name === "census-report",
	);
	const taken = (writer.steps ?? []).find((step) =>
		step.uses?.startsWith("actions/download-artifact@"),
	);
	if (
		writer.needs !== "confirm-report" ||
		!upload ||
		taken?.with?.name !== "census-report"
	)
		out.push("the issue writer does not take the report job's artifact");
	if (!String(writer.if ?? "").includes(WRITE_GUARD))
		out.push("the issue writer is not scoped to schedule or master");
	// Recurrence (F-C, #4423 verify r3): a `files` subset dispatched on master
	// that exits 0 would run `--clean --close-when-clean` on the real issue.
	if (!String(writer.if ?? "").includes("inputs.files == ''"))
		out.push("the issue writer runs for a files subset dispatch");
	const upserts = (writer.steps ?? []).map(run).join("\n");
	if (
		!/upsert-tracking-issue\.mjs --title "\$TRACKING_TITLE" --label nightly-drift --body-file/.test(
			upserts,
		) ||
		!/--clean --close-when-clean/.test(upserts)
	)
		out.push("no title-keyed upsert and close on the nightly-drift label");
	const all = [
		...(census.steps ?? []),
		...(report.steps ?? []),
		...(writer.steps ?? []),
	];
	if (/gh issue (create|edit|comment|close)/.test(all.map(run).join("\n")))
		out.push("a raw gh issue write bypasses the shared upsert CLI");

	// Recurrence (G1, #4423 verify r2): a dispatch input inlined into a script
	// is shell text from whoever dispatches; it reaches the shell only as env.
	for (const step of all)
		if (/\$\{\{\s*(github\.event\.)?inputs\./.test(run(step)))
			out.push(
				`a run script inlines a dispatch input: ${step.name ?? run(step).slice(0, 40)}`,
			);
	// Recurrence (stryker run 37599048379): an action input is not a shell
	// string; `$RUNNER_TEMP` there is a literal directory.
	for (const step of all)
		for (const [key, value] of Object.entries(step.with ?? {}))
			if (/\$[A-Za-z_{]/.test(String(value).replace(/\$\{\{[^}]*\}\}/g, "")))
				out.push(`action input ${key} names a shell variable: ${value}`);
	// Recurrence: a re-run attempt must replace its part's artifact.
	if (
		all.some(
			(step) =>
				step.uses?.startsWith("actions/upload-artifact@") &&
				step.with?.overwrite !== true,
		)
	)
		out.push("an artifact upload cannot be replaced by a re-run (overwrite)");
	return out;
}

describe("shuffle-census-nightly.yml (#4405)", () => {
	it("has exactly the nightly census shape", () => {
		expect(findings(source)).toEqual([]);
	});

	const mutations: Array<[string, (text: string) => string, RegExp]> = [
		[
			"listing the issues without their author (F-A)",
			(text) => text.replace("--json title,body,author", "--json title,body"),
			/without their author/,
		],
		[
			"a daily cron that also fires on Sunday (F-B)",
			(text) => text.replace('cron: "30 4 * * 1-6"', 'cron: "30 4 * * *"'),
			/daily cron is not/,
		],
		[
			"the writer running for a files subset (F-C)",
			(text) => text.replace(" && inputs.files == ''", ""),
			/files subset dispatch/,
		],
		[
			"no issue body in the step summary",
			(text) =>
				text.replace(
					'cat "$RUNNER_TEMP/census-report/body.md" >> "$GITHUB_STEP_SUMMARY"',
					"true",
				),
			/step summary/,
		],
		[
			"adding a workflow_run trigger (G3)",
			(text) =>
				text.replace(
					"on:\n",
					'on:\n  workflow_run:\n    workflows: ["CI"]\n    types: [completed]\n',
				),
			/trigger: workflow_run/,
		],
		[
			"inlining the files input into the census script (G1)",
			(text) =>
				text.replace(
					'          if [ -n "$CENSUS_FILES" ]; then\n            ARGS+=(--files "$CENSUS_FILES")\n          fi\n          node scripts/ci-shuffle-census.mjs "${ARGS[@]}"\n',
					'          ARGS+=(--files "${{ inputs.files }}")\n          node scripts/ci-shuffle-census.mjs "${ARGS[@]}"\n',
				),
			/inlines a dispatch input/,
		],
		[
			"a confirm pass back at 30 minutes (N2)",
			(text) => text.replace("--budget-ms 900000", "--budget-ms 1800000"),
			/confirm pass may run past 15 minutes/,
		],
		[
			"the report planning without the alone flag (N1)",
			(text) =>
				text.replace(
					'ARGS=(--out "$RUNNER_TEMP/census" --census-result "$CENSUS_RESULT")\n          if [ "$WITH_ALONE" != "true" ]; then\n            ARGS+=(--no-alone)\n          fi\n',
					'ARGS=(--out "$RUNNER_TEMP/census" --census-result "$CENSUS_RESULT")\n',
				),
			/plan with the census parts' flags/,
		],
		[
			"the report ignoring the census job's result (N1)",
			(text) =>
				text.replace(
					"          CENSUS_RESULT: ${{ needs.census.result }}\n",
					"          CENSUS_RESULT: success\n",
				),
			/census job's result/,
		],
		[
			"a census job with its own copy of WITH_ALONE (N1)",
			(text) =>
				text.replace(
					'      PI_LENS_TEST_TIMEOUT_SCALE: "3"\n    steps:\n',
					'      PI_LENS_TEST_TIMEOUT_SCALE: "3"\n      WITH_ALONE: "true"\n    steps:\n',
				),
			/job census redefines WITH_ALONE/,
		],
		[
			"a census part passing its own seed list",
			(text) =>
				text.replace(
					"--budget-ms 4200000)",
					'--budget-ms 4200000 --seeds "202,424,606")',
				),
			/passes --seeds/,
		],
		[
			"adding a pull_request trigger",
			(text) =>
				text.replace("on:\n", "on:\n  pull_request:\n    branches: [master]\n"),
			/trigger: pull_request/,
		],
		[
			"adding a push trigger",
			(text) => text.replace("on:\n", "on:\n  push:\n    branches: [master]\n"),
			/trigger: push/,
		],
		[
			"dropping the weekly cron",
			(text) => text.replace(/    - cron: "0 5 \* \* 0"[^\n]*\n/, ""),
			/schedule is not a daily plus the weekly/,
		],
		[
			"retiming the weekly cron without the alone comparison",
			(text) => text.replace('- cron: "0 5 * * 0"', '- cron: "0 6 * * 0"'),
			/schedule is not a daily plus the weekly/,
		],
		[
			"widening the writer's permissions",
			(text) =>
				text.replace(
					"      contents: read\n      issues: write\n",
					"      contents: write\n      issues: write\n",
				),
			/job permissions publish-issue/,
		],
		[
			"giving the report job issues: write",
			(text) => text.replace("      issues: read\n", "      issues: write\n"),
			/job permissions confirm-report/,
		],
		[
			"a matrix part past the --part N",
			(text) =>
				text.replace("part: [0, 1, 2, 3, 4, 5]", "part: [0, 1, 2, 3, 4, 5, 6]"),
			/matrix parts/,
		],
		[
			"--part N shrunk under the matrix",
			(text) => text.replace('}}/6"', '}}/5"'),
			/matrix parts/,
		],
		[
			"a budget at the job timeout",
			(text) => text.replace("--budget-ms 4200000", "--budget-ms 4800000"),
			/census budget/,
		],
		[
			"letting one failed part cancel the rest",
			(text) => text.replace("fail-fast: false", "fail-fast: true"),
			/cancel the other parts/,
		],
		[
			"running the alone starts every night",
			(text) => text.replace("ARGS+=(--no-alone)", "true"),
			/skip the alone starts/,
		],
		[
			"confirming inside a census part",
			(text) =>
				text.replace("--budget-ms 4200000)", "--confirm --budget-ms 4200000)"),
			/confirms or reports/,
		],
		[
			"dropping the dist build from the census job",
			(text) =>
				text.replace(
					"      - run: npm run build:dist\n      - name: Run this part",
					"      - name: Run this part",
				),
			/census does not build/,
		],
		[
			"dropping node_modules/.bin from the census PATH",
			(text) =>
				text.replace(
					'          export PATH="$GITHUB_WORKSPACE/node_modules/.bin:$PATH"\n          ARGS=',
					"          ARGS=",
				),
			/census does not put node_modules\/\.bin on PATH/,
		],
		[
			"dropping node_modules/.bin from the confirm PATH",
			(text) =>
				text.replace(
					'          export PATH="$GITHUB_WORKSPACE/node_modules/.bin:$PATH"\n          for _pass',
					"          for _pass",
				),
			/confirm-report does not put node_modules\/\.bin on PATH/,
		],
		[
			"a single confirm pass",
			(text) => text.replace("for _pass in 1 2; do", "for pass in 1; do"),
			/confirm pass does not run twice/,
		],
		[
			"not merging the six artifacts",
			(text) => text.replace("merge-multiple: true", "merge-multiple: false"),
			/merge every census-\* artifact/,
		],
		[
			"the report job losing always()",
			(text) => text.replace("    if: always()\n    runs-on", "    runs-on"),
			/after every census part/,
		],
		[
			"failing the job on the stale-only exit 4",
			(text) => text.replace(" && steps.report.outputs.rc != '4'", ""),
			/exit 1 or 3 only/,
		],
		[
			"the report ignoring last night's issue",
			(text) =>
				text.replace(
					' --previous-issues "$RUNNER_TEMP/census-issues.json"',
					"",
				),
			/last night's issue/,
		],
		[
			"the writer running on a branch dispatch",
			(text) =>
				text.replace(
					"github.event_name == 'schedule' || github.ref == 'refs/heads/master'",
					"true",
				),
			/scoped to schedule or master/,
		],
		[
			"a raw gh issue write",
			(text) =>
				text.replace(
					"gh label create nightly-drift",
					"gh issue create --title x\n          gh label create nightly-drift",
				),
			/raw gh issue write/,
		],
		[
			"a shell variable in an action input",
			(text) =>
				text.replace(
					"path: ${{ runner.temp }}/census\n",
					"path: $RUNNER_TEMP/census\n",
				),
			/names a shell variable/,
		],
		[
			"an upload without overwrite",
			(text) => text.replace("          overwrite: true\n", ""),
			/cannot be replaced by a re-run/,
		],
	];
	for (const [name, mutate, expected] of mutations) {
		it(`names the regression: ${name}`, () => {
			const mutated = mutate(source);
			expect(mutated, "the mutation found nothing to plant").not.toBe(source);
			expect(findings(mutated).join("\n")).toMatch(expected);
		});
	}
});
