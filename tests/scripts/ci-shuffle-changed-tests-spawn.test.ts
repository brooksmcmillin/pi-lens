// flake-shape: real-process-spawn — the subject is the job's own process
// contract: the real CLI starts the real vitest with `--sequence.shuffle` and a
// fixed seed over a real fixture project, and the exit code is what the CI step
// reads. An injected exec would restate the flags the script builds instead of
// proving vitest reorders the cases and reds the file that shares state.
//
// The git case (#4456): the step's default diff and added lists are real `git
// diff` calls (`--name-only`, `--diff-filter=A`) run where `--cwd` points. The
// flag's meaning (add vs modify vs rename) is git's, so a double would restate
// it; only a throwaway repo shows the default wiring orders the added file
// first.
// lane: wall-clock-budget (serialized); no wall-clock assertion, three short
// vitest starts over two-file fixtures and one throwaway-repo git diff.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execVitest, run } from "../../scripts/ci-shuffle-changed-tests.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

const SCRIPT = path.resolve("scripts/ci-shuffle-changed-tests.mjs");
const env = setupTestEnvironment("pi-lens-4397-fixture-");

/**
 * The ambient VITEST_* variables belong to the OUTER worker; a nested vitest
 * that inherits them takes itself for a worker of the outer run.
 */
function nestedEnv(): NodeJS.ProcessEnv {
	const clean: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(clean))
		if (key.startsWith("VITEST") || key === "TEST") delete clean[key];
	return clean;
}

function runJob(files: string[]) {
	const clean = nestedEnv();
	const result = spawnSync(
		process.execPath,
		[SCRIPT, "--cwd", env.tmpDir, "--files", files.join(",")],
		{ encoding: "utf8", timeout: 120_000, env: clean },
	);
	return {
		status: result.status,
		out: `${result.stdout}${result.stderr}`,
	};
}

beforeAll(() => {
	fs.mkdirSync(path.join(env.tmpDir, "tests"));
	// A project of its own: no repo lane config, no node_modules. `globals`
	// keeps the fixtures free of imports.
	fs.writeFileSync(
		path.join(env.tmpDir, "vitest.config.mjs"),
		'export default { test: { globals: true, include: ["tests/**/*.test.ts"] } };\n',
	);
	// The shape #4390 and #4391 shipped: each case needs the one before it, so
	// file order passes and any other order reds. Six cases leave about one
	// chance in 720 per seed that a shuffle keeps the order.
	fs.writeFileSync(
		path.join(env.tmpDir, "tests", "chain.test.ts"),
		[
			"let step = 0;",
			"for (const n of [1, 2, 3, 4, 5, 6]) {",
			"  it(`step ${n}`, () => {",
			"    expect(step).toBe(n - 1);",
			"    step = n;",
			"  });",
			"}",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(env.tmpDir, "tests", "slow.test.ts"),
		'it("outlasts the budget", async () => { await new Promise((r) => setTimeout(r, 30000)); }, 60000);\n',
	);
	fs.writeFileSync(
		path.join(env.tmpDir, "tests", "stateless.test.ts"),
		"for (const n of [1, 2, 3, 4, 5, 6]) it(`case ${n}`, () => expect(n).toBeGreaterThan(0));\n",
	);
});

afterAll(() => env.cleanup());

describe("the changed-test shuffle job over a real vitest (#4397)", () => {
	// Recurrence: #4390's mixed-reason case and #4391's spawn file, both green in
	// file order and red when reordered, merged because nothing reordered them.
	// Red under BOTH seeds, and the file in file order alone stays green: the
	// job reds on the order, not on the file.
	it("reds a file whose cases share state, under each seed, and names the repro", () => {
		const result = runJob(["tests/chain.test.ts"]);
		expect(result.status).toBe(1);
		expect(result.out).toContain("shuffle seed 202: red");
		expect(result.out).toContain("shuffle seed 424: red");
		expect(result.out).toContain("alone tests/chain.test.ts: ok");
		expect(result.out).toContain(
			"reproduce: npx vitest run tests/chain.test.ts --sequence.shuffle --sequence.seed=202",
		);
		expect(result.out).toContain("shuffle-changed: exit 1 (red)");
	}, 130_000);

	// Recurrence: a job that reds every file. A file with no shared state is
	// green alone and under both seeds, and the job exits 0.
	it("passes a file with no shared state", () => {
		const result = runJob(["tests/stateless.test.ts"]);
		expect(result.out).toContain("shuffle seed 202: ok");
		expect(result.out).toContain("shuffle seed 424: ok");
		expect(result.out).toContain("alone tests/stateless.test.ts: ok");
		expect(result.out).toContain("shuffle-changed: exit 0 (clean)");
		expect(result.status).toBe(0);
	}, 130_000);

	// Recurrence (review F3): a start killed at the budget read as a finished
	// run when the kill was not recognised. The real kill, not an injected
	// flag: spawnSync reports it as ETIMEDOUT or a SIGKILL signal.
	it("reports a start that outlasts its timeout as timed out", () => {
		const outcome = execVitest(
			{ files: ["tests/slow.test.ts"], flags: [] },
			{ cwd: env.tmpDir, timeoutMs: 2500, env: nestedEnv() },
		);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.status).toBeNull();
	}, 60_000);

	// Recurrence (#4456 r1 F1): the step's DEFAULT added list
	// (`changedFiles(range, { diffFilter: "A" })`) had no test; a renamed option
	// key survived, and a dropped filter makes `added` every changed file so the
	// added-first order silently degrades. Drives run() with the default diff
	// and added lists over a real repo: add, modify, and a pure rename.
	it("orders the file a real git range adds first, through the default diff and added lists", () => {
		const repo = path.join(env.tmpDir, "repo");
		fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
		const git = (...args: string[]) =>
			gitExecFileSync(
				"git",
				[
					"-c",
					"user.name=fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd: repo, encoding: "utf8", stdio: "pipe" },
			);
		const write = (name: string, text: string) =>
			fs.writeFileSync(path.join(repo, "tests", name), text);
		git("init", "-q", "-b", "main");
		write("mod.test.ts", "// one\n".repeat(20));
		write("old.test.ts", "// renamed content\n".repeat(20));
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const base = git("rev-parse", "HEAD").trim();
		write("mod.test.ts", "// one\n".repeat(20) + "// edited\n");
		write("zzz-new.test.ts", "// brand new\n".repeat(20));
		git("mv", "tests/old.test.ts", "tests/renamed.test.ts");
		git("add", "-A");
		git("commit", "-q", "-m", "head");
		const head = git("rev-parse", "HEAD").trim();
		const starts: string[][] = [];
		const lines: string[] = [];
		// The run's own env reaches git: no ambient GIT_* from an outer hook, and
		// no GITHUB_STEP_SUMMARY write from the CI job running this test.
		const fixtureEnv: NodeJS.ProcessEnv = { ...gitFixtureEnv(repo) };
		delete fixtureEnv.GITHUB_STEP_SUMMARY;
		const code = run(["--cwd", repo, "--base", base, "--head", head], {
			env: fixtureEnv,
			exec: (startRun) => {
				starts.push([...startRun.files, ...startRun.flags]);
				return { status: 0, output: "", timedOut: false };
			},
			log: (line) => lines.push(line),
		});
		expect(code).toBe(0);
		// The run's env is the one git sees: a GIT_DIR that is not a repo makes
		// the diff unreadable, which is exit 3 and no start.
		const blind: string[] = [];
		expect(
			run(["--cwd", repo, "--base", base, "--head", head], {
				env: { ...fixtureEnv, GIT_DIR: path.join(repo, "not-a-git-dir") },
				exec: () => {
					blind.push("started");
					return { status: 0, output: "", timedOut: false };
				},
				log: () => {},
			}),
		).toBe(3);
		expect(blind).toEqual([]);
		// A rename is modified: it sorts with the edited file, after the add.
		expect(starts.map((entry) => entry.join(" "))).toEqual([
			"tests/zzz-new.test.ts",
			"tests/zzz-new.test.ts tests/mod.test.ts tests/renamed.test.ts --sequence.shuffle --sequence.seed=202",
			"tests/zzz-new.test.ts tests/mod.test.ts tests/renamed.test.ts --sequence.shuffle --sequence.seed=424",
			"tests/mod.test.ts",
			"tests/renamed.test.ts",
		]);
	}, 60_000);
});
