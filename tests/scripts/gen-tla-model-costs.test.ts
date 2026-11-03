// #4672 V4: `scripts/gen-tla-model-costs.mjs` produces the table every TLA+
// shard is packed by, and nothing tested it. Two gaps, both reproduced by the
// review:
//
//  - the parser and the median (`costsFromLog`, `buildModelCosts`) had no test
//    at all, so a regression in the `(Ns)` capture or the median stayed green
//    until a human regenerated the table;
//  - `main` wrote an EMPTY table and `loadModelCosts` accepted it: `max` is 0,
//    every config costs 0, `assignShards` leaves all of them in shard 1, and
//    three runners then red with "selects no formal/*/*.cfg" -- a confusing
//    diagnosis for one bad `--log`.
//
// Fixtures under tests/fixtures/tla-model-costs/:
//   - run-39435284236-shard1-excerpt.log: EIGHT config lines copied byte for
//     byte out of `gh run view 39435284236 --log --job 118671767794` (the
//     partition's first live run), including the `<job>\t<step>\t<timestamp>Z `
//     prefix `gh run view --log` adds -- so the parser is proven against the
//     real capture, not against a hand-written line (AGENTS.md shape 16).
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildModelCosts,
	costsFromLog,
	incompleteTableReason,
	main,
	statesFromLog,
	MIN_TABLE_COVERAGE,
} from "../../scripts/gen-tla-model-costs.mjs";
import {
	listModelConfigs,
	loadModelCosts,
	modelCostId,
	selectShard,
} from "../../scripts/check-tla-models.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tla-model-costs");

/** A scratch dir that names its own family, so the tmp sweep can attribute it. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "pi-lens-gen-tla-costs-"));
	return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * `console.error` captured and silenced. A refusal is the only record a bad
 * `--log` leaves, so the test asserts it -- and a PASSING case must not print
 * it into a CI transcript, where a reader cannot tell an expected refusal from
 * a failure (#2547's `real-process-spawn` doctrine: drive the module
 * in-process instead of spawning `node`).
 */
function captureErrors() {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
		lines.push(String(line));
	});
	return { lines, restore: () => spy.mockRestore() };
}

/** The generator's own progress line, captured rather than printed. */
function captureLogs() {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
		lines.push(String(line));
	});
	return { lines, restore: () => spy.mockRestore() };
}

describe("#4672 V4 cost generation — the parser, the median, and a table worth writing", () => {
	it("reads the checker's own per-config seconds out of a real captured log", () => {
		const text = readFileSync(
			join(FIXTURES, "run-39435284236-shard1-excerpt.log"),
			"utf8",
		);
		const costs = costsFromLog(text);
		expect(costs.size).toBe(8);
		// Verbatim from the capture: `ok   formal/...: expected pass, got pass (5.0s)`.
		expect(costs.get("formal/blocker-pending/CarryOwed.cfg")).toBe(5.0);
		expect(costs.get("formal/blocker-pending/CarryGateB.cfg")).toBe(5.4);
		// A `violated` expectation is still a measured run, and its seconds count.
		expect(costs.get("formal/blocker-pending/MutDeltaClear.cfg")).toBe(1.4);
		// The `<job>\t<step>\t<timestamp>Z ` prefix `gh run view --log` adds is
		// part of every real line, and it must not defeat the capture.
		expect(text.split("\n")[0]).toContain("UNKNOWN STEP");
	});

	it("keeps a FAIL line's seconds and ignores lines that are not a measurement", () => {
		const costs = costsFromLog(
			[
				"FAIL formal/x/Broken.cfg: expected pass, got error: invariant missing (12.5s)",
				"ok   formal/x/Good.cfg: expected pass, got pass (0.5s)",
				"  formal/x/Halfway.cfg: expected pass, got pass (9.9s)",
				"ok   formal/x/NoSeconds.cfg: expected pass, got pass",
				"ok   formal/x/Negative.cfg: expected pass, got pass (-1.0s)",
				"",
			].join("\n"),
		);
		expect([...costs.keys()]).toEqual([
			"formal/x/Broken.cfg",
			"formal/x/Good.cfg",
		]);
		expect(costsFromLog("")).toEqual(new Map());
		expect(costsFromLog(null)).toEqual(new Map());
	});

	it("takes each config's MEDIAN over the logs that ran it, sorted, and records its sources", () => {
		const rows = (seconds: number[]) =>
			seconds
				.map(
					(s, at) =>
						`ok   formal/y/M${at}.cfg: expected pass, got pass (${s}s)`,
				)
				.join("\n");
		// #4680 r4 F6: each config has one slow outlier, so the median and the
		// mean differ in every row. The old rows (1/3/5, 10/30/50, 100/300/500)
		// had mean == median, and a mean mutation stayed green (8 passed).
		const table = buildModelCosts([
			{ source: "1", text: rows([1, 10, 300]) },
			{ source: "2", text: rows([3, 30, 100]) },
			{ source: "3", text: rows([100, 31, 900]) },
		]);
		// Median, not mean: 1/3/100 -> 3 (mean 34.7), 10/30/31 -> 30 (mean
		// 23.7), 300/100/900 -> 300 (mean 433.3). One slow runner does not
		// move a config's cost.
		expect(table.files).toEqual({
			"formal/y/M0.cfg": 3,
			"formal/y/M1.cfg": 30,
			"formal/y/M2.cfg": 300,
		});
		expect(Object.keys(table.files)).toEqual(
			[...Object.keys(table.files)].sort(),
		);
		expect(table.sources).toEqual(["1", "2", "3"]);
		// The measurement's per-shard totals are kept beside it (1 + 10 + 300).
		expect(table.perShardShares).toEqual({ "1": 311, "2": 133, "3": 1031 });
	});

	it("refuses a table with no measured config, before writing it", () => {
		const { dir, done } = scratch();
		const errors = captureErrors();
		try {
			const log = join(dir, "empty.log");
			writeFileSync(log, "no config lines here\n");
			const out = join(dir, "table.json");
			const code = main(["--log", log, "--out", out], { root: ROOT });
			expect(code).toBe(2);
			// The refusal is the only record a bad `--log` leaves, so it is
			// asserted here instead of being read off a CI transcript.
			expect(errors.lines.join("\n")).toContain(
				"no per-config TLC timings found",
			);
			// Nothing was written: the committed table is never the broken one.
			expect(() => readFileSync(out, "utf8")).toThrow();
			expect(
				incompleteTableReason(
					{},
					{ configCount: listModelConfigs(ROOT).length },
				),
			).toContain("no per-config TLC timings found");
		} finally {
			errors.restore();
			done();
		}
	});

	it("refuses an under-populated table (one shard's log is not a table)", () => {
		const { dir, done } = scratch();
		const errors = captureErrors();
		try {
			const log = join(FIXTURES, "run-39435284236-shard1-excerpt.log");
			const out = join(dir, "table.json");
			const configCount = listModelConfigs(ROOT).length;
			// 8 rows against 811 configs: three quarters of the corpus would price
			// at the table max.
			expect(
				incompleteTableReason({ "formal/y/A.cfg": 1 }, { configCount }),
			).toContain(`only 1 of the ${configCount} configs under formal/`);
			const code = main(["--log", log, "--out", out], { root: ROOT });
			expect(code).toBe(2);
			expect(errors.lines.join("\n")).toContain("have a row (floor 50%)");
			expect(() => readFileSync(out, "utf8")).toThrow();
			// The floor one row above it is accepted, so the guard has a boundary
			// rather than a mood.
			const files = Object.fromEntries(
				Array.from(
					{ length: Math.ceil(configCount * MIN_TABLE_COVERAGE) },
					(_, at) => [`formal/y/M${at}.cfg`, 1],
				),
			);
			expect(incompleteTableReason(files, { configCount })).toBeNull();
		} finally {
			errors.restore();
			done();
		}
	});

	it("writes a table that prices every config and packs the shards by it", () => {
		const { dir, done } = scratch();
		try {
			const all = listModelConfigs(ROOT);
			// One synthesized "log" that covers the whole corpus, in the checker's
			// own line format: the happy path of a complete regeneration.
			const log = join(dir, "full.log");
			writeFileSync(
				log,
				all
					.map((config, at) => {
						const id = modelCostId(ROOT, config);
						return `ok   ${id}: expected pass, got pass (${((at % 7) + 1).toFixed(1)}s)`;
					})
					.join("\n"),
			);
			const out = join(dir, "table.json");
			const progress = captureLogs();
			try {
				expect(main(["--log", log, "--out", out], { root: ROOT })).toBe(0);
			} finally {
				progress.restore();
			}
			// The one line a regeneration prints, read back here rather than
			// printed into the lane's transcript.
			expect(progress.lines.join("\n")).toContain(
				`wrote ${out}: ${all.length} configs from 1 log(s)`,
			);
			const written = JSON.parse(readFileSync(out, "utf8")) as {
				files: Record<string, number>;
				generatedBy: string;
				note: string;
				sources: string[];
			};
			// #4680 r4 F9: a run with no `--source` still names its measurement.
			// It wrote `sources: []` before, though `buildModelCosts` already
			// labels each log by its basename.
			expect(written.sources).toEqual(["full.log"]);
			expect(Object.keys(written.files)).toHaveLength(all.length);
			expect(Object.keys(written.files)).toEqual(
				all.map((c) => modelCostId(ROOT, c)).sort(),
			);
			expect(written.generatedBy).toContain("gen-tla-model-costs.mjs");
			// And the reader accepts it: every config is priced, every shard is
			// non-empty under the production selector.
			const costs = {
				root: ROOT,
				...written,
				max: Math.max(...Object.values(written.files)),
			};
			expect(
				all.filter((config) => !(modelCostId(ROOT, config) in costs.files)),
			).toEqual([]);
			for (let index = 1; index <= 4; index += 1)
				expect(
					selectShard(all, { index, total: 4 }, costs).length,
				).toBeGreaterThan(0);
		} finally {
			done();
		}
	});

	// The reader's half of the same defect: a hand-truncated or half-written table
	// must not read as "every config costs zero".
	it("refuses to load an empty table", () => {
		const { dir, done } = scratch();
		try {
			// `loadModelCosts` resolves `<root>/scripts/tla-model-costs.json`.
			const fakeRoot = join(dir, "repo");
			mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
			writeFileSync(
				join(fakeRoot, "scripts", "tla-model-costs.json"),
				JSON.stringify({ files: {} }),
			);
			expect(() => loadModelCosts(fakeRoot)).toThrow(
				/price no config above 0 s; regenerate with scripts\/gen-tla-model-costs\.mjs/,
			);
		} finally {
			done();
		}
	});

	// #4680 r4 F5, V4's sibling spelling: `{}` was refused, but a table whose
	// every row is 0 s has the same `max` of 0, and every unmeasured config then
	// costs 0 too. Reproduced before the fix: `{"formal/a/b.cfg": 0}` loaded,
	// and the shards packed 811/0/0/0. The rule is the max, not the row count.
	it.each([
		["one zero row", { "formal/a/b.cfg": 0 }],
		["every row zero", { "formal/a/b.cfg": 0, "formal/a/c.cfg": 0 }],
	])("refuses to load a table with %s", (_why, files) => {
		const { dir, done } = scratch();
		try {
			const fakeRoot = join(dir, "repo");
			mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
			writeFileSync(
				join(fakeRoot, "scripts", "tla-model-costs.json"),
				JSON.stringify({ files }),
			);
			expect(() => loadModelCosts(fakeRoot)).toThrow(
				/price no config above 0 s; regenerate with scripts\/gen-tla-model-costs\.mjs/,
			);
		} finally {
			done();
		}
	});

	it("refuses to write a table whose every measured config took 0 s", () => {
		const configCount = listModelConfigs(ROOT).length;
		const files = Object.fromEntries(
			Array.from({ length: configCount }, (_, at) => [
				`formal/y/M${at}.cfg`,
				0,
			]),
		);
		expect(incompleteTableReason(files, { configCount })).toContain(
			"every measured config took 0 s",
		);
		// One measured second is a table.
		files["formal/y/M0.cfg"] = 1;
		expect(incompleteTableReason(files, { configCount })).toBeNull();
	});

	// The entry point the workflow calls, driven in-process: no child `node`, so
	// this file holds no real spawn (#2547's `real-process-spawn`).
	it("prints the usage and returns 2 on a bad invocation", () => {
		const errors = captureErrors();
		try {
			expect(main([])).toBe(2);
		} finally {
			errors.restore();
		}
		expect(errors.lines.join("\n")).toContain("at least one --log is required");
		expect(errors.lines.join("\n")).toContain(
			"usage: node scripts/gen-tla-model-costs.mjs",
		);
	});

	// #4680 r4 F3, the generator's half: replacing its entry guard with `false`
	// left all 8 tests green, because every case calls `main` directly. Running
	// the script must still run `main`: `process.argv[1]` is the script's own
	// path and the module is imported by its plain URL, so the guard's
	// comparison is what answers. No flags means the usage line and exit 2.
	it("runs main when the script itself is argv[1]", async () => {
		const script = resolve(ROOT, "scripts", "gen-tla-model-costs.mjs");
		const argvBefore = [...process.argv];
		const exitCodeBefore = process.exitCode;
		const errors = captureErrors();
		let exitCode: number | string | null | undefined;
		try {
			process.argv.splice(0, process.argv.length, argvBefore[0], script);
			vi.resetModules();
			await import(pathToFileURL(script).href);
			exitCode = process.exitCode;
		} finally {
			process.argv.splice(0, process.argv.length, ...argvBefore);
			process.exitCode = exitCodeBefore;
			errors.restore();
		}
		expect(exitCode).toBe(2);
		expect(errors.lines.join("\n")).toContain("at least one --log is required");
	});
});

// #4714: the checker prints each config's TLC distinct-state count on its
// result line, and the generator stores the median count beside the seconds.
// Recurrence: a count that the generator drops would leave the ratchet with
// nothing to compare, and the table would silently stop recording states.
describe("#4714 distinct-state counts in the cost table", () => {
	it("reads the seconds and the count from a line that carries both, and still reads the old line", () => {
		const text = [
			"ok   formal/x/New.cfg: expected pass, got pass (5.0s, 1234 distinct states)",
			"ok   formal/x/Old.cfg: expected pass, got pass (2.5s)",
		].join("\n");
		expect(costsFromLog(text)).toEqual(
			new Map([
				["formal/x/New.cfg", 5],
				["formal/x/Old.cfg", 2.5],
			]),
		);
		expect(statesFromLog(text)).toEqual(new Map([["formal/x/New.cfg", 1234]]));
	});

	it("stores the median count per config, sorted, beside the seconds", () => {
		const row = (states: number) =>
			`ok   formal/y/M.cfg: expected pass, got pass (1.0s, ${states} distinct states)`;
		const table = buildModelCosts([
			{ source: "1", text: row(100) },
			{ source: "2", text: row(900) },
			{ source: "3", text: row(120) },
		]);
		expect(table.states).toEqual({ "formal/y/M.cfg": 120 });
	});

	it("stores no counts from logs that predate the count", () => {
		const table = buildModelCosts([
			{
				source: "1",
				text: "ok   formal/y/M.cfg: expected pass, got pass (1.0s)",
			},
		]);
		expect(table.states).toEqual({});
	});
});

// #4714 F1/F4: `main` is the only writer of the table. Two cases pin it: the
// payload carries the counts a run printed (a dropped `states` key reds), and a
// regeneration from old-format logs keeps the counts the file already records
// (a rewrite to `states: {}` loses every count with no warning).
// Recurrence: the first regeneration from old logs wrote `states: {}`.
describe("#4714 main() writes the state counts", () => {
	function fakeRepo(dir: string) {
		for (const name of ["A", "B"]) {
			const family = join(dir, "formal", "fam");
			mkdirSync(family, { recursive: true });
			writeFileSync(
				join(family, `${name}.cfg`),
				"\\* expect: pass\n\\* module: M\n",
			);
		}
	}

	it("writes the printed count beside the seconds", () => {
		const { dir, done } = scratch();
		const logs = captureLogs();
		try {
			fakeRepo(dir);
			const log = join(dir, "shard.log");
			writeFileSync(
				log,
				[
					"ok   formal/fam/A.cfg: expected pass, got pass (5.0s, 300 distinct states)",
					"ok   formal/fam/B.cfg: expected pass, got pass (2.0s)",
				].join("\n"),
			);
			const out = join(dir, "table.json");
			expect(main(["--log", log, "--out", out], { root: dir })).toBe(0);
			const table = JSON.parse(readFileSync(out, "utf8"));
			expect(table.files).toEqual({
				"formal/fam/A.cfg": 5,
				"formal/fam/B.cfg": 2,
			});
			expect(table.states).toEqual({ "formal/fam/A.cfg": 300 });
		} finally {
			logs.restore();
			done();
		}
	});

	it("keeps the counts the file already records when the logs predate them", () => {
		const { dir, done } = scratch();
		const logs = captureLogs();
		try {
			fakeRepo(dir);
			const out = join(dir, "table.json");
			writeFileSync(
				out,
				JSON.stringify({
					files: { "formal/fam/A.cfg": 4 },
					states: { "formal/fam/A.cfg": 136 },
				}),
			);
			const log = join(dir, "old.log");
			writeFileSync(
				log,
				[
					"ok   formal/fam/A.cfg: expected pass, got pass (5.0s)",
					"ok   formal/fam/B.cfg: expected pass, got pass (2.0s)",
				].join("\n"),
			);
			expect(main(["--log", log, "--out", out], { root: dir })).toBe(0);
			const table = JSON.parse(readFileSync(out, "utf8"));
			expect(table.states).toEqual({ "formal/fam/A.cfg": 136 });
			// The summary names how many counts the file holds, so a regeneration
			// that drops them is visible in the run's own output.
			expect(
				logs.lines.some((line) => line.includes("1 distinct-state count")),
			).toBe(true);
		} finally {
			logs.restore();
			done();
		}
	});

	// #4838 review F3: the merge put the file's recorded keys first, so a count
	// kept from the file sat ahead of a newer config measured this run, and the
	// documented regeneration was not byte-identical to the committed table.
	it("writes kept and measured counts as one sorted map", () => {
		const { dir, done } = scratch();
		const logs = captureLogs();
		try {
			fakeRepo(dir);
			const out = join(dir, "table.json");
			writeFileSync(
				out,
				JSON.stringify({ states: { "formal/fam/B.cfg": 20 } }),
			);
			const log = join(dir, "shard.log");
			writeFileSync(
				log,
				[
					"ok   formal/fam/A.cfg: expected pass, got pass (5.0s, 300 distinct states)",
					"ok   formal/fam/B.cfg: expected pass, got pass (2.0s)",
				].join("\n"),
			);
			expect(main(["--log", log, "--out", out], { root: dir })).toBe(0);
			const table = JSON.parse(readFileSync(out, "utf8"));
			expect(Object.keys(table.states)).toEqual([
				"formal/fam/A.cfg",
				"formal/fam/B.cfg",
			]);
		} finally {
			logs.restore();
			done();
		}
	});
});
