// Pins the #2706 advisory tools, now steps of the one `Lint (advisory)` job
// (#5002), to their workflow-level contracts. The real YAML is loaded so
// deleting a tool step, its guard, its advisory tolerance, or the typos action
// pin makes this test fail.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
type Step = {
	name?: string;
	if?: string;
	uses?: string;
	run?: string;
	"continue-on-error"?: boolean;
};
const workflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/lint.yml"), "utf8"),
) as {
	jobs: Record<
		string,
		{
			name?: string;
			if?: string;
			"continue-on-error"?: boolean;
			permissions?: Record<string, string>;
			steps?: Step[];
		}
	>;
	on?: { pull_request?: { types?: string[] } };
};
// #3838: the PR title / body / close-keyword jobs live in pr-metadata.yml.
const metadataWorkflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/pr-metadata.yml"), "utf8"),
) as {
	jobs: Record<string, { name?: string; if?: string; steps?: Step[] }>;
	on?: { pull_request?: { types?: string[] } };
};
const advisory = workflow.jobs["lint-advisory"];
const advisorySteps = advisory?.steps ?? [];
const stepRunning = (needle: string): number =>
	advisorySteps.findIndex(
		(step) => (step.run ?? "").includes(needle) || step.uses?.includes(needle),
	);
const GUARD = "!cancelled()";
// One entry per folded tool: what its step runs, and which `if:` words it
// carries. Strictness stays off pull requests (#5112); its publish step is
// `always()` so the report prints after a red generate step.
const tools = [
	["typos", "crate-ci/typos@", [GUARD]],
	["vale", "./vale docs AGENTS.md", [GUARD]],
	["yamllint", "yamllint ", [GUARD]],
	["taplo", "npm run taplo", [GUARD]],
	[
		"jscpd",
		"node_modules/.bin/jscpd --config .jscpd.json clients scripts tools mcp index.ts",
		[GUARD],
	],
	[
		"strictness",
		"node scripts/strictness-report.mjs",
		[GUARD, "github.event_name != 'pull_request'"],
	],
	[
		"strictness publish",
		"cat strictness-report.txt",
		["always()", "github.event_name != 'pull_request'"],
	],
	["complexity", "node scripts/complexity-report.mjs", [GUARD]],
] as const;

describe("#2706 advisory tooling workflow contracts", () => {
	it("hosts the seven tools in one job and keeps lint.yml's other jobs exact", () => {
		expect(Object.keys(workflow.jobs)).toEqual([
			"actionlint",
			"oxfmt",
			"knip",
			"markdownlint",
			"oxlint-advisory",
			"lint-advisory",
		]);
	});

	it("keeps oxfmt as a gating, named job", () => {
		const job = workflow.jobs.oxfmt;
		expect(job?.name).toBe("oxfmt format check");
		expect(job?.["continue-on-error"]).not.toBe(true);
		expect(isAdvisoryCheck("oxfmt format check")).toBe(false);
	});

	// Recurrence: #2837 -- master went red after #2827/#2829 merged unused
	// exports while knip was advisory. Once gating, a rename back to
	// "(advisory)", a continue-on-error, or an ADVISORY_CHECKS entry would
	// silently let that class merge again.
	it("keeps knip as a gating, named job", () => {
		const job = workflow.jobs.knip;
		expect(job?.name).toBe("knip");
		expect(job?.["continue-on-error"]).not.toBe(true);
		expect(isAdvisoryCheck("knip")).toBe(false);
	});

	// Job-level `continue-on-error` is the pinned tolerance (the six folded
	// sites were job-level, tests/fixtures/nightly-floors/continue-on-error-sites.json).
	// A step-level one would make the step read green and the row with it.
	it("keeps the folded job advisory and named, red on any step failure", () => {
		expect(advisory?.name).toBe("Lint (advisory)");
		expect(advisory?.["continue-on-error"]).toBe(true);
		expect(isAdvisoryCheck("Lint (advisory)")).toBe(true);
		expect(
			advisorySteps.filter((step) => step["continue-on-error"] !== undefined),
		).toEqual([]);
	});

	it.each(tools)(
		"keeps the %s step, guarded so one red tool does not stop the rest",
		(_label, needle, words) => {
			const index = stepRunning(needle);
			expect(index, needle).toBeGreaterThan(0);
			for (const word of words)
				expect(advisorySteps[index]?.if, needle).toContain(word);
		},
	);

	it("guards every step after the checkout", () => {
		const unguarded = advisorySteps
			.slice(1)
			.filter((step) => !/!cancelled\(\)|always\(\)/.test(step.if ?? ""))
			.map((step) => step.name ?? step.uses ?? step.run);
		expect(unguarded).toEqual([]);
	});

	// Recurrence risk: `npm run build` writes compiled twins into clients/ and
	// scripts/, which jscpd would then scan and the strictness tsc counts would
	// read. Complexity needs the build, so it runs last.
	it("runs the build after every tool that reads the unbuilt tree", () => {
		const build = stepRunning("npm run build");
		expect(build).toBeGreaterThan(0);
		for (const needle of [
			"node_modules/.bin/jscpd",
			"node scripts/strictness-report.mjs",
			"npm run taplo",
			"yamllint ",
			"./vale docs",
		])
			expect(stepRunning(needle), needle).toBeLessThan(build);
		expect(stepRunning("node scripts/complexity-report.mjs")).toBeGreaterThan(
			build,
		);
	});

	it("keeps complexity wired to the report, summary, and pinned upload", () => {
		const report =
			advisorySteps[stepRunning("node scripts/complexity-report.mjs")];
		expect(report?.run).toContain("set -o pipefail");
		expect(report?.run).toContain("| tee complexity-report.txt");
		const summary = advisorySteps[stepRunning("cat complexity-report.txt")];
		expect(summary?.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
		expect(summary?.if).toBe("always()");
		const upload = advisorySteps.find((step) =>
			step.uses?.startsWith("actions/upload-artifact@"),
		) as (Step & { with?: Record<string, string> }) | undefined;
		expect(upload?.with?.path).toBe("reports/complexity/complexity.md");
		expect(upload?.if).toBe("always()");
	});

	it("pins every action in the folded job to a full SHA with a release comment", () => {
		// Recurrence: the round-1 draft carried the literal offline placeholder
		// `<SHA-TO-PIN>`; any unpinned action would run whatever its mutable tag
		// points at. Keep every action in the job pinned with its release.
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/lint.yml"),
			"utf8",
		);
		const start = raw.indexOf("  lint-advisory:");
		const uses = raw
			.slice(start)
			.split("\n")
			.filter((line) => /^\s+- uses:/.test(line));
		expect(uses.length, "the job must retain its action steps").toBe(
			advisorySteps.filter((step) => step.uses).length,
		);
		expect(uses.length).toBeGreaterThan(0);
		for (const line of uses) {
			expect(line).toMatch(
				/^\s+- uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s+# v\d+(?:\.\d+){0,2}\s*$/,
			);
		}
	});
});

describe("#2714 dependabot skips the human PR-policy checks", () => {
	// Dependabot bypasses the human metadata policy, not code checks.
	const dependabotSkip =
		"github.event_name == 'pull_request' && github.event.pull_request.user.login != 'dependabot[bot]'";

	it("skips the combined policy job for dependabot", () => {
		expect(metadataWorkflow.jobs["pr-metadata"]?.if).toBe(dependabotSkip);
		expect(Object.keys(metadataWorkflow.jobs).sort()).toEqual(["pr-metadata"]);
	});

	// #5002: the title and close-keyword checks are two steps of the gating
	// `PR metadata` job. Each runs even when the other fails, and neither may be
	// continue-on-error, or the gating row would read green on a bad title.
	it("runs the title and close-keyword checks as separate, unmasked steps", () => {
		const job = metadataWorkflow.jobs["pr-metadata"];
		expect(job?.name).toBe("PR metadata");
		expect(isAdvisoryCheck("PR metadata")).toBe(false);
		const checks = [
			"node scripts/check-pr-title.mjs",
			"node scripts/check-close-keywords.mjs --lint-pr",
		].map((command) => (job?.steps ?? []).find((step) => step.run === command));
		for (const step of checks) {
			expect(step?.if).toBe("${{ !cancelled() }}");
			expect(step?.["continue-on-error"]).toBeUndefined();
		}
	});

	it("lets no lint.yml job skip dependabot", () => {
		for (const [key, job] of Object.entries(workflow.jobs)) {
			expect(job.if ?? "", `${key} must not skip dependabot`).not.toContain(
				"dependabot",
			);
		}
	});
});

describe("fork CI policy", () => {
	it("does not restore PR-body validation after the metadata workflow migration", () => {
		expect(workflow.jobs["pr-body-lint"]).toBeUndefined();
		expect(metadataWorkflow.jobs["pr-body-lint"]).toBeUndefined();
		const commands = [
			...Object.values(workflow.jobs),
			...Object.values(metadataWorkflow.jobs),
		].flatMap((job) => (job.steps ?? []).map((step) => String(step.run ?? "")));
		expect(commands.join("\n")).not.toContain("check-pr-body.mjs");
	});

	it("retains lint and type-checking without a dependency-audit gate", () => {
		const ci = yaml.load(
			readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
		) as typeof workflow;
		const lint = Object.values(ci.jobs).find(
			(job) => job.name === "Lint & type-check",
		);
		expect(lint).toBeDefined();
		expect(lint?.steps?.some((step) => step.run === "npm run lint")).toBe(true);
		const commands = Object.values(ci.jobs).flatMap((job) =>
			(job.steps ?? []).map((step) => String(step.run ?? "")),
		);
		expect(commands.join("\n")).not.toContain("audit-prod-deps.mjs");
	});

	it("retains edited-metadata events for title validation", () => {
		expect(metadataWorkflow.on?.pull_request?.types).toEqual([
			"opened",
			"synchronize",
			"reopened",
			"edited",
		]);
	});
});
