// #4397: scripts/ci-shuffle-changed-tests.mjs runs the test files a PR adds or
// changes alone and under two fixed shuffle seeds. Every case names the
// recurrence it keeps out. The vitest start is the only process boundary and
// is injected here; the real start is `ci-shuffle-changed-tests-spawn.test.ts`.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	BUDGET_MS,
	judge,
	parseArgs,
	planRuns,
	reproCommand,
	run,
	runPlan,
	SEEDS,
	selectChangedTestFiles,
	type ExecOutcome,
	type ExecVitest,
} from "../../scripts/ci-shuffle-changed-tests.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

interface BudgetRow {
	seedSeconds: number[];
	aloneSeconds: number[];
	unfinished: Array<{ start: string; atLeastSeconds: number }>;
}
const budgetMeasurements = JSON.parse(
	fs.readFileSync(
		path.resolve("tests/support/shuffle-changed-budget-measurements.json"),
		"utf8",
	),
) as { runs: BudgetRow[] };

const OK: ExecOutcome = { status: 0, output: "", timedOut: false };
const RED: ExecOutcome = { status: 1, output: "FAIL x", timedOut: false };

/** An exec double that answers by seed flag or first file and records the starts. */
function execBy(
	answers: Record<string, ExecOutcome>,
): ExecVitest & { starts: string[][] } {
	const starts: string[][] = [];
	const exec: ExecVitest = (startRun) => {
		starts.push([...startRun.files, ...startRun.flags]);
		const seed = startRun.flags.find((flag) =>
			flag.startsWith("--sequence.seed="),
		);
		return answers[seed ?? startRun.files[0]] ?? OK;
	};
	return Object.assign(exec, { starts });
}

const quiet = () => {};

describe("selectChangedTestFiles", () => {
	// Recurrence: the job running a changed non-test file or a deleted test,
	// which vitest answers with "No test files found" and a false red.
	it("keeps existing tests/**/*.test.ts, sorted and unique", () => {
		const exists = (file: string) => file !== "tests/gone.test.ts";
		expect(
			selectChangedTestFiles(
				[
					"tests/z.test.ts",
					"tests/a/b.test.ts",
					"tests/z.test.ts",
					"clients/x.ts",
					"tests/support/helper.ts",
					"tests/gone.test.ts",
					"scripts/foo.mjs",
				],
				exists,
			),
		).toEqual(["tests/a/b.test.ts", "tests/z.test.ts"]);
	});

	// Recurrence: vitest.config.ts `sharedExclude` drops tests/fixtures/** (a
	// fixture project's own *.test.ts); handing one over reds with "No test
	// files found" on every PR that edits a fixture.
	it("drops tests/fixtures/** that vitest never collects", () => {
		expect(
			selectChangedTestFiles(["tests/fixtures/proj/a.test.ts"], () => true),
		).toEqual([]);
	});
});

describe("planRuns", () => {
	// Recurrence: a seed list edited to one value, or reshuffled per run, leaves
	// a red that cannot be reproduced and an order-dependent file that one seed
	// happens to pass.
	it("runs the whole set once per fixed seed, then each file alone", () => {
		const plan = planRuns(["tests/a.test.ts", "tests/b.test.ts"]);
		expect(SEEDS).toEqual([202, 424]);
		expect(plan.map((entry) => entry.label)).toEqual([
			"shuffle seed 202",
			"shuffle seed 424",
			"alone tests/a.test.ts",
			"alone tests/b.test.ts",
		]);
		expect(plan[0]).toEqual({
			label: "shuffle seed 202",
			files: ["tests/a.test.ts", "tests/b.test.ts"],
			flags: ["--sequence.shuffle", "--sequence.seed=202"],
		});
		expect(plan[2].flags).toEqual([]);
		expect(plan[2].files).toEqual(["tests/a.test.ts"]);
	});

	// Recurrence: a copy of the lane settings in this script (maxWorkers,
	// groupOrder, --project) drifting from vitest.config.ts, the #1022/#2332
	// contention class. The only flags are the order ones; file paths alone
	// route a file to its lane project.
	it("passes no lane setting, only paths and the order flags", () => {
		for (const entry of planRuns(["tests/tools/lsp-diagnostics-x.test.ts"])) {
			expect(
				entry.flags.filter(
					(flag) =>
						flag !== "--sequence.shuffle" &&
						!flag.startsWith("--sequence.seed="),
				),
			).toEqual([]);
		}
	});

	it("prints a command that reproduces the run", () => {
		expect(reproCommand(planRuns(["tests/a.test.ts"])[0])).toBe(
			"npx vitest run tests/a.test.ts --sequence.shuffle --sequence.seed=202",
		);
		expect(reproCommand(planRuns(["tests/a.test.ts"])[2])).toBe(
			"npx vitest run tests/a.test.ts",
		);
	});
});

describe("runPlan", () => {
	// Recurrence: a red hidden in the middle of a log; the tail and the repro
	// line are what the PR author acts on.
	it("reports a red start with its output tail and the repro command", () => {
		const lines: string[] = [];
		const plan = planRuns(["tests/a.test.ts"]);
		const { results } = runPlan(plan, {
			cwd: ".",
			exec: execBy({
				"--sequence.seed=424": { ...RED, output: "boom\nFAIL step 2" },
			}),
			log: (line) => lines.push(line),
		});
		expect(results.map((entry) => entry.verdict)).toEqual(["ok", "red", "ok"]);
		const text = lines.join("\n");
		expect(text).toContain("FAIL step 2");
		expect(text).toContain(
			"reproduce: npx vitest run tests/a.test.ts --sequence.shuffle --sequence.seed=424",
		);
	});

	// Recurrence: an unbounded job. A start is bounded by what is left of the
	// budget and no start begins once it is spent.
	it("bounds every start by the remaining budget and stops starting at zero", () => {
		let clock = 0;
		const timeouts: number[] = [];
		const exec: ExecVitest = (_run, { timeoutMs }) => {
			timeouts.push(timeoutMs);
			clock += 40;
			return OK;
		};
		const { results, notRun } = runPlan(planRuns(["tests/a.test.ts"]), {
			cwd: ".",
			budgetMs: 100,
			exec,
			now: () => clock,
			log: quiet,
		});
		expect(timeouts).toEqual([100, 60, 20]);
		expect(results).toHaveLength(3);
		expect(notRun).toEqual([]);

		clock = 0;
		timeouts.length = 0;
		const second = runPlan(planRuns(["tests/a.test.ts", "tests/b.test.ts"]), {
			cwd: ".",
			budgetMs: 100,
			exec,
			now: () => clock,
			log: quiet,
		});
		expect(second.results).toHaveLength(3);
		expect(second.notRun.map((entry) => entry.label)).toEqual([
			"alone tests/b.test.ts",
		]);
	});

	// Recurrence: vitest answering "No test files found" for a path no project
	// collects reading as an order-dependent file.
	it("does not read an uncollected path as a red", () => {
		const { results } = runPlan(planRuns(["tests/a.test.ts"]).slice(0, 1), {
			cwd: ".",
			exec: () => ({
				status: 1,
				output: "No test files found, exiting with code 1",
				timedOut: false,
			}),
			log: quiet,
		});
		expect(results[0].verdict).toBe("uncollected");
	});
});

describe("runPlan: output and timeout classification (#4397 review r1)", () => {
	// Recurrence (F2): the phrase matched anywhere in the output, so a real red
	// whose failure text quotes it (this file's own assertions do) read as
	// "uncollected" and the job exited 0. Only vitest's own line, at a line
	// start, names an uncollected path.
	it("reads a real red that quotes the phrase mid-line as a red", () => {
		const { results } = runPlan(planRuns(["tests/a.test.ts"]).slice(0, 1), {
			cwd: ".",
			exec: () => ({
				status: 1,
				output:
					"FAIL step 2\nAssertionError: expected 'No test files found, exiting' to be empty\n",
				timedOut: false,
			}),
			log: quiet,
		});
		expect(results[0].verdict).toBe("red");
	});

	// Recurrence (F2): a changed file no project collects (tests/native-ts7-live-*
	// is in sharedExclude) ran nothing and still exited 0 "clean". Nothing ran,
	// so nothing is proven: exit 3 with a line naming the start.
	it("exits 3, not 0, when no project collects a changed file", () => {
		const lines: string[] = [];
		const exec: ExecVitest = () => ({
			status: 1,
			output: "\nNo test files found, exiting with code 1\n",
			timedOut: false,
		});
		const scratch = setupTestEnvironment("pi-lens-4397-uncollected-");
		cleanups.push(scratch.cleanup);
		fs.mkdirSync(path.join(scratch.tmpDir, "tests", "native-ts7-live-x"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(scratch.tmpDir, "tests/native-ts7-live-x/a.test.ts"),
			"",
		);
		const code = run(
			["--cwd", scratch.tmpDir, "--files", "tests/native-ts7-live-x/a.test.ts"],
			{ exec, log: (line) => lines.push(line) },
		);
		expect(code).toBe(3);
		expect(lines.join("\n")).toContain(
			"not run (no project collects it): shuffle seed 202",
		);
	});

	// Recurrence (F3): a start that hit the budget kill read as a pass or a red
	// when the timedOut flag was ignored. It is "timeout" and the job exits 3.
	it("classifies a timed-out start as a timeout, whatever its status", () => {
		const { results } = runPlan(planRuns(["tests/a.test.ts"]).slice(0, 1), {
			cwd: ".",
			exec: () => ({ status: 0, output: "", timedOut: true }),
			log: quiet,
		});
		expect(results[0].verdict).toBe("timeout");
	});

	// Recurrence (F4): an alone run that fails is a failure of the file, not an
	// order dependence; the label must not claim an order.
	it("labels a red alone run `fails alone`, not order-dependent", () => {
		const alone = {
			label: "alone tests/a.test.ts",
			files: ["tests/a.test.ts"],
			flags: [],
		};
		const verdict = judge({
			files: ["tests/a.test.ts"],
			notRun: [],
			results: [{ run: alone, verdict: "red", output: "", ms: 1 }],
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines[0]).toMatch(/^fails alone: alone tests\/a\.test\.ts/);
		expect(verdict.lines[0]).not.toContain("order-dependent");
	});
});

describe("judge and run: exit codes", () => {
	const files = ["tests/a.test.ts"];

	// Recurrence: "absent is not green". Every way the job fails to prove the
	// files order-independent exits 3, a different code from a proven red.
	it("exits 0 clean, 1 on an order-dependent start, 3 when unproven", () => {
		const base = { files, notRun: [] };
		const ok = (label: string) => ({
			run: { label, files, flags: [] },
			verdict: "ok" as const,
			output: "",
			ms: 1,
		});
		expect(judge({ ...base, results: [ok("alone a")] }).code).toBe(0);
		expect(
			judge({
				...base,
				results: [{ ...ok("shuffle seed 202"), verdict: "red" as const }],
			}),
		).toMatchObject({ code: 1, kind: "red" });
		expect(
			judge({
				...base,
				results: [{ ...ok("alone a"), verdict: "timeout" as const }],
			}).code,
		).toBe(3);
		expect(
			judge({
				...base,
				results: [ok("alone a")],
				notRun: [{ label: "alone b", files, flags: [] }],
			}).code,
		).toBe(3);
		// A red wins over an unproven part: the author needs the red first.
		expect(
			judge({
				...base,
				results: [{ ...ok("a"), verdict: "red" as const }],
				notRun: [{ label: "alone b", files, flags: [] }],
			}).code,
		).toBe(1);
	});

	it("exits 0 with a stated reason when the diff holds no test file", () => {
		const lines: string[] = [];
		const exec = execBy({});
		const code = run(["--base", "abc1234", "--head", "def5678"], {
			diff: () => ["clients/x.ts", "docs/a.md"],
			added: () => [],
			exec,
			log: (line) => lines.push(line),
		});
		expect(code).toBe(0);
		expect(exec.starts).toEqual([]);
		expect(lines.join("\n")).toContain("no test file added or changed");
	});

	// Recurrence: an unreadable diff read as "no test changed" and green.
	it("exits 3 when the changed-file list is unreadable", () => {
		const code = run(["--base", "abc1234", "--head", "def5678"], {
			diff: () => null,
			exec: execBy({}),
			log: quiet,
		});
		expect(code).toBe(3);
	});

	// Recurrence: the 20-file count cap left PR #4491 (22 test files) unproven
	// at 167 s of a 420 s budget (run 38864877898). The time budget is the bound.
	it("runs every changed file when the budget allows, with no count cap", () => {
		const names = Array.from(
			{ length: 30 },
			(_, index) => `tests/f${String(index).padStart(2, "0")}.test.ts`,
		);
		const scratch = setupTestEnvironment("pi-lens-4456-nocap-");
		cleanups.push(scratch.cleanup);
		fs.mkdirSync(path.join(scratch.tmpDir, "tests"));
		for (const name of names)
			fs.writeFileSync(path.join(scratch.tmpDir, name), "");
		const exec = execBy({});
		const code = run(["--cwd", scratch.tmpDir, "--files", names.join(",")], {
			exec,
			log: quiet,
		});
		expect(code).toBe(0);
		expect(exec.starts[0].filter((arg) => arg.endsWith(".test.ts"))).toEqual(
			names,
		);
		for (const name of names) expect(exec.starts).toContainEqual([name]);
	});

	// Recurrence: a 200-file test rename running the whole suite twice. With no
	// count cap the budget stops it, and "not run" must name every file the
	// budget never reached: the exit is 3, never green.
	it("stops a 200-file diff at the budget and names every file it did not prove", () => {
		const names = Array.from(
			{ length: 200 },
			(_, index) => `tests/f${String(index).padStart(3, "0")}.test.ts`,
		);
		const scratch = setupTestEnvironment("pi-lens-4456-budget-");
		cleanups.push(scratch.cleanup);
		fs.mkdirSync(path.join(scratch.tmpDir, "tests"));
		for (const name of names)
			fs.writeFileSync(path.join(scratch.tmpDir, name), "");
		let clock = 0;
		const exec = execBy({});
		const timed: ExecVitest = (startRun, options) => {
			clock += 50;
			return exec(startRun, options);
		};
		const lines: string[] = [];
		const code = run(["--cwd", scratch.tmpDir, "--files", names.join(",")], {
			exec: timed,
			now: () => clock,
			budgetMs: 1000,
			log: (line) => lines.push(line),
		});
		expect(code).toBe(3);
		expect(exec.starts.length).toBeLessThanOrEqual(20);
		const text = lines.join("\n");
		const started = new Set(exec.starts.flat());
		for (const name of names)
			expect(started.has(name) || text.includes(`alone ${name}`)).toBe(true);
	});

	// Recurrence: the budget constant drifting above the job's cap. ci.yml's
	// job cap is 15 min and its targeted run takes ~4 min.
	it("keeps the budget a minute under the step cap of 8 minutes", () => {
		expect(BUDGET_MS).toBeLessThanOrEqual(7 * 60_000);
	});
});

describe("added files run first, and an unproven result names what it skipped (#4456)", () => {
	const names = (count: number) =>
		Array.from(
			{ length: count },
			(_, index) => `tests/f${String(index).padStart(2, "0")}.test.ts`,
		);

	function scratchTree(files: string[]): string {
		const scratch = setupTestEnvironment("pi-lens-4456-");
		cleanups.push(scratch.cleanup);
		fs.mkdirSync(path.join(scratch.tmpDir, "tests"));
		for (const name of files)
			fs.writeFileSync(path.join(scratch.tmpDir, name), "");
		return scratch.tmpDir;
	}

	// Recurrence: the plan put the added file's alone start after the shuffled
	// starts and in path order, so a slow sibling could spend the budget first.
	it("selectChangedTestFiles puts added files first, each group sorted", () => {
		expect(
			selectChangedTestFiles(
				[
					"tests/b.test.ts",
					"tests/z.test.ts",
					"tests/a.test.ts",
					"tests/y.test.ts",
				],
				() => true,
				["tests/z.test.ts", "tests/y.test.ts"],
			),
		).toEqual([
			"tests/y.test.ts",
			"tests/z.test.ts",
			"tests/a.test.ts",
			"tests/b.test.ts",
		]);
	});

	it("planRuns runs added files alone, then the shuffles, then modified files alone", () => {
		const plan = planRuns(
			["tests/z.test.ts", "tests/a.test.ts", "tests/b.test.ts"],
			SEEDS,
			{ added: ["tests/z.test.ts"] },
		);
		expect(plan.map((entry) => entry.label)).toEqual([
			"alone tests/z.test.ts",
			"shuffle seed 202",
			"shuffle seed 424",
			"alone tests/a.test.ts",
			"alone tests/b.test.ts",
		]);
	});

	// Recurrence: PR #4491 run 38859068333. The PR's new witness test
	// (tests/index-4484-...) sorted after twenty tests/clients and tests/config
	// files it only modified, the 20-file cut dropped it, and the step exited
	// 3 with "not run (over 20 files)" on a passing PR.
	it("runs an added test that sorts last first in a 21-file diff", () => {
		const files = names(21);
		const addedLast = files[files.length - 1];
		const cwd = scratchTree(files);
		const exec = execBy({});
		const lines: string[] = [];
		run(["--cwd", cwd, "--base", "abc1234", "--head", "def5678"], {
			diff: () => files,
			added: () => [addedLast],
			exec,
			log: (line) => lines.push(line),
		});
		expect(exec.starts).toContainEqual([addedLast]);
		expect(exec.starts[0]).toEqual([addedLast]);
		const text = lines.join("\n");
		// No count cap: the added test and every modified file got an alone start.
		for (const file of files) expect(exec.starts).toContainEqual([file]);
		expect(text).not.toContain("not run");
	});

	// Recurrence: PR #4500 run 38846199394 and PR #4411 run 38644123472. One
	// slow modified file in the shuffled set spent the budget before the added
	// file's alone start began, and the result named only "shuffle seed 424",
	// not the files that start would have proven.
	it("runs the added file alone before a slow modified file spends the budget, and names every skipped file", () => {
		const files = ["tests/a-slow.test.ts", "tests/z-added.test.ts"];
		const cwd = scratchTree(files);
		let clock = 0;
		const starts: string[][] = [];
		const exec: ExecVitest = (startRun) => {
			starts.push([...startRun.files, ...startRun.flags]);
			clock += startRun.files.includes("tests/a-slow.test.ts") ? 1000 : 1;
			return OK;
		};
		const lines: string[] = [];
		const code = run(["--cwd", cwd, "--base", "abc1234", "--head", "def5678"], {
			diff: () => files,
			added: () => ["tests/z-added.test.ts"],
			exec,
			now: () => clock,
			budgetMs: 500,
			log: (line) => lines.push(line),
		});
		expect(starts[0]).toEqual(["tests/z-added.test.ts"]);
		const text = lines.join("\n");
		expect(text).toContain("alone tests/z-added.test.ts: ok");
		expect(code).toBe(3);
		// Every skipped start names its files, a shuffled start's included.
		expect(text).toContain(
			"not run (budget spent): shuffle seed 424 (tests/z-added.test.ts, tests/a-slow.test.ts)",
		);
		expect(text).toContain(
			"not run (budget spent): alone tests/a-slow.test.ts",
		);
	});

	// Recurrence: an unreadable added list silently dropping the order that
	// protects the added file. The diff answered, so the run goes on in path
	// order and says so once.
	it("falls back to path order and says so when the added list is unreadable", () => {
		const files = ["tests/a.test.ts", "tests/b.test.ts"];
		const cwd = scratchTree(files);
		const exec = execBy({});
		const lines: string[] = [];
		run(["--cwd", cwd, "--base", "abc1234", "--head", "def5678"], {
			diff: () => files,
			added: () => null,
			exec,
			log: (line) => lines.push(line),
		});
		expect(
			lines.filter((line) => line.includes("added-file list is unreadable")),
		).toHaveLength(1);
		expect(exec.starts.at(-1)).toEqual(["tests/b.test.ts"]);
	});
});

describe("BUDGET_MS is pinned over measured CI plans (#4456)", () => {
	// Recurrence: a 360 s budget that a plan paying the ~60 s route-switch
	// matrix three times (two shuffled starts and alone) could not fit, on
	// PR #4411 and PR #4500. The figures are tests/support/
	// shuffle-changed-budget-measurements.json, copied from those step logs.
	it("leaves 10% headroom over the largest measured plan", () => {
		const cost = (row: BudgetRow) =>
			[...row.seedSeconds, ...row.aloneSeconds].reduce((a, b) => a + b, 0) +
			row.unfinished.reduce((sum, entry) => sum + entry.atLeastSeconds, 0);
		const largest = Math.max(...budgetMeasurements.runs.map(cost));
		expect(largest).toBeGreaterThan(300);
		expect(BUDGET_MS / 1000).toBeGreaterThanOrEqual(largest * 1.1);
	});
});

describe("parseArgs", () => {
	// Recurrence: a value read as a git option (`--output=...`) when the SHAs
	// reach `git diff`. Only hex object names pass.
	it.each([
		[["--base", "--output=/tmp/x", "--head", "abc1234"]],
		[["--base", "abc1234", "--head", "main; rm -rf /"]],
		[["--base", "abc1234"]],
		[["--files"]],
		[["--bogus", "1"]],
	])("rejects %j", (argv) => {
		expect(() => parseArgs(argv)).toThrow();
	});

	it("accepts a base and a head sha, or an explicit file list", () => {
		expect(
			parseArgs(["--base", "abc1234", "--head", "ABCDEF0123"]),
		).toMatchObject({
			base: "abc1234",
			head: "ABCDEF0123",
			files: null,
		});
		expect(
			parseArgs(["--files", "tests/a.test.ts,tests/b.test.ts"]).files,
		).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
	});
});

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
