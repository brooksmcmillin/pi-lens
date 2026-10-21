// #4291: one path list (PR_SMOKE_PATHS in scripts/ci-changed-files.mjs) decides
// the deep install smoke on a pull request: every pi-load cell and the LSP
// handshake job of install-smoke.yml. The workflow can only read the verdict;
// its own `pull_request.paths:` is what starts the run at all. Every case names
// the recurrence it keeps out, and the scan reads parsed YAML, never the text,
// so a comment cannot satisfy it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { PR_SMOKE_PATHS } from "../../scripts/ci-changed-files.mjs";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/install-smoke.yml";

type Step = {
	id?: string;
	name?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
};
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	"continue-on-error"?: boolean;
	outputs?: Record<string, string>;
	strategy?: { matrix?: { pi_install?: string } };
	steps?: Step[];
};
type Doc = {
	on?: { pull_request?: { paths?: string[] }; push?: { paths?: string[] } };
	jobs: Record<string, Job>;
};
const doc = yaml.load(readFileSync(resolve(ROOT, WORKFLOW), "utf8")) as Doc;

describe("PR_SMOKE_PATHS entries (#4291)", () => {
	// Recurrence: the maintainer-approved list changing without a decision. The
	// list sets what a pull request costs (all four pi-load cells and the
	// handshake: see the PR body), so growing or shrinking it is edited here, in
	// the same change, on purpose. The cases below check each entry; only this
	// one pins which entries there are.
	it("is exactly the approved list", () => {
		expect([...PR_SMOKE_PATHS].sort()).toEqual(
			[
				".github/workflows/install-smoke.yml",
				"clients/bootstrap.ts",
				"clients/gzip-stage-write.ts",
				"clients/installer/**",
				"clients/lsp-lazy.ts",
				"clients/lsp/client-registry.ts",
				"clients/lsp/config.ts",
				"clients/lsp/jvm-runtime.ts",
				"clients/lsp/launch.ts",
				"clients/lsp/resolved-config.ts",
				"clients/lsp/server.ts",
				"clients/project-snapshot-persist-worker.ts",
				"clients/project-snapshot.ts",
				"clients/project-trust.ts",
				"clients/review-graph/builder.ts",
				"clients/review-graph/persist-worker.ts",
				"clients/safe-spawn.ts",
				"package-lock.json",
				"package.json",
				"scripts/bundle-dist.mjs",
				"scripts/download-grammars.js",
				"scripts/install-selftest.mjs",
				"scripts/lib/git-fixture-env.mjs",
				"scripts/lib/latency-log-phases.mjs",
				"scripts/lib/lsp-fixture-session-guard.mjs",
				"scripts/lib/lsp-fixture-workspace.mjs",
				"scripts/lib/safe-rm.mjs",
				"scripts/lib/scratch-dir.mjs",
				"scripts/lib/touch-result.mjs",
				"scripts/rpc-load-check.mjs",
				"scripts/smoke-tools.mjs",
				"tests/fixtures/rpc-load-check/**",
			].sort(),
		);
	});

	// Recurrence: a list entry the matcher cannot read. The grammar is a file or
	// a `dir/**` prefix; a glob such as `clients/*.ts` would match nothing and
	// the deep smoke would silently never turn on for it.
	it.each(PR_SMOKE_PATHS)("%s is a file or a dir/** prefix", (entry) => {
		expect(entry).toMatch(/^[\w./-]+(?:\/\*\*)?$/);
	});

	// Recurrence: a seam renamed or split (clients/project-trust.ts moving) left
	// a dead entry, so the PR that edits the successor ran the one-cell smoke.
	it.each(PR_SMOKE_PATHS)("%s exists in the tree", (entry) => {
		const target = entry.endsWith("/**") ? entry.slice(0, -3) : entry;
		expect(existsSync(resolve(ROOT, target)), target).toBe(true);
		if (entry.endsWith("/**"))
			expect(statSync(resolve(ROOT, target)).isDirectory()).toBe(true);
	});

	it("lists no entry twice", () => {
		expect(new Set(PR_SMOKE_PATHS).size).toBe(PR_SMOKE_PATHS.length);
	});

	// Recurrence (#4291 review F1): the list named four launch files by hand and
	// missed clients/lsp/client-registry.ts, the only `.spawn(` call site and the
	// trust backstop (#4374), so a PR touching only it ran the one-cell smoke.
	// The rule is derived: any clients/lsp/*.ts that calls `.spawn(` must be on
	// the list, so the #2372 split cannot move the call site off it. The scan
	// reads comment-and-string-blanked text; a comment naming `.spawn(` neither
	// adds a file nor excuses one.
	it("lists every clients/lsp/*.ts file that holds a `.spawn(` call site", () => {
		const dir = resolve(ROOT, "clients/lsp");
		const holders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) =>
				/\.spawn\s*\(/.test(
					stripCommentsAndStrings(readFileSync(resolve(dir, name), "utf8")),
				),
			)
			.map((name) => `clients/lsp/${name}`);
		assertNonEmptyScan("clients/lsp spawn call sites", holders.length);
		expect(holders.filter((file) => !PR_SMOKE_PATHS.includes(file))).toEqual(
			[],
		);
	});

	// Recurrence: the list gaining an entry the workflow's own filter lacks. A PR
	// touching only that path starts no install-smoke run, so neither deep job
	// ever sees it. The workflow filter may be wider (the one-cell triggers); it
	// may not be narrower.
	it.each(PR_SMOKE_PATHS)(
		"%s sits verbatim in install-smoke.yml's pull_request paths",
		(entry) => {
			expect(doc.on?.pull_request?.paths).toContain(entry);
		},
	);

	// Recurrence: push and pull_request filters diverging, so master runs the
	// workflow for a path the PR did not (the YAML alias is what keeps them one).
	it("shares one paths list between push and pull_request", () => {
		expect(doc.on?.pull_request?.paths).toEqual(doc.on?.push?.paths);
	});
});

describe("install-smoke.yml reads the one verdict (#4291)", () => {
	const scope = doc.jobs.scope;
	const classify = scope?.steps?.find((step) => step.id === "classify");

	// Recurrence: two jobs each carrying their own filter. The verdict has one
	// producer, the script that owns the list, and one output.
	it("derives the verdict from ci-changed-files.mjs and exports it as `smoke`", () => {
		expect(classify?.run).toMatch(/node scripts\/ci-changed-files\.mjs\b/);
		expect(scope?.outputs?.smoke).toBe("${{ steps.classify.outputs.smoke }}");
	});

	// Recurrence: a consumer left reading some other expression, so the two
	// filters drift. Both consumers name the same output of the same job.
	it("feeds pi-load's matrix and lsp-handshake's gate from needs.scope.outputs.smoke", () => {
		for (const job of ["pi-load", "lsp-handshake"]) {
			const needs = doc.jobs[job]?.needs;
			expect([needs].flat(), job).toContain("scope");
		}
		expect(doc.jobs["pi-load"]?.strategy?.matrix?.pi_install).toContain(
			"needs.scope.outputs.smoke",
		);
		expect(doc.jobs["lsp-handshake"]?.if).toContain(
			"needs.scope.outputs.smoke",
		);
	});

	// Recurrence (#4291 review F4): `scope` is continue-on-error. If it fails or is
	// skipped, a plain `needs` would skip pi-load too, and the four-cell fallback
	// the matrix expression provides would never run. `!cancelled()` keeps the
	// job alive on a failed `scope`; the matrix then reads an empty verdict.
	it("keeps pi-load running when scope fails, stopping only on cancellation", () => {
		expect(doc.jobs["pi-load"]?.if).toBe("${{ !cancelled() }}");
	});

	// Recurrence (#3087): a continue-on-error job whose name does not say so reads
	// as a gating check that always passes.
	it.each(["scope", "lsp-handshake"])(
		"%s is advisory by name and by continue-on-error",
		(job) => {
			expect(doc.jobs[job]?.["continue-on-error"]).toBe(true);
			expect(doc.jobs[job]?.name).toMatch(/\(advisory\)$/);
		},
	);
});

describe("install-smoke.yml lsp-handshake job (#4291)", () => {
	const steps = doc.jobs["lsp-handshake"]?.steps ?? [];
	const handshake = steps.find((step) => step.id === "handshake");
	const report = steps.find((step) =>
		/failing handshake rows/i.test(step.name ?? ""),
	);

	// Recurrence: the PR run quietly widening into the full nightly (the gating
	// diagnostics layer, 30 minutes) or never installing the servers it spawns.
	it("runs the handshake layer only, installing servers", () => {
		expect(handshake?.run).toMatch(/smoke-tools\.mjs --lsp --install\b/);
		expect(handshake?.run).not.toMatch(/--lsp-gate/);
	});

	// Recurrence (#4291 review F5): a copied `npm install` in a new job (Sonar
	// S6505); the sibling shape is a locked install with no lifecycle scripts.
	it("installs with npm ci --ignore-scripts", () => {
		const install = steps.find((step) => step.name === "Install dependencies");
		expect(install?.run).toMatch(/^npm ci\b.*--ignore-scripts\b/);
	});

	// Recurrence: the report step moved before the handshake, or lost its
	// `always()`, so a red handshake skips it. The behaviour of the step, and of
	// the handshake's pipefail, is executed in
	// tests/scripts/install-smoke-handshake-steps.test.ts.
	it("reports after the handshake, on every outcome", () => {
		expect(report?.if).toBe("always()");
		expect(steps.indexOf(report as Step)).toBeGreaterThan(
			steps.indexOf(handshake as Step),
		);
	});
});
