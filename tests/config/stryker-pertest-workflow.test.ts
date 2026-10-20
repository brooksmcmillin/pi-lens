// #4365: the per-test Stryker campaign is manual, read-only and runs the
// vitest runner with perTest coverage. Each case names the regression it keeps
// out. The real YAML and config are loaded; nothing is mocked.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/stryker-pertest.yml";
// A computed specifier: the config is plain data in a root .mjs with no .d.mts.
const { default: config } = (await import(
	pathToFileURL(resolve(ROOT, "stryker.pertest.config.mjs")).href
)) as { default: Record<string, unknown> };

type Step = {
	name?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
};
type Workflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
};

const workflow = yaml.load(
	readFileSync(resolve(ROOT, WORKFLOW), "utf8"),
) as Workflow;
const job = workflow.jobs.mutate;

describe("stryker-pertest workflow (#4365)", () => {
	// Recurrence (#4005): the Stryker lane came back onto the pull_request path and
	// cost 11-18% of CI job-minutes for no product defect.
	it("is dispatch-only", () => {
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
	});

	// Recurrence (#4077): a dispatch on any ref runs branch code, so the job that
	// runs it holds no write scope; the nightly tracking issue is never written.
	it("holds read-only permissions", () => {
		expect(workflow.permissions).toEqual({});
		expect(job.permissions).toEqual({ contents: "read" });
	});

	// Recurrence (spike 2026-10-14): the runner joined test names with a space,
	// vitest 5 matches " > ", and an unpatched run reported 16 of 16 mutants
	// surviving with no test run. The patch must precede the Stryker step.
	it("patches the runner before it runs Stryker", () => {
		const at = (needle: string) =>
			job.steps.findIndex((step) => step.run?.includes(needle));
		expect(at("stryker-pertest.mjs patch-runner")).toBeGreaterThan(-1);
		expect(at("stryker-pertest.mjs patch-runner")).toBeLessThan(
			at("stryker run stryker.pertest.config.mjs"),
		);
	});
});

describe("stryker.pertest.config.mjs (#4365)", () => {
	// Recurrence: the diff lane's config (command runner, coverage "off") cannot
	// say which test killed a mutant, which is the point of this campaign.
	it("uses the vitest runner with perTest coverage and no command runner", () => {
		expect(config.testRunner).toBe("vitest");
		expect(config.coverageAnalysis).toBe("perTest");
		expect("commandRunner" in config).toBe(false);
	});

	// Recurrence (spike 2026-10-14, clients/json-cache-read.js): with the runner's
	// default bail, `killedBy` names only the first failing test, so 23 tests that
	// do kill mutants were listed as killing none.
	it("runs every covered test per mutant", () => {
		expect(config.disableBail).toBe(true);
	});

	// Recurrence: a post-instrument `npm run build` overwrites the mutated `.js`
	// twin before any test runs (scripts/lib/mutation-touch-build.mjs header).
	it("does not rebuild after instrumenting", () => {
		expect(config.buildCommand).toBe(
			"node scripts/lib/mutation-touch-build.mjs",
		);
	});
});

describe("stryker-pertest workflow pre-flight (#4365)", () => {
	// Recurrence (pilot, clients/spawn-timeout-cooldown.js): one test calling
	// process.chdir() under the runner's threads pool aborted the dry run and the
	// job wrote no report. The pre-flight must run before Stryker and feed it.
	it("feeds Stryker the pre-flight's kept tests", () => {
		const pre = job.steps.findIndex((step) =>
			step.run?.includes("stryker-pertest.mjs preflight"),
		);
		const mutate = job.steps.findIndex((step) =>
			step.run?.includes("stryker run stryker.pertest.config.mjs"),
		);
		expect(pre).toBeGreaterThan(-1);
		expect(pre).toBeLessThan(mutate);
		expect(job.steps[mutate].env?.PILENS_MUTATION_TESTS).toBe(
			"${{ steps.preflight.outputs.tests }}",
		);
	});
});

describe("stryker-pertest workflow rotation (#4365)", () => {
	// Recurrence: a rotation step that is skipped or ordered after the plan step
	// leaves an unnamed dispatch with no module to mutate.
	it("chooses the module before it plans the run", () => {
		const at = (needle: string) =>
			job.steps.findIndex((step) => step.run?.includes(needle));
		expect(at("stryker-pertest.mjs pick --index")).toBeGreaterThan(-1);
		expect(at("stryker-pertest.mjs pick --index")).toBeLessThan(
			at("stryker-pertest.mjs plan --module"),
		);
	});
});

describe("stryker-pertest workflow pipes (#4365)", () => {
	// Recurrence (PR #4372 review, F1): the plan step piped `plan` into `tee`
	// without pipefail, so a throwing plan exited 0 and the failure surfaced only
	// in a later step. Every step that pipes sets pipefail.
	it("sets pipefail in every step that pipes a command", () => {
		const piping = job.steps.filter((step) =>
			/(?<!\|)\|(?!\|)/.test(step.run ?? ""),
		);
		expect(piping.length).toBeGreaterThan(0);
		for (const step of piping) {
			expect(step.run, step.name).toMatch(/set -[a-z]*o pipefail/);
		}
	});
});

describe("stryker-pertest workflow facade inputs (#4449)", () => {
	// Recurrence: clients/lsp/client-registry.ts (1,760 lines) is imported only
	// by the service. Without a tests input the plan refuses it, and without a
	// lines input one run exceeds the 90-minute job cap. Both flow through env
	// (never interpolated into the script) so a dispatch input is not shell text.
	it("passes the tests and lines inputs through env into plan and mutate", () => {
		const plan = job.steps.find((step) =>
			step.run?.includes("stryker-pertest.mjs plan --module"),
		);
		const mutate = job.steps.find((step) =>
			step.run?.includes("stryker run stryker.pertest.config.mjs"),
		);
		expect(plan?.env?.ALSO_TESTS).toBe("${{ inputs.tests }}");
		expect(plan?.run).toContain('--also "$ALSO_TESTS"');
		expect(mutate?.env?.LINES).toBe("${{ inputs.lines }}");
		expect(mutate?.run).toContain('--mutate "${TARGET}${LINES:+:$LINES}"');
		expect(plan?.run).not.toContain("${{");
		expect(mutate?.run).not.toContain("${{");
	});
});

describe("stryker-pertest workflow step conditions (#4518)", () => {
	// Recurrence (#4518 review r1 F4): a step `if:` that names no status-check
	// function gets GitHub's default `success()`. The candidates step above can
	// fail on a missing report, and before `!cancelled()` that skipped this step,
	// so the run lost the one line naming the Stryker failure. The condition is
	// GitHub's expression language, not shell, so it is pinned here; the exit
	// codes the candidates step returns are executed in
	// tests/scripts/floor-steps-executed.test.ts.
	it("keeps the Stryker-failure line when an earlier step also failed", () => {
		const fail = job.steps.find(
			(step) => step.name === "Fail the job when Stryker failed",
		);
		expect(fail?.if).toContain("!cancelled()");
		expect(fail?.if).toContain("steps.stryker.outcome == 'failure'");
	});
});
