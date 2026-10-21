import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The two files a relocated copy of the fixture Git seam needs, kept at their
 * repository-relative positions (#4552 review R2).
 */
const FILES = [
	path.join("scripts", "lib", "git-fixture-env.mjs"),
	path.join("tests", "fixtures", "git-fixture-global.gitconfig"),
] as const;

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Copy the fixture Git helper AND its background-maintenance policy into
 * `destRoot`.
 *
 * `scripts/lib/git-fixture-env.mjs` resolves `GIT_CONFIG_GLOBAL` relative to
 * its OWN module, so a copy of the helper alone looks for
 * `<destRoot>/tests/fixtures/git-fixture-global.gitconfig`, which the copy does
 * not have. Git then silently falls back to `maintenance.auto`, and a fixture
 * `git commit` or `git fetch` forks the DETACHED `git maintenance run --auto
 * --detach` child that outlives its cell and races teardown (#4552). The
 * helper now refuses to build an environment without the policy file, so a
 * copy that forgets this function fails loudly instead of quietly
 * de-policing every fixture Git spawn in the copy.
 */
export function copyFixtureGitHelper(destRoot: string): void {
	for (const relative of FILES) {
		const target = path.join(destRoot, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(REPO_ROOT, relative), target);
	}
}
