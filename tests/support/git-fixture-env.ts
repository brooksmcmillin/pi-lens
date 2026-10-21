import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";

type GitExecOptions = {
	cwd?: string;
	encoding?: BufferEncoding;
	stdio?: "ignore" | "pipe" | "inherit";
	env?: NodeJS.ProcessEnv;
	/** Piped to the child's stdin, e.g. feeding `git check-ignore --stdin`. */
	input?: string | Buffer;
};
type GitSpawnOptions = Parameters<
	typeof import("../../clients/safe-spawn.js").safeSpawnAsync
>[2];

const SCRUBBED_GIT_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_CONFIG_COUNT",
] as const;

// GIT_CONFIG_COUNT + GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> let a caller
// inject arbitrary config (including core.bare) without touching a config
// file at all. GIT_CONFIG_COUNT is a fixed name above; the indexed KEY/VALUE
// pair is unbounded, so it is scrubbed by pattern instead of by name.
const GIT_CONFIG_KV_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

// #4552: `git commit` calls `run_auto_maintenance`, which forks a DETACHED
// `git maintenance run --auto --quiet --detach` child. The child outlives the
// fixture cell and writes inside `.git` (maintenance.lock, packed-refs.lock,
// repack temp files) while the test's teardown removes the directory, so the
// gating Unit shard failed in `afterEach` teardown with ENOTEMPTY on the
// fixture `.git` instead of in an assertion. A fixture never needs background
// maintenance, so the global config every fixture Git process reads (below) is
// the checked-in policy that turns the auto hook and auto-gc off: no child is
// forked, and the writer cannot outlive the cell. A config FILE, not
// GIT_CONFIG_KEY_<n> in the environment: worker sandboxes refuse env- and
// argv-injected config keys, and a path is what the helper already owns.
const FIXTURE_GIT_CONFIG = path.resolve(
	import.meta.dirname,
	"../fixtures/git-fixture-global.gitconfig",
);

/**
 * Build the only environment a test fixture may use for a real Git process.
 *
 * The fixture directory no longer selects the global config: the global config
 * is the repo-level fixture policy (`tests/fixtures/git-fixture-global.gitconfig`),
 * identical for every fixture, because a worker sandbox refuses config injected
 * through `GIT_CONFIG_KEY_<n>` and a fixture never needs a writable global
 * config. The call sites keep passing the directory they own.
 */
export function gitFixtureEnv(_fixtureDir: string): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	return scrubGitFixtureEnv(env);
}

function scrubGitFixtureEnv(base: NodeJS.ProcessEnv): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(base).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	for (const variable of SCRUBBED_GIT_VARIABLES) delete env[variable];
	for (const key of Object.keys(env))
		if (GIT_CONFIG_KV_PATTERN.test(key)) delete env[key];
	// These are fixture policy, not caller overrides. The harness itself may
	// already be contaminated, so delete inherited values before setting them:
	// the checked-in policy file carries the fixture's Git policy (#4552).
	env.GIT_CONFIG_GLOBAL = FIXTURE_GIT_CONFIG;
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

function gitFixtureEnvWithOverrides(
	fixtureDir: string,
	overrides: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
	return scrubGitFixtureEnv({
		...gitFixtureEnv(fixtureDir),
		...overrides,
	});
}

/** Install fixture isolation for production Git probes launched by a test. */
export function installGitFixtureEnv(fixtureDir: string): void {
	const env = gitFixtureEnv(fixtureDir);
	for (const variable of SCRUBBED_GIT_VARIABLES) delete process.env[variable];
	for (const key of Object.keys(process.env))
		if (GIT_CONFIG_KV_PATTERN.test(key)) delete process.env[key];
	Object.assign(process.env, env);
}

export function gitExecFileSync(
	command: string,
	args: string[],
	options: GitExecOptions & { encoding: BufferEncoding },
): string;
export function gitExecFileSync(
	command: string,
	args: string[],
	options?: GitExecOptions,
): Buffer | string;
export function gitExecFileSync(
	command: string,
	args: string[],
	options: GitExecOptions = {},
): Buffer | string {
	return execFileSync(command, args, {
		...options,
		env: gitFixtureEnvWithOverrides(options.cwd ?? process.cwd(), options.env),
	});
}

/** Run a shell-shaped Git fixture command without inheriting Git state. */
export function gitExecSync(
	command: string,
	options: GitExecOptions & { encoding: BufferEncoding },
): string;
export function gitExecSync(
	command: string,
	options?: GitExecOptions,
): Buffer | string;
export function gitExecSync(
	command: string,
	options: GitExecOptions = {},
): Buffer | string {
	return execSync(command, {
		...options,
		env: gitFixtureEnvWithOverrides(options.cwd ?? process.cwd(), options.env),
	});
}

export function hasGit(fixtureDir = process.cwd()): boolean {
	try {
		gitExecFileSync("git", ["--version"], { cwd: fixtureDir, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export { gitExecFileSync as execFileSync, gitExecSync as execSync };

export function gitFixtureSpawnAsync(
	fixtureDir: string,
	args: string[],
	options: GitSpawnOptions = {},
): ReturnType<typeof import("../../clients/safe-spawn.js").safeSpawnAsync> {
	return import("../../clients/safe-spawn.js").then(({ safeSpawnAsync }) =>
		safeSpawnAsync("git", args, {
			...options,
			cwd: options.cwd ?? fixtureDir,
			env: gitFixtureEnvWithOverrides(fixtureDir, options.env),
		}),
	);
}
