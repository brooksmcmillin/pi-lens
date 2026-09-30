// flake-shape: real-process-spawn — the subject is the pre-push hook's own
// contract with git: the stdin ref lines git writes, and the script's
// deletion-only early exit and range union (#3661). The main-level witness
// runs the real script over a real git fixture; an in-process call cannot
// see the CLI's exit status or its build/test skip.
/**
 * Tests for scripts/pre-push-targeted-tests.mjs's selection logic (#1804
 * review round 1, findings F1/F6/F7).
 *
 * The pre-push hook's whole safety claim ("never the full suite") rests on
 * this selection staying narrow. A prior basename-substring version of the
 * content-grep pass matched any import ending in `/<basename>` regardless of
 * directory — `index.ts` alone selected 176 test files, and a real 43-file
 * commit selected 282 (~10 minutes). These tests pin the fix: full-path
 * import resolution (not a basename/substring guess) plus a hard cap that
 * degrades to build-only instead of ever approaching "the whole suite" by
 * accident.
 *
 * `selectTargetedTests` resolves paths relative to `process.cwd()` (mirrors
 * a real repo checkout: `clients/x.ts` <-> `tests/clients/x.test.ts`), so
 * each test builds an isolated fixture tree under a temp dir and chdirs into
 * it for the duration of the test, restoring the real cwd in `afterEach` —
 * never touches the real `tests/`/`clients/` trees.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	CI_ONLY_PRE_PUSH_TESTS,
	collectTestFiles,
	MAX_SELECTED_TESTS,
	TEST_TREE_GOVERNANCE_TESTS,
	TREE_SCANNING_GOVERNANCE_TESTS,
	changesProductionFile,
	changesTestTreeFile,
	selectTargetedTests,
	resolveDiffRange,
} from "../../scripts/pre-push-targeted-tests.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

let fixtureDir: string | undefined;
const originalCwd = process.cwd();

function write(relPath: string, content: string) {
	const full = path.join(fixtureDir as string, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

function enterFixture() {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pre-push-test-"));
	process.chdir(fixtureDir);
}

afterEach(() => {
	process.chdir(originalCwd);
	if (fixtureDir) {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	}
});

describe("resolveDiffRange — pre-push ref population (#3661)", () => {
	const zero = "0".repeat(40);

	it("returns no ranges for a deletion-only push so the hook skips before building", () => {
		// #3661 recurrence: a deletion's all-zero local sha was treated as a
		// normal update, causing a failed diff and an unnecessary build.
		expect(
			resolveDiffRange(`(delete) ${zero} refs/heads/removed abc123\n`),
		).toBeNull();
	});

	it("exits before the build on a deletion-only hook invocation", () => {
		// #3661 recurrence: the hook must make the deletion decision before its
		// build entry point, not merely avoid selecting tests afterward.
		const result = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, "scripts/pre-push-targeted-tests.mjs"),
				"--skip-build",
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				input: `(delete) ${zero} refs/heads/removed abc123\n`,
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"deletion-only push; skipping build and tests",
		);
	});

	it.each([
		[
			"deletion first",
			`(delete) ${zero} refs/heads/removed abc123\nrefs/heads/topic localsha refs/heads/topic remotesha\n`,
		],
		[
			"update first",
			`refs/heads/topic localsha refs/heads/topic remotesha\n(delete) ${zero} refs/heads/removed abc123\n`,
		],
	])(
		"ignores deletion lines regardless of their order (%s)",
		(_name, stdin) => {
			// #3661 recurrence: reading only the first line made mixed pushes
			// depend on ref ordering and could select a deletion range.
			expect(resolveDiffRange(stdin)).toEqual(["remotesha...localsha"]);
		},
	);

	it("keeps the origin/master fallback for a new branch", () => {
		// #3661 recurrence: a non-deletion line with an all-zero remote sha is
		// the new-branch case and must retain the existing fallback.
		expect(
			resolveDiffRange(`refs/heads/topic localsha refs/heads/topic ${zero}\n`),
		).toEqual(["origin/master...HEAD"]);
	});

	it("deduplicates repeated update and new-branch ranges", () => {
		// F3664-1 recurrence: multiple ref lines can describe the same range;
		// main must not run the same diff and target twice.
		expect(
			resolveDiffRange(
				`refs/heads/topic localsha refs/heads/topic remotesha\n` +
					`refs/heads/topic localsha refs/heads/topic remotesha\n` +
					`refs/heads/new newlocal refs/heads/new ${zero}\n` +
					`refs/heads/new newerlocal refs/heads/new ${zero}\n`,
			),
		).toEqual(["remotesha...localsha", "origin/master...HEAD"]);
	});

	it.each([
		[
			"update first",
			"refs/heads/updated localsha refs/heads/updated remotesha\n" +
				`refs/heads/new-branch newlocal refs/heads/new-branch ${zero}\n`,
			["remotesha...localsha", "origin/master...HEAD"],
		],
		[
			"new branch first",
			`refs/heads/new-branch newlocal refs/heads/new-branch ${zero}\n` +
				"refs/heads/updated localsha refs/heads/updated remotesha\n",
			["origin/master...HEAD", "remotesha...localsha"],
		],
	])(
		"unions an update with a new-branch fallback (%s)",
		(_name, stdin, expected) => {
			// F3664-1 recurrence: a mixed push must not lose the normal update when
			// the new-branch fallback appears before or after it.
			expect(resolveDiffRange(stdin)).toEqual(expected);
		},
	);

	it("passes changed files from both mixed-push ranges to selection", () => {
		// F3664-1 witness: main must call changedFiles for both ranges; a
		// ranges.slice(0, 1) mutation must leave one target out of this output.
		fixtureDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-pre-push-test-"));
		process.chdir(fixtureDir);
		const scriptDir = path.join(fixtureDir as string, "scripts");
		fs.symlinkSync(path.join(repoRoot, "scripts"), scriptDir, "dir");
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(fixtureDir as string, "node_modules"),
			"dir",
		);
		fs.symlinkSync(
			path.join(repoRoot, "vitest.config.ts"),
			path.join(fixtureDir as string, "vitest.config.ts"),
		);
		fs.symlinkSync(
			path.join(repoRoot, "package.json"),
			path.join(fixtureDir as string, "package.json"),
		);
		write("clients/first.ts", "export const first = true;\n");
		write("tests/clients/first.test.ts", "it('first', () => {});\n");
		write("clients/second.ts", "export const second = true;\n");
		write("tests/clients/second.test.ts", "it('second', () => {});\n");
		const git = (args: string[]) =>
			String(gitExecFileSync(args, { cwd: fixtureDir, encoding: "utf8" }));
		git(["init", "--quiet", "--initial-branch=main"]);
		git(["config", "user.name", "pi-lens test"]);
		git(["config", "user.email", "test@example.com"]);
		git(["add", "."]);
		git(["commit", "--quiet", "-m", "base"]);
		const base = git(["rev-parse", "HEAD"]).trim();
		git(["update-ref", "refs/remotes/origin/master", base]);
		write("clients/first.ts", "export const first = false;\n");
		git(["add", "clients/first.ts"]);
		git(["commit", "--quiet", "-m", "first"]);
		const first = git(["rev-parse", "HEAD"]).trim();
		write("clients/second.ts", "export const second = false;\n");
		git(["add", "clients/second.ts"]);
		git(["commit", "--quiet", "-m", "second"]);
		const second = git(["rev-parse", "HEAD"]).trim();

		const result = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, "scripts/pre-push-targeted-tests.mjs"),
				"--skip-build",
			],
			{
				cwd: fixtureDir,
				encoding: "utf8",
				input: `refs/heads/first ${first} refs/heads/first ${base}\nrefs/heads/new ${second} refs/heads/new ${zero}\n`,
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("tests/clients/first.test.ts");
		expect(result.stdout).toContain("tests/clients/second.test.ts");
	});
});

describe("selectTargetedTests — path-mirror pass", () => {
	it("selects the registered tree scanners for production changes", () => {
		enterFixture();
		for (const test of TREE_SCANNING_GOVERNANCE_TESTS)
			write(test, "it('governance');\n");
		write("clients/review-graph/git-identity.ts", "export {}\n");

		const result = selectTargetedTests(
			["clients/review-graph/git-identity.ts"],
			collectTestFiles("tests"),
		);

		// Prevents tree scanners from disappearing from a production-file push
		// because they do not import the changed module (#3426).
		expect(changesProductionFile("clients/review-graph/git-identity.ts")).toBe(
			true,
		);
		expect(result.selected).toEqual(TREE_SCANNING_GOVERNANCE_TESTS);
	});

	it("arms the registry for tools, mcp, scripts, and the root index", () => {
		for (const file of ["tools/x.ts", "mcp/x.ts", "scripts/x.mjs", "index.ts"])
			expect(changesProductionFile(file)).toBe(true);
	});

	it("selects the exact mirrored test path for a changed source file", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write(
			"tests/clients/foo/bar.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/clients/foo/bar.test.ts"]);
		expect(result.unmatched).toEqual([]);
		expect(result.capped).toBe(false);
	});

	it("defers a CI-only real-spawn suite to CI and reports it (#3426 H3432-1)", () => {
		enterFixture();
		const ciOnlyFile = Object.keys(CI_ONLY_PRE_PUSH_TESTS)[0];
		expect(ciOnlyFile).toBeDefined();
		write(ciOnlyFile as string, "it('hook', () => {});\n");

		const allTests = collectTestFiles("tests");
		const prePush = selectTargetedTests([ciOnlyFile as string], allTests);
		// The budget-busting suite never enters the local pre-push selection…
		expect(prePush.selected).toEqual([]);
		// …and its deferral is disclosed, never silently dropped.
		expect(prePush.excludedCiOnly).toEqual([ciOnlyFile]);
		expect(prePush.capped).toBe(false);

		// The CI job admits it through the same production entry point.
		const ci = selectTargetedTests([ciOnlyFile as string], allTests, {
			includeCiOnly: true,
		});
		expect(ci.selected).toEqual([ciOnlyFile]);
		expect(ci.excludedCiOnly).toEqual([]);
	});

	// #3472 recurrence (#3492, 2026-09-26): a new test's real 60 s setTimeout
	// pushed with the flake-shape ratchet red, because the ratchet scans the
	// tests tree and neither the mirror nor the import pass selects it. The
	// changed files are 0b5cb182a's own.
	it("arms the tests-tree ratchet when a pushed change touches the tests tree", () => {
		enterFixture();
		for (const test of TEST_TREE_GOVERNANCE_TESTS)
			write(test, "it('ratchet');\n");
		write("clients/lsp/client.ts", "export {}\n");
		write("tests/clients/lsp/diagnostics-fence.test.ts", "it('x');\n");

		const changed = [
			".changelog/3484-fence-hold-record.md",
			"clients/lsp/client.ts",
			"tests/clients/lsp/diagnostics-fence.test.ts",
		];
		const result = selectTargetedTests(changed, collectTestFiles("tests"));

		expect(TEST_TREE_GOVERNANCE_TESTS).toContain(
			"tests/clients/flake-shape-ratchet.test.ts",
		);
		expect([...result.selected].sort()).toEqual(
			[
				"tests/clients/lsp/diagnostics-fence.test.ts",
				...TEST_TREE_GOVERNANCE_TESTS,
			].sort(),
		);
		// A support-module change reaches the ratchet too: it counts helpers
		// under tests/support (the #2885 never-settling-promise detector).
		expect(changesTestTreeFile("tests/support/fake-child.ts")).toBe(true);
		expect(
			selectTargetedTests(
				["tests/support/fake-child.ts"],
				collectTestFiles("tests"),
			).selected,
		).toEqual(TEST_TREE_GOVERNANCE_TESTS);
	});

	it("leaves the tests-tree ratchet out of a push that touches no test file", () => {
		enterFixture();
		for (const test of TEST_TREE_GOVERNANCE_TESTS)
			write(test, "it('ratchet');\n");
		write("clients/foo/bar.ts", "export const x = 1;\n");

		const allTests = collectTestFiles("tests");
		expect(changesTestTreeFile("clients/foo/bar.ts")).toBe(false);
		expect(changesTestTreeFile("docs/tests/x.md")).toBe(false);
		expect(
			selectTargetedTests(["clients/foo/bar.ts"], allTests).selected,
		).toEqual([]);
		expect(selectTargetedTests(["docs/tests/x.md"], allTests).selected).toEqual(
			[],
		);
	});

	it("always includes a changed test file itself", () => {
		enterFixture();
		write("tests/clients/foo/bar.test.ts", "it('x', () => {});\n");

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(
			["tests/clients/foo/bar.test.ts"],
			allTests,
		);

		expect(result.selected).toEqual(["tests/clients/foo/bar.test.ts"]);
	});
});

describe("selectTargetedTests — import-resolution pass (full path, not basename)", () => {
	it("selects a sibling test file that imports the changed module by its real path", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		// No mirrored tests/clients/foo/bar.test.ts — only a differently-named
		// sibling that imports it, the shared-seam-wiring-test shape.
		write(
			"tests/wiring-suite.test.ts",
			"import { x } from '../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/wiring-suite.test.ts"]);
	});

	it("does NOT select a test file that merely shares the changed file's basename in a different directory (the #1804 review regression)", () => {
		enterFixture();
		// Two files named `bar.ts` in different directories — the exact shape
		// that broke the old basename-substring matcher: `/${base}` matched
		// both `clients/foo/bar` and `clients/other/bar` imports alike.
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write("clients/other/bar.ts", "export const y = 2;\n");
		write(
			"tests/clients/foo/bar.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		// Changing clients/other/bar.ts must NOT pull in
		// tests/clients/foo/bar.test.ts — that test never imports
		// clients/other/bar at all, it only shares the basename "bar".
		const result = selectTargetedTests(["clients/other/bar.ts"], allTests);

		expect(result.selected).toEqual([]);
		expect(result.unmatched).toEqual(["clients/other/bar.ts"]);
	});

	it("resolves .js import specifiers against a .ts changed file (compiled-output convention)", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write(
			"tests/clients/foo/other-name.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/clients/foo/other-name.test.ts"]);
	});
});

describe("selectTargetedTests — the >25-file cap (F1)", () => {
	it("degrades to build-only (empty selection, capped=true) once matches exceed MAX_SELECTED_TESTS", () => {
		enterFixture();
		write("clients/shared.ts", "export const shared = 1;\n");

		const testCount = MAX_SELECTED_TESTS + 1;
		for (let i = 0; i < testCount; i++) {
			write(
				`tests/generated-${i}.test.ts`,
				`import { shared } from '../clients/shared.js';\n`,
			);
		}

		const allTests = collectTestFiles("tests");
		expect(allTests.length).toBe(testCount);

		const result = selectTargetedTests(["clients/shared.ts"], allTests);

		// Mutation-proof: if the cap check were removed or off-by-one'd the
		// wrong way, `selected` would contain all `testCount` entries and
		// `capped` would read false — this assertion goes red on either.
		expect(result.capped).toBe(true);
		expect(result.selected).toEqual([]);
		expect(result.totalBeforeCap).toBe(testCount);
	});

	// #3492 (2026-09-26): 0b5cb182a changed clients/lsp/client.ts, which 71
	// test files match, so the heuristic selection capped and the hook ran
	// NOTHING; the raw 60 s timer it added reached CI. The registries are
	// bounded by construction, so a capped push still runs them.
	it("still runs the armed governance registries when the heuristic selection caps", () => {
		enterFixture();
		for (const test of [
			...TREE_SCANNING_GOVERNANCE_TESTS,
			...TEST_TREE_GOVERNANCE_TESTS,
		])
			write(test, "it('governance');\n");
		write("clients/lsp/client.ts", "export const shared = 1;\n");
		for (let i = 0; i < MAX_SELECTED_TESTS + 1; i++) {
			write(
				`tests/clients/lsp/generated-${i}.test.ts`,
				`import { shared } from '../../../clients/lsp/client.js';\n`,
			);
		}
		write("tests/clients/lsp/diagnostics-fence.test.ts", "it('x');\n");

		const result = selectTargetedTests(
			[
				".changelog/3484-fence-hold-record.md",
				"clients/lsp/client.ts",
				"tests/clients/lsp/diagnostics-fence.test.ts",
			],
			collectTestFiles("tests"),
		);

		expect(result.capped).toBe(true);
		expect([...result.selected].sort()).toEqual(
			[...TREE_SCANNING_GOVERNANCE_TESTS, ...TEST_TREE_GOVERNANCE_TESTS].sort(),
		);
		// The registries never push the heuristic selection over the cap.
		for (let i = MAX_SELECTED_TESTS - 1; i <= MAX_SELECTED_TESTS + 1; i++)
			fs.rmSync(`tests/clients/lsp/generated-${i}.test.ts`, { force: true });
		const underCap = selectTargetedTests(
			["clients/lsp/client.ts", "tests/clients/lsp/diagnostics-fence.test.ts"],
			collectTestFiles("tests"),
		);
		expect(underCap.capped).toBe(false);
		expect(underCap.selected).toContain(
			"tests/clients/lsp/generated-0.test.ts",
		);
	});

	it("does not cap when the match count is exactly at the limit", () => {
		enterFixture();
		write("clients/shared.ts", "export const shared = 1;\n");

		for (let i = 0; i < MAX_SELECTED_TESTS; i++) {
			write(
				`tests/generated-${i}.test.ts`,
				`import { shared } from '../clients/shared.js';\n`,
			);
		}

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/shared.ts"], allTests);

		expect(result.capped).toBe(false);
		expect(result.selected.length).toBe(MAX_SELECTED_TESTS);
	});
});

describe("selectTargetedTests — no-match fallback (F7)", () => {
	it("reports a changed file with no covering test as unmatched, selects nothing for it", () => {
		enterFixture();
		write("clients/orphan.ts", "export const o = 1;\n");
		write("tests/clients/unrelated.test.ts", "it('x', () => {});\n");

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/orphan.ts"], allTests);

		expect(result.selected).toEqual([]);
		expect(result.unmatched).toEqual(["clients/orphan.ts"]);
		expect(result.capped).toBe(false);
	});
});

describe(".husky hooks — PI_LENS_SKIP_HOOKS accepts any non-empty value (F8)", () => {
	it("pre-commit formats only staged files through the pinned binary (#3426)", () => {
		const hook = fs.readFileSync(
			path.join(repoRoot, ".husky/pre-commit"),
			"utf8",
		);
		expect(hook).toContain(
			"git diff --cached --name-only --diff-filter=ACMR -z",
		);
		expect(hook).toContain(
			"npx --no-install oxfmt --check --no-error-on-unmatched-pattern",
		);
		expect(hook).not.toContain("npm install oxfmt --no-save");
	});

	it.each(["1", "true"])(
		"pre-commit exits 0 and skips without running checks when PI_LENS_SKIP_HOOKS=%s",
		(value) => {
			const result = spawnSync("sh", [".husky/pre-commit"], {
				cwd: repoRoot,
				env: { ...process.env, PI_LENS_SKIP_HOOKS: value },
				encoding: "utf8",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("[pre-commit] skipped");
		},
	);

	it.each(["1", "true"])(
		"pre-push exits 0 and skips without running the targeted-test script when PI_LENS_SKIP_HOOKS=%s",
		(value) => {
			const result = spawnSync("sh", [".husky/pre-push"], {
				cwd: repoRoot,
				env: { ...process.env, PI_LENS_SKIP_HOOKS: value },
				encoding: "utf8",
				input: "",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("[pre-push] skipped");
		},
	);
});
