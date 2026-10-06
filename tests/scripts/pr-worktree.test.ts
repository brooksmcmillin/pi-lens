// flake-shape: real-process-spawn — the subject IS the script's own process
// entry: a real `git` fixture's worktree registry, the real on-disk
// `node_modules` symlink, and the real exit code decide open/close; an
// in-process double restates none of those command boundaries.
/**
 * Tests for scripts/pr-worktree.mjs (#3723).
 *
 * The dangerous half of `close` is the decision — unlink only a symlink,
 * refuse a real directory, never touch the link target — and that decision
 * lives in scripts/lib/pr-worktree.mjs so it is provable without a
 * filesystem. These cases drive BOTH layers: the pure planner directly, and
 * the real CLI entry against a throwaway git fixture (no network; the `gh`
 * lookup is injected through `PI_LENS_GH_JSON`).
 *
 * The close guard is the #3173 / #2704 class: a `git worktree remove` on a
 * symlinked `node_modules` follows the link into the shared install on the
 * platforms where it bites, so `close` unlinks the symlink itself and refuses
 * a real directory rather than deleting it recursively.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyNodeModules,
	deriveClosePlan,
	deriveOpenPlan,
	worktreeBranchName,
} from "../../scripts/lib/pr-worktree.mjs";
import { run } from "../../scripts/pr-worktree.mjs";
import { gitFixtureEnv } from "../support/git-fixture-env.js";

const CLI = path.resolve(__dirname, "../../scripts/pr-worktree.mjs");
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git";

const createdRoots: string[] = [];

afterEach(() => {
	for (const dir of createdRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	root: string;
	repo: string;
	origin: string;
	worktreesRoot: string;
	head: string;
	/** Tip of `refs/pull/9002/head`: a commit no branch on origin contains. */
	prOnlyHead: string;
	git: (args: string[], cwd?: string) => string;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pr-worktree-"));
	createdRoots.push(root);
	const repo = path.join(root, "main");
	const origin = path.join(root, "origin.git");
	const worktreesRoot = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	const git = (args: string[], cwd = repo) =>
		execFileSync(GIT, args, {
			cwd,
			env: gitFixtureEnv(root),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(["init", "-q", "-b", "master"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "pi-lens test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
	git(["add", "."]);
	git(["commit", "-qm", "init"]);
	// The main checkout's shared install, present before any open symlinks it.
	fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "node_modules", "shared-sentinel.txt"),
		"shared install\n",
	);
	git(["init", "-q", "--bare", "-b", "master", origin], root);
	git(["remote", "add", "origin", origin]);
	git(["push", "-q", "-u", "origin", "master"]);
	const head = git(["rev-parse", "HEAD"]).trim();
	// GitHub's pull/<n>/{head,merge} refs, mirrored into the throwaway origin
	// so the fetch path is exercised with no network.
	git(["-C", origin, "update-ref", "refs/pull/9001/head", head]);
	git(["-C", origin, "update-ref", "refs/pull/9001/merge", head]);
	// A PR whose head lives ONLY under refs/pull (no branch on origin holds it),
	// as a real PR head does after `open` fetches just `pull/<n>/head`.
	git(["checkout", "-q", "-b", "pr9002"]);
	fs.writeFileSync(path.join(repo, "pr.txt"), "pr only\n");
	git(["add", "pr.txt"]);
	git(["commit", "-qm", "pr only commit"]);
	const prOnlyHead = git(["rev-parse", "HEAD"]).trim();
	git(["push", "-q", "origin", "pr9002:refs/pull/9002/head"]);
	git(["checkout", "-q", "master"]);
	git(["branch", "-q", "-D", "pr9002"]);
	return { root, repo, origin, worktreesRoot, head, prOnlyHead, git };
}

function runCli(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: fixture.repo,
		env: {
			...gitFixtureEnv(fixture.root),
			PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			...extraEnv,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

function runCliResult(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
	try {
		return { status: 0, stdout: runCli(fixture, args, extraEnv), stderr: "" };
	} catch (error) {
		const failure = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: failure.status ?? 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

const PR_HEAD_JSON = JSON.stringify({
	headRefName: "fix/thing",
	headRepositoryOwner: { login: "apmantza" },
	isCrossRepository: false,
});

/** `gitExec` for `run()`: the real git, pinned to the fixture's env. */
function fixtureGitExec(fixture: Fixture) {
	return (args: string[], options: { cwd?: string } = {}) =>
		execFileSync(GIT, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: gitFixtureEnv(fixture.root),
			...options,
		});
}

function fixtureRun(
	fixture: Fixture,
	argv: string[],
	options: {
		cwd?: string;
		ghExec?: (args: string[]) => string;
		gitExec?: (args: string[], options?: { cwd?: string }) => string;
	} = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const status = run({
		argv,
		cwd: options.cwd ?? fixture.repo,
		env: {
			...gitFixtureEnv(fixture.root),
			PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
		} as NodeJS.ProcessEnv,
		gitExec: options.gitExec ?? fixtureGitExec(fixture),
		ghExec: options.ghExec,
		stdout: (message) => stdout.push(message),
		stderr: (message) => stderr.push(message),
	});
	return { status, stdout, stderr };
}

/**
 * Make the main checkout's `node_modules` a SYMLINK to an outside directory
 * (as a shared install often is), so a close that reaches the main checkout
 * has a link to wrongly unlink.
 */
function linkMainNodeModules(fixture: Fixture): string {
	const shared = path.join(fixture.root, "shared-install");
	fs.mkdirSync(shared, { recursive: true });
	fs.writeFileSync(path.join(shared, "sentinel.txt"), "shared\n");
	const link = path.join(fixture.repo, "node_modules");
	fs.rmSync(link, { recursive: true, force: true });
	fs.symlinkSync(shared, link);
	return shared;
}

function expectLinkIntact(link: string, target: string): void {
	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(fs.readlinkSync(link)).toBe(target);
	expect(fs.existsSync(path.join(target, "sentinel.txt"))).toBe(true);
}

/** A tree `open` linked to the fixture's real main install is still linked. */
function expectOpenLinkIntact(worktree: string): void {
	const link = path.join(worktree, "node_modules");
	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(fs.existsSync(path.join(link, "shared-sentinel.txt"))).toBe(true);
}

/** A registered worktree at `worktree` whose node_modules links to `target`. */
function addLinkedWorktree(
	fixture: Fixture,
	worktree: string,
	branch: string,
	target: string,
): void {
	fixture.git(["worktree", "add", "-b", branch, worktree]);
	fs.symlinkSync(target, path.join(worktree, "node_modules"));
}

const WORKTREES_ROOT = path.join(path.sep, "trees");
const WT = path.join(WORKTREES_ROOT, "review-1");

function closeInput(
	override: Partial<Parameters<typeof deriveClosePlan>[0]> = {},
) {
	return {
		worktreePath: WT,
		worktreesRoot: WORKTREES_ROOT,
		mainRoot: path.join(path.sep, "main"),
		registered: true,
		dirty: false,
		detachedCommits: [] as string[],
		detachedCheckFailed: false,
		nodeModulesKind: "missing" as const,
		branchExists: true,
		branchUnpushed: false,
		...override,
	};
}

describe("pr-worktree planner (pure)", () => {
	it("classifies a missing, symlinked, and real node_modules distinctly", () => {
		expect(classifyNodeModules(null)).toBe("missing");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => true,
				isDirectory: () => false,
			}),
		).toBe("symlink");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => false,
				isDirectory: () => true,
			}),
		).toBe("directory");
	});

	it("refuses close on a real directory and unlinks only a symlink", () => {
		const refused = deriveClosePlan(
			closeInput({ nodeModulesKind: "directory" }),
		);
		expect(refused.ok).toBe(false);
		const allowed = deriveClosePlan(closeInput({ nodeModulesKind: "symlink" }));
		expect(allowed).toMatchObject({
			ok: true,
			unlinkNodeModules: true,
			branchToDelete: "pr-worktree/review-1",
		});
	});

	// Recurrence: #2704 / #3173 (a close reaching a tree it must never touch)
	// and PR #3730 r1 S1/T2/T3 -- each rail is a distinct refusal, decided
	// BEFORE the CLI performs any unlink.
	it("refuses each close rail with its own reason before anything is unlinked", () => {
		const rails: [string, Partial<ReturnType<typeof closeInput>>, RegExp][] = [
			["unregistered", { registered: false }, /not a registered worktree/],
			["main checkout", { mainRoot: WT }, /main checkout/],
			[
				"outside root",
				{ worktreesRoot: path.join("/other", "root") },
				/outside/,
			],
			["worktrees root itself", { worktreesRoot: WT }, /outside/],
			["parent of the root", { worktreePath: path.sep }, /outside/],
			["dirty", { dirty: true }, /uncommitted|untracked/],
			[
				"detached commits",
				{ detachedCommits: ["abc1234 lost work"] },
				/detached HEAD[^]*abc1234 lost work[^]*git switch -c <name>/,
			],
			[
				"detached check failed",
				{ detachedCheckFailed: true },
				/could not verify/,
			],
		];
		for (const [label, override, reason] of rails) {
			const plan = deriveClosePlan(
				closeInput({ nodeModulesKind: "symlink", ...override }),
			);
			expect(plan.ok, label).toBe(false);
			expect((plan as { error: string }).error, label).toMatch(reason);
		}
	});

	it("keeps a branch with unpushed commits and says so", () => {
		const plan = deriveClosePlan(closeInput({ branchUnpushed: true }));
		expect(plan).toMatchObject({ ok: true, branchToDelete: null });
		expect((plan as { branchKept: string }).branchKept).toContain(
			"pr-worktree/review-1",
		);
		expect(
			deriveClosePlan(closeInput({ branchUnpushed: false })),
		).toMatchObject({ ok: true, branchToDelete: "pr-worktree/review-1" });
	});

	it("derives PR-head, PR-merge, and branch open plans", () => {
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "head",
				name: null,
				worktreesRoot: "w",
				prHead: { headRefName: "fix/thing" },
			}),
		).toMatchObject({
			ok: true,
			name: "pr-9001-fix-thing",
			branch: "pr-worktree/pr-9001-fix-thing",
			fetchRefspec: "pull/9001/head",
		});
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "merge",
				name: "review-2",
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "review-2",
			fetchRefspec: "pull/9001/merge",
		});
		expect(
			deriveOpenPlan({
				target: "fix/other",
				mode: null,
				name: null,
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "fix-other",
			branch: null,
			fetchRefspec: null,
			commitish: "fix/other",
		});
		expect(worktreeBranchName(path.join("w", "review-2"))).toBe(
			"pr-worktree/review-2",
		);
	});
});

describe("pr-worktree CLI open", () => {
	it("prints the absolute path, checks out the PR head, and links the shared install", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--head", "--name", "review-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "review-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		const link = path.join(worktree, "node_modules");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(link)).toBe(path.join(fixture.repo, "node_modules"));
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-1"]),
		).toContain("refs/heads/pr-worktree/review-1");
	});

	it("opens a PR merge ref through pull/<n>/merge", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--merge", "--name", "merge-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "merge-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/merge-1"]),
		).toContain("refs/heads/pr-worktree/merge-1");
	});
});

describe("pr-worktree CLI close", () => {
	it("unlinks a symlinked node_modules and leaves the link target untouched", () => {
		const fixture = makeFixture();
		const target = path.join(fixture.root, "link-target");
		fs.mkdirSync(path.join(target, "deep"), { recursive: true });
		fs.writeFileSync(path.join(target, "deep", "sentinel.txt"), "keep\n");
		const worktree = path.join(fixture.worktreesRoot, "review-2");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-2", worktree]);
		fs.symlinkSync(target, path.join(worktree, "node_modules"));

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(
			fs.readFileSync(path.join(target, "deep", "sentinel.txt"), "utf8"),
		).toBe("keep\n");
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-2"]),
		).toThrow();
	});

	it("refuses a real node_modules directory and leaves the worktree registered", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-3");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-3", worktree]);
		fs.mkdirSync(path.join(worktree, "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(worktree, "node_modules", "keep.txt"), "copy\n");

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing");
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fs.readFileSync(path.join(worktree, "node_modules", "keep.txt"), "utf8"),
		).toBe("copy\n");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			path.resolve(worktree),
		);
	});

	it("unlinks node_modules BEFORE git worktree remove (the #3173 ordering guard)", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-4");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-4", worktree]);
		fs.symlinkSync(
			path.join(fixture.repo, "node_modules"),
			path.join(worktree, "node_modules"),
		);
		let nodeModulesPresentAtRemove = true;
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				nodeModulesPresentAtRemove = fs.existsSync(
					path.join(worktree, "node_modules"),
				);
			}
			return fixtureGitExec(fixture)(args, options);
		};
		const status = run({
			argv: ["close", worktree],
			cwd: fixture.repo,
			env: {
				...gitFixtureEnv(fixture.root),
				PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			} as NodeJS.ProcessEnv,
			gitExec,
			stdout: () => {},
			stderr: () => {},
		});

		expect(status).toBe(0);
		expect(nodeModulesPresentAtRemove).toBe(false);
	});
});

describe("pr-worktree CLI close rails", () => {
	// Recurrence: PR #3730 r1 S1 -- `close <main>` unlinked the MAIN checkout's
	// own node_modules symlink before git refused, emptying the shared install
	// path the whole tool exists to protect.
	it("refuses the main checkout and leaves its node_modules symlink untouched", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const result = runCliResult(fixture, ["close", fixture.repo]);
		expectLinkIntact(path.join(fixture.repo, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("main checkout");
		expect(fs.existsSync(path.join(fixture.repo, "README.md"))).toBe(true);
	});

	// Recurrence: PR #3730 r1 S1 -- any registered worktree anywhere (plegma,
	// .claude/worktrees) was closable; only trees under the review root are ours.
	it("refuses a registered worktree outside the worktrees root", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const elsewhere = path.join(fixture.root, "elsewhere", "o1");
		addLinkedWorktree(fixture, elsewhere, "pr-worktree/o1", shared);

		const result = runCliResult(fixture, ["close", elsewhere]);

		expectLinkIntact(path.join(elsewhere, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("outside");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			elsewhere,
		);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/o1"]),
		).toContain("pr-worktree/o1");
	});

	// Recurrence: PR #3730 r1 T2 -- the registration check was the only thing
	// stopping `close <any dir>` from unlinking that directory's node_modules
	// symlink, and deleting it left the suite green. The directory sits INSIDE
	// the root so no other rail can be what refuses it.
	it("refuses a directory that is not a registered worktree without unlinking", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const project = path.join(fixture.worktreesRoot, "someproject");
		fs.mkdirSync(project, { recursive: true });
		fs.symlinkSync(shared, path.join(project, "node_modules"));

		const result = runCliResult(fixture, ["close", project]);

		expectLinkIntact(path.join(project, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("not a registered worktree");
	});

	// Recurrence: PR #3730 r1 T3 -- a dirty tree had its node_modules unlinked
	// and THEN git refused, leaving a half-closed tree.
	it("refuses a dirty worktree before unlinking node_modules", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const worktree = path.join(fixture.worktreesRoot, "dirty-1");
		addLinkedWorktree(fixture, worktree, "pr-worktree/dirty-1", shared);
		fs.writeFileSync(path.join(worktree, "scratch.txt"), "uncommitted\n");

		const result = runCliResult(fixture, ["close", worktree]);

		expectLinkIntact(path.join(worktree, "node_modules"), shared);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/uncommitted|untracked/);
		expect(fs.existsSync(path.join(worktree, "scratch.txt"))).toBe(true);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/dirty-1"]),
		).toContain("pr-worktree/dirty-1");
	});

	// Recurrence: PR #3730 verify r2 R12 -- canonicalising the root and the
	// target was untested: a worktrees root reached through a symlink (macOS
	// /tmp, a linked ~/Desktop) must still accept its own trees.
	it("accepts a worktree reached through a symlinked worktrees root", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "sym-1");
		fixture.git(["worktree", "add", "-b", "pr-worktree/sym-1", worktree]);
		const linkRoot = path.join(fixture.root, "linked-root");
		fs.symlinkSync(fixture.worktreesRoot, linkRoot);

		const result = runCliResult(
			fixture,
			["close", path.join(linkRoot, "sym-1")],
			{ PI_LENS_WORKTREES_ROOT: linkRoot },
		);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	// Recurrence: PR #3730 r1 S2 -- a relative target resolved against the repo
	// toplevel, not the caller's cwd.
	it("resolves a relative close target against the caller's cwd", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "rel-1");
		fixture.git(["worktree", "add", "-b", "pr-worktree/rel-1", worktree]);
		const sub = path.join(fixture.repo, "sub");
		fs.mkdirSync(sub);

		const result = fixtureRun(fixture, ["close", "../../worktrees/rel-1"], {
			cwd: sub,
		});

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});
});

describe("pr-worktree CLI close branch safety", () => {
	function openPrOnly(fixture: Fixture, name: string): string {
		runCli(fixture, ["open", "9002", "--head", "--name", name], {
			PI_LENS_GH_JSON: PR_HEAD_JSON,
		});
		return path.join(fixture.worktreesRoot, name);
	}

	// Recurrence: PR #3730 r1 T3 -- `git branch -D` ran unconditionally, so a
	// trailing commit made in the tree became unreachable (fsck-only).
	it("keeps a branch holding a commit no remote has and prints a hint", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "trail-1");
		fs.writeFileSync(path.join(worktree, "fix.txt"), "trailing\n");
		fixture.git(["add", "fix.txt"], worktree);
		fixture.git(["commit", "-qm", "trailing commit"], worktree);
		const tip = fixture.git(["rev-parse", "HEAD"], worktree).trim();

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(result.stderr.join("\n")).toContain("pr-worktree/trail-1");
		expect(fixture.git(["rev-parse", "pr-worktree/trail-1"]).trim()).toBe(tip);
	});

	// The inverse: a PR head that only ever lived under refs/pull is NOT
	// "unpushed" -- keeping it would leave one stale branch per review.
	it("deletes the branch of an untouched PR-head tree", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "clean-1");
		expect(fixture.git(["rev-parse", "pr-worktree/clean-1"]).trim()).toBe(
			fixture.prOnlyHead,
		);

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/clean-1"]),
		).toThrow();
	});

	// Recurrence: the guard's own failure direction -- if git cannot say whether
	// commits are pushed, the branch must be KEPT (deleting is the irreversible
	// side), never treated as pushed.
	it("keeps the branch when it cannot tell whether commits are pushed", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "unsure-1");
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "rev-list") throw new Error("simulated rev-list failure");
			return fixtureGitExec(fixture)(args, options);
		};

		const result = fixtureRun(fixture, ["close", worktree], { gitExec });

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(fixture.git(["rev-parse", "pr-worktree/unsure-1"]).trim()).toBe(
			fixture.prOnlyHead,
		);
	});

	it("deletes the branch once its trailing commit is on a remote", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "pushed-1");
		fs.writeFileSync(path.join(worktree, "fix.txt"), "trailing\n");
		fixture.git(["add", "fix.txt"], worktree);
		fixture.git(["commit", "-qm", "trailing commit"], worktree);
		fixture.git(
			["push", "-q", "origin", "HEAD:refs/heads/pr9002-fix"],
			worktree,
		);

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/pushed-1"]),
		).toThrow();
	});
});

describe("pr-worktree CLI arguments and lookup", () => {
	it("rejects an unknown short flag instead of treating it as a commitish", () => {
		const fixture = makeFixture();
		const calls: string[][] = [];
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			calls.push(args);
			return fixtureGitExec(fixture)(args, options);
		};
		const result = fixtureRun(fixture, ["open", "9001", "-x"], { gitExec });
		expect(result.status).toBe(2);
		expect(result.stderr.join("\n")).toContain("unknown option -x");
		expect(calls.filter((args) => args[0] === "worktree")).toEqual([]);
	});

	// Recurrence: PR #3730 r1 S3 -- a numeric open always paid a `gh` round trip
	// (and its network failure mode) even when --merge or --name made the
	// headRefName unused.
	it("calls gh only when the head branch name is needed", () => {
		const fixture = makeFixture();
		const ghCalls: string[][] = [];
		const ghExec = (args: string[]) => {
			ghCalls.push(args);
			return PR_HEAD_JSON;
		};
		expect(
			fixtureRun(fixture, ["open", "9001", "--merge"], { ghExec }).status,
		).toBe(0);
		expect(
			fixtureRun(fixture, ["open", "9001", "--name", "named-1"], { ghExec })
				.status,
		).toBe(0);
		expect(ghCalls).toEqual([]);
		const result = fixtureRun(fixture, ["open", "9001", "--head"], { ghExec });
		expect(result.status).toBe(0);
		expect(ghCalls).toEqual([["pr", "view", "9001", "--json", "headRefName"]]);
	});
});

describe("pr-worktree CLI close detached HEAD", () => {
	// Recurrence: PR #3730 verify r2 residual -- close checked only the
	// `pr-worktree/<dir>` branch, so a commit made on a DETACHED HEAD inside the
	// tree (no ref) became unreachable (fsck: 3 objects) with no warning.
	function openDetached(fixture: Fixture, name: string): string {
		runCli(fixture, ["open", "9002", "--head", "--name", name], {
			PI_LENS_GH_JSON: PR_HEAD_JSON,
		});
		const worktree = path.join(fixture.worktreesRoot, name);
		fixture.git(["checkout", "-q", "--detach"], worktree);
		expectOpenLinkIntact(worktree);
		return worktree;
	}

	function unreachable(fixture: Fixture): string[] {
		return fixture
			.git(["fsck", "--unreachable", "--no-reflogs"])
			.split("\n")
			.filter((line) => line.startsWith("unreachable"));
	}

	it("refuses a detached-HEAD commit no remote has and leaves everything in place", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-1");
		fs.writeFileSync(path.join(worktree, "lost.txt"), "detached\n");
		fixture.git(["add", "lost.txt"], worktree);
		fixture.git(["commit", "-qm", "detached work"], worktree);

		const result = fixtureRun(fixture, ["close", worktree]);

		expectOpenLinkIntact(worktree);
		expect(result.status).toBe(1);
		const stderr = result.stderr.join("\n");
		expect(stderr).toContain("detached work");
		expect(stderr).toContain("git switch -c <name>");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			worktree,
		);
		expect(unreachable(fixture)).toEqual([]);
	});

	it("closes a detached tree that holds only the PR head it was opened at", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-2");

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	it("closes a detached tree whose commit is on a remote", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-3");
		fs.writeFileSync(path.join(worktree, "kept.txt"), "pushed\n");
		fixture.git(["add", "kept.txt"], worktree);
		fixture.git(["commit", "-qm", "pushed work"], worktree);
		fixture.git(["push", "-q", "origin", "HEAD:refs/heads/det-3"], worktree);

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	it("refuses a detached tree when git cannot list its commits", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-4");
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "rev-list" && args.includes("HEAD"))
				throw new Error("simulated rev-list failure");
			return fixtureGitExec(fixture)(args, options);
		};

		const result = fixtureRun(fixture, ["close", worktree], { gitExec });

		expectOpenLinkIntact(worktree);
		expect(result.status).toBe(1);
		expect(result.stderr.join("\n")).toContain("could not verify");
		expect(fs.existsSync(worktree)).toBe(true);
	});
});
