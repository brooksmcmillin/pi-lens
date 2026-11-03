// flake-shape: real-process-spawn — the claim is what a spawned child reads in its environment and what a real git does to .git/index; a stub sees neither.
/**
 * #4930: pi-lens's background `git status` reads must never take
 * `.git/index.lock`. `git status` refreshes a stat-dirty index and writes it back
 * under that lock; a read killed by pi-lens's own timeout (SIGKILL) or by host
 * exit orphans it, and the user's next `git add` fails. The spawn seam
 * (`getSpawnEnvironment`) defaults `GIT_OPTIONAL_LOCKS=0` so no caller has to.
 *
 * The lock lives about 40 ms, so the real-git witness does not try to catch it.
 * It asserts the effect the lock exists for: a stat-dirty index is not
 * rewritten (same inode, mtime and bytes) when status runs through the seam.
 *
 * Precedence (stated, tested below): a caller `env` override wins; an ambient
 * `process.env.GIT_OPTIONAL_LOCKS` does not, because the guarantee is that
 * pi-lens never takes the lock, and an exported `1` in the user's shell would
 * silently void it for every background read.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	captureGitDirtyPaths,
	recoverOpaqueChangesViaGit,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { safeSpawn, safeSpawnAsync } from "../../clients/safe-spawn.js";
import { probeWorkingTreeState } from "../../clients/shared-checkout-guard.js";
import {
	execFileSync,
	gitFixtureSpawnAsync,
} from "../support/git-fixture-env.js";
import { removeTempDirSync } from "./test-utils.js";

const PRINT_OPTIONAL_LOCKS = [
	"-e",
	"process.stdout.write(String(process.env.GIT_OPTIONAL_LOCKS))",
];

let savedAmbient: string | undefined;

beforeEach(() => {
	savedAmbient = process.env.GIT_OPTIONAL_LOCKS;
	delete process.env.GIT_OPTIONAL_LOCKS;
});

afterEach(() => {
	if (savedAmbient === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
	else process.env.GIT_OPTIONAL_LOCKS = savedAmbient;
});

describe("the spawn seam defaults GIT_OPTIONAL_LOCKS=0 (#4930)", () => {
	const seams: Array<
		[string, (env?: NodeJS.ProcessEnv) => Promise<string | undefined>]
	> = [
		[
			"safeSpawnAsync",
			async (env) =>
				(
					await safeSpawnAsync(process.execPath, PRINT_OPTIONAL_LOCKS, {
						timeout: 10_000,
						env,
					})
				).stdout,
		],
		[
			"safeSpawn",
			async (env) =>
				safeSpawn(process.execPath, PRINT_OPTIONAL_LOCKS, {
					timeout: 10_000,
					env,
				}).stdout,
		],
	];

	describe.each(seams)("%s", (_name, run) => {
		it("hands the child GIT_OPTIONAL_LOCKS=0 when nobody set it", async () => {
			expect(await run()).toBe("0");
		});

		it("lets a caller env override win", async () => {
			expect(await run({ GIT_OPTIONAL_LOCKS: "1" })).toBe("1");
		});

		it("does not let an ambient GIT_OPTIONAL_LOCKS=1 void the default", async () => {
			process.env.GIT_OPTIONAL_LOCKS = "1";
			expect(await run()).toBe("0");
		});
	});
});

describe("git status through the seam leaves a stat-dirty index alone (#4930)", () => {
	let repo = "";

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-optlocks-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "t@t.local");
		git("config", "user.name", "t");
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			fs.writeFileSync(path.join(repo, name), `${name}\n`, "utf8");
		}
		git("add", "-A");
		git("commit", "-qm", "base");
		// Same bytes, older mtime: every entry is stat-dirty against the index, so
		// an unrestricted `git status` refreshes it and writes it back.
		const past = new Date(Date.now() - 60_000);
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			fs.utimesSync(path.join(repo, name), past, past);
		}
	});

	afterEach(() => removeTempDirSync(repo));

	function indexWitness(): { ino: number; mtimeMs: number; sha: string } {
		const file = path.join(repo, ".git", "index");
		const stat = fs.statSync(file);
		return {
			ino: stat.ino,
			mtimeMs: stat.mtimeMs,
			sha: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
		};
	}

	it("is a live witness: with optional locks on, status rewrites the index", async () => {
		const before = indexWitness();
		const result = await gitFixtureSpawnAsync(repo, ["status", "--porcelain"], {
			timeout: 20_000,
			env: { GIT_OPTIONAL_LOCKS: "1" },
		});
		expect(result.status).toBe(0);
		expect(indexWitness()).not.toEqual(before);
	});

	it("safeSpawnAsync git status does not rewrite the index", async () => {
		const before = indexWitness();
		const result = await gitFixtureSpawnAsync(repo, ["status", "--porcelain"], {
			timeout: 20_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(indexWitness()).toEqual(before);
		expect(fs.existsSync(path.join(repo, ".git", "index.lock"))).toBe(false);
	});

	it("captureGitDirtyPaths (readGitStatusEntries) does not rewrite the index", async () => {
		const before = indexWitness();
		await expect(captureGitDirtyPaths(repo)).resolves.toEqual([]);
		expect(indexWitness()).toEqual(before);
	});

	it("probeWorkingTreeState (shared-checkout probe) does not rewrite the index", async () => {
		const before = indexWitness();
		await expect(probeWorkingTreeState(repo)).resolves.toBe("clean");
		expect(indexWitness()).toEqual(before);
	});

	it("keeps modified, untracked and staged entries in the status reads", async () => {
		const startedAt = Date.now() - 1000;
		fs.writeFileSync(path.join(repo, "a.ts"), "modified\n", "utf8");
		fs.writeFileSync(path.join(repo, "untracked.ts"), "untracked\n", "utf8");
		fs.writeFileSync(path.join(repo, "staged.ts"), "staged\n", "utf8");
		execFileSync("git", ["add", "staged.ts"], { cwd: repo });

		const expected = ["a.ts", "untracked.ts", "staged.ts"]
			.map((name) => normalizeMapKey(path.join(repo, name)))
			.sort();

		const dirty = await captureGitDirtyPaths(repo);
		expect([...(dirty ?? [])].sort()).toEqual(expected);

		const recovered = await recoverOpaqueChangesViaGit(repo, startedAt);
		expect(recovered.verdict).toBe("recovered");
		expect([...recovered.paths].sort()).toEqual(expected);
	});
});
