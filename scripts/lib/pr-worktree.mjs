/**
 * scripts/lib/pr-worktree.mjs (#3723)
 *
 * PURE planning for scripts/pr-worktree.mjs: which worktree an `open` names,
 * where it lands, which ref it creates, and what a `close` is allowed to
 * remove. Split from the CLI (which owns `git`, the `gh` lookup, and the
 * filesystem) for the same reason scripts/lib/worktree-hygiene.mjs was split
 * from the prune CLI: the RISKY part is the close decision, and a decision is
 * only testable if it is a function of a table rather than of the machine.
 * Nothing in this file touches a filesystem or spawns a process.
 *
 * The close rail is the #3173 / #2704 class. `git worktree remove` on a tree
 * whose `node_modules` is a symlink into the shared checkout follows the link
 * on the platforms where it bites and empties the SHARED install, not just
 * this worktree's copy -- so `close` unlinks the symlink itself first and
 * refuses outright when `node_modules` is a real directory. The link TARGET
 * is never read, written, or removed here.
 *
 * `open` creates a local branch under {@link WORKTREE_BRANCH_PREFIX} at the
 * fetched commit, so a trailing commit can be made from the tree, and `close`
 * deletes exactly that branch. A branch the caller already owned is checked
 * out as-is and left alone.
 */

import { basename, join, relative as pathRelative, sep } from "node:path";

/** Namespace of the local branches this tool creates and may delete. */
export const WORKTREE_BRANCH_PREFIX = "pr-worktree/";

/**
 * Turn a PR head ref, branch, or arbitrary `--name` into a filesystem- and
 * ref-safe slug. GitHub branch names may contain `/`; a worktree directory
 * cannot be created through a nonexistent nested parent, and a ref with `..`
 * is invalid, so both are folded to `-` here.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function slugifyWorktreeName(value) {
	const slug = String(value ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return slug === "" ? "worktree" : slug;
}

/**
 * A `--name` becomes a path segment under the worktrees root, so it must not
 * contain a separator, a traversal segment, or a leading dot. Slugs from
 * {@link slugifyWorktreeName} always satisfy this; a caller-supplied `--name`
 * is validated rather than silently rewritten.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidWorktreeName(value) {
	if (typeof value !== "string" || value === "") return false;
	if (value === "." || value === "..") return false;
	if (value.includes("..")) return false;
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * @typedef {object} OpenPlan
 * @property {true} ok
 * @property {string} name
 * @property {string} path
 * @property {"head"|"merge"|"branch"} mode
 * @property {string|null} branch       local branch to create, or null
 * @property {string} commitish
 * @property {string|null} fetchRefspec
 */

/**
 * Decide the worktree `open` will create. `prHead` is the already-resolved
 * `gh pr view --json headRefName,...` object (the CLI owns that lookup).
 *
 * @param {{ target: string, mode: string|null, name?: string|null,
 *   worktreesRoot: string, prHead?: { headRefName?: string|null }|null }} input
 * @returns {OpenPlan|{ ok: false, error: string }}
 */
export function deriveOpenPlan({
	target,
	mode,
	name = null,
	worktreesRoot,
	prHead = null,
}) {
	const numeric = /^\d+$/.test(target);
	if (!numeric && mode === "merge") {
		return {
			ok: false,
			error: "--merge applies to a PR number, not a branch name",
		};
	}
	let resolvedMode = "branch";
	if (numeric) resolvedMode = mode === "merge" ? "merge" : "head";
	let resolvedName;
	if (name != null && name !== "") resolvedName = name;
	else if (numeric && resolvedMode === "merge")
		resolvedName = `pr-${target}-merge`;
	else if (numeric)
		resolvedName = `pr-${target}-${slugifyWorktreeName(prHead?.headRefName ?? "head")}`;
	else resolvedName = slugifyWorktreeName(target);
	if (!isValidWorktreeName(resolvedName)) {
		return {
			ok: false,
			error: `invalid worktree name ${JSON.stringify(resolvedName)}`,
		};
	}
	const worktreePath = join(worktreesRoot, resolvedName);
	if (!numeric) {
		return {
			ok: true,
			name: resolvedName,
			path: worktreePath,
			mode: "branch",
			branch: null,
			commitish: target,
			fetchRefspec: null,
		};
	}
	return {
		ok: true,
		name: resolvedName,
		path: worktreePath,
		mode: resolvedMode,
		branch: `${WORKTREE_BRANCH_PREFIX}${resolvedName}`,
		commitish: "FETCH_HEAD",
		fetchRefspec: `pull/${target}/${resolvedMode === "merge" ? "merge" : "head"}`,
	};
}

/**
 * Classify a `lstat` result for `<worktree>/node_modules`. A `null` entry is
 * missing; anything that is neither a symlink nor a directory is "other" and
 * is left in place (only a symlink is ever unlinked).
 *
 * @param {{ isSymbolicLink?: () => boolean, isDirectory?: () => boolean }|null|undefined} entry
 * @returns {"missing"|"symlink"|"directory"|"other"}
 */
export function classifyNodeModules(entry) {
	if (!entry) return "missing";
	if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink())
		return "symlink";
	if (typeof entry.isDirectory === "function" && entry.isDirectory())
		return "directory";
	return "other";
}

/**
 * The branch `open` creates for a worktree, derived from the worktree's final
 * path segment so `close <path>` can find and delete exactly it.
 *
 * @param {string} worktreePath
 * @returns {string}
 */
export function worktreeBranchName(worktreePath) {
	return `${WORKTREE_BRANCH_PREFIX}${basename(worktreePath)}`;
}

/**
 * Decide what `close` may remove. Every fact is gathered by the CLI BEFORE
 * this runs and every refusal here happens BEFORE the CLI unlinks anything, so
 * a refused close never leaves a half-closed tree (#3730 r1 S1/T2/T3).
 *
 * The rails, in order: the path must be a registered worktree (`registered`),
 * must not be the main checkout (`mainRoot`), must sit inside the review
 * root (`worktreesRoot`), and must be clean (`dirty`); `nodeModulesKind` comes
 * from {@link classifyNodeModules} and a real directory is a refusal -- never
 * `rm -rf` -- so the shared install cannot be deleted through a copied tree.
 * `branchUnpushed` keeps the local branch when it holds commits no remote has.
 * A DETACHED HEAD has no branch to keep, so its unpushed commits
 * (`detachedCommits`, oneline) refuse the close instead, and a HEAD that could
 * not be read (`detachedCheckFailed`) refuses too (fail closed).
 * Paths are expected canonical (the CLI realpaths them).
 *
 * @param {{ worktreePath: string, worktreesRoot: string, mainRoot: string|null,
 *   registered: boolean, dirty: boolean, detachedCommits: string[],
 *   detachedCheckFailed: boolean,
 *   nodeModulesKind: "missing"|"symlink"|"directory"|"other",
 *   branchExists: boolean, branchUnpushed: boolean }} input
 * @returns {{ ok: true, unlinkNodeModules: boolean, branchToDelete: string|null,
 *   branchKept: string|null }|{ ok: false, code: number, error: string }}
 */
export function deriveClosePlan({
	worktreePath,
	worktreesRoot,
	mainRoot,
	registered,
	dirty,
	detachedCommits,
	detachedCheckFailed,
	nodeModulesKind,
	branchExists,
	branchUnpushed,
}) {
	if (!registered) {
		return {
			ok: false,
			code: 2,
			error: `not a registered worktree: ${worktreePath}`,
		};
	}
	if (worktreePath === mainRoot) {
		return {
			ok: false,
			code: 2,
			error: `refusing to close the main checkout: ${worktreePath}`,
		};
	}
	const relative = pathRelative(worktreesRoot, worktreePath);
	if (relative === "" || relative === ".." || relative.startsWith(`..${sep}`)) {
		return {
			ok: false,
			code: 2,
			error: `refusing ${worktreePath}: outside the worktrees root ${worktreesRoot}`,
		};
	}
	if (dirty) {
		return {
			ok: false,
			code: 1,
			error: `refusing ${worktreePath}: uncommitted or untracked changes; commit or discard them first`,
		};
	}
	if (detachedCheckFailed) {
		return {
			ok: false,
			code: 1,
			error: `refusing ${worktreePath}: could not verify that its detached HEAD holds no unpushed commits`,
		};
	}
	if (detachedCommits.length > 0) {
		return {
			ok: false,
			code: 1,
			error:
				`refusing ${worktreePath}: detached HEAD holds commits no remote has:\n` +
				`${detachedCommits.join("\n")}\n` +
				"keep them with `git switch -c <name>` inside the tree, or push them",
		};
	}
	if (nodeModulesKind === "directory") {
		return {
			ok: false,
			code: 1,
			error:
				`refusing to remove ${worktreePath}: node_modules is a real directory, ` +
				"not a symlink -- remove only that worktree copy after confirming the shared install is intact",
		};
	}
	const branch = worktreeBranchName(worktreePath);
	const keep = branchExists && branchUnpushed;
	return {
		ok: true,
		unlinkNodeModules: nodeModulesKind === "symlink",
		branchToDelete: branchExists && !branchUnpushed ? branch : null,
		branchKept: keep
			? `kept branch ${branch}: it has commits no remote has (push it, or delete it with git branch -D ${branch})`
			: null,
	};
}
