import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkCount,
	checkDocs,
	checkRecords,
	gitHeadText,
	main,
} from "../../scripts/assert-evaluated.mjs";
import {
	assertEvaluated,
	EVALUATED_DIR_ENV,
	EVALUATED_PRODUCERS,
	MAX_DROP_FRACTION,
	missingRecord,
	readEvaluatedRecord,
	writeEvaluatedRecord,
} from "../../scripts/lib/assert-evaluated.mjs";
import { stripSource } from "../support/sweep-kit.js";

// Recurrence #4514 / retro P2: an artifact that degrades under
// continue-on-error (41 servers captured fell to 16, ~54 classified rows to
// ~24) reads green because nothing asserts how much a producer evaluated.
// These drive the one helper, the CLI around it and the two doc readers the
// refresh-PR gate uses, with the nightly's real doc shapes.

const serverCapsDoc = (n: number) =>
	`_Last generated: 2026-10-12 on linux; ${n} servers captured, 33 unavailable._\n`;
const idleDoc = (eligible: number, inconclusive: number) =>
	`_Last generated: 2026-10-12 on linux; 49 registry servers: ${eligible} eligible, 0 vetoed, ${inconclusive} inconclusive, 20 unavailable (0 not reached: budget)._\n`;
const matrixDoc = (firstPublish: string[]) =>
	`| lang | server | mode | clean-behavior | first-publish | tier | src |\n|---|---|---|---|---|---|---|\n${firstPublish
		.map((fp, i) => `| l${i} | s | push-only | — | ${fp} | 2 | ci |`)
		.join("\n")}\n`;

const tmpDirs: string[] = [];
const tmp = () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-assert-evaluated-"),
	);
	tmpDirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of tmpDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("assertEvaluated (#4514)", () => {
	it("carries one record shape: producer, evaluated, floor, prevEvaluated, ok, reason", () => {
		expect(
			assertEvaluated({ producer: "p", evaluated: 5, expectedAtLeast: 5 }),
		).toEqual({
			producer: "p",
			evaluated: 5,
			floor: 5,
			prevEvaluated: null,
			ok: true,
			reason: "ok",
		});
	});

	it("fails below the floor and passes at it", () => {
		const below = assertEvaluated({
			producer: "p",
			evaluated: 4,
			expectedAtLeast: 5,
		});
		expect(below.ok).toBe(false);
		expect(below.reason).toBe("evaluated 4, below the floor of 5");
	});

	it("fails a drop of more than the margin against HEAD, passes one inside it", () => {
		expect(MAX_DROP_FRACTION).toBe(0.2);
		const dropped = assertEvaluated({
			producer: "p",
			evaluated: 7,
			expectedAtLeast: 1,
			previous: 10,
		});
		expect(dropped.ok).toBe(false);
		expect(dropped.reason).toContain("down from 10 at HEAD");
		expect(
			assertEvaluated({
				producer: "p",
				evaluated: 8,
				expectedAtLeast: 1,
				previous: 10,
			}).ok,
		).toBe(true);
	});

	it("skips the delta when HEAD has no count, and never fails a rise", () => {
		expect(
			assertEvaluated({ producer: "p", evaluated: 3, expectedAtLeast: 1 }).ok,
		).toBe(true);
		expect(
			assertEvaluated({
				producer: "p",
				evaluated: 50,
				expectedAtLeast: 1,
				previous: 10,
			}).ok,
		).toBe(true);
	});

	it.each([
		["a missing producer", { producer: "", evaluated: 1, expectedAtLeast: 1 }],
		[
			"a fractional count",
			{ producer: "p", evaluated: 1.5, expectedAtLeast: 1 },
		],
		[
			"a NaN count",
			{ producer: "p", evaluated: Number.NaN, expectedAtLeast: 1 },
		],
		["a zero floor", { producer: "p", evaluated: 1, expectedAtLeast: 0 }],
		[
			"a negative previous",
			{ producer: "p", evaluated: 1, expectedAtLeast: 1, previous: -1 },
		],
	])("throws on %s (a wiring bug, never a verdict)", (_name, input) => {
		expect(() => assertEvaluated(input)).toThrow(TypeError);
	});
});

describe("producer records (#4514)", () => {
	const saved = process.env[EVALUATED_DIR_ENV];
	beforeEach(() => {
		delete process.env[EVALUATED_DIR_ENV];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[EVALUATED_DIR_ENV];
		else process.env[EVALUATED_DIR_ENV] = saved;
	});

	it("writes one record file when the workflow names a directory, and reads it back", () => {
		const dir = tmp();
		process.env[EVALUATED_DIR_ENV] = path.join(dir, "nested");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		writeEvaluatedRecord({
			producer: "characterize-lsp",
			input: Array.from({ length: 46 }, () => ({ mode: "push-only" })),
		});
		expect(
			readEvaluatedRecord(path.join(dir, "nested"), "characterize-lsp"),
		).toBe(46);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("[evaluated] characterize-lsp: 46");
	});

	it("leaves no file behind on a local run (no directory named)", () => {
		const dir = tmp();
		vi.spyOn(console, "error").mockImplementation(() => {});
		writeEvaluatedRecord({
			producer: "characterize-lsp",
			input: Array.from({ length: 3 }, () => ({ mode: "push-only" })),
		});
		expect(readEvaluatedRecord(dir, "characterize-lsp")).toBeNull();
	});

	it.each([
		["a corrupt file", "{not json"],
		["a negative count", JSON.stringify({ producer: "p", evaluated: -2 })],
		[
			"another producer's record",
			JSON.stringify({ producer: "q", evaluated: 4 }),
		],
	])("reads %s as no record", (_name, body) => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "p.json"), body);
		expect(readEvaluatedRecord(dir, "p")).toBeNull();
	});

	it("builds the record a producer that never reported leaves", () => {
		expect(missingRecord("p", 9, 20)).toEqual({
			producer: "p",
			evaluated: 0,
			floor: 9,
			prevEvaluated: 20,
			ok: false,
			reason: "no record: the producer did not report how much it evaluated",
		});
	});
});

describe("doc readers behind the refresh-PR gate (#4514)", () => {
	const doc = (producer: string) => {
		const spec = EVALUATED_PRODUCERS[producer].doc;
		if (!spec) throw new Error(`${producer} has no doc`);
		return spec;
	};

	it("reads the captured count from the servercapabilities header", () => {
		expect(doc("server-capabilities").count(serverCapsDoc(41))).toBe(41);
	});

	it("reads evaluated servers (eligible + vetoed + inconclusive) from the idle-eviction header", () => {
		expect(doc("measure-lsp-idle-eviction").count(idleDoc(33, 2))).toBe(35);
	});

	it("counts the classified first-publish cells of the matrix, not the unknown ones", () => {
		expect(
			doc("probe-clean-signal").count(
				matrixDoc([
					"direct",
					"empty-first",
					"n/a (pull)",
					"unknown",
					"unknown",
				]),
			),
		).toBe(3);
	});

	it.each([
		"server-capabilities",
		"measure-lsp-idle-eviction",
		"probe-clean-signal",
	])("%s reads null from a doc with no count, never zero", (producer) => {
		expect(doc(producer).count("# nothing here\n")).toBeNull();
	});

	it("reads a count out of each committed doc at HEAD (the readers match the real shapes)", () => {
		for (const producer of Object.keys(EVALUATED_PRODUCERS)) {
			const spec = EVALUATED_PRODUCERS[producer].doc;
			if (!spec) continue;
			const text = fs.readFileSync(path.resolve(spec.path), "utf8");
			expect(spec.count(text), spec.path).toBeGreaterThan(0);
		}
	});
});

describe("checkDocs: the refresh PR refuses a degraded regeneration (#4514)", () => {
	const head: Record<string, string> = {
		"docs/servercapabilities.md": serverCapsDoc(41),
		"docs/lsp-idle-eviction.md": idleDoc(33, 2),
		"docs/lsp-capability-matrix.md": matrixDoc(Array(30).fill("direct")),
	};
	const stage = (docs: Record<string, string>) => {
		const root = tmp();
		for (const [rel, text] of Object.entries(docs)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), text);
		}
		return root;
	};

	it("passes a regeneration that holds its counts, and judges all three docs", () => {
		const root = stage({
			...head,
			"docs/servercapabilities.md": serverCapsDoc(38),
			"docs/lsp-idle-eviction.md": idleDoc(31, 3),
			"docs/lsp-capability-matrix.md": matrixDoc(Array(29).fill("direct")),
		});
		const records = checkDocs(root, (p) => head[p] ?? null);
		// Three docs; the matrix also carries its per-cell record.
		expect(records.map((r) => r.producer)).toEqual([
			"probe-clean-signal:docs/lsp-capability-matrix.md",
			"probe-clean-signal:docs/lsp-capability-matrix.md#cells",
			"server-capabilities:docs/servercapabilities.md",
			"measure-lsp-idle-eviction:docs/lsp-idle-eviction.md",
		]);
		expect(records.every((r) => r.ok)).toBe(true);
	});

	// A promotion-only night overlays no docs: the working tree still holds
	// HEAD's, which an earlier degraded refresh may already have merged. That
	// doc carries nothing into a PR, so it must not hold the promotion PR.
	it("does not judge a doc the regeneration left identical to HEAD", () => {
		const root = stage(head);
		expect(checkDocs(root, (p) => head[p] ?? null)).toEqual([]);
	});

	it("fails the 2026-10-11 shape: 41 captured at HEAD, 16 regenerated", () => {
		const root = stage({
			...head,
			"docs/servercapabilities.md": serverCapsDoc(16),
		});
		const failed = checkDocs(root, (p) => head[p] ?? null).filter((r) => !r.ok);
		expect(failed.map((r) => r.producer)).toEqual([
			"server-capabilities:docs/servercapabilities.md",
		]);
		expect(failed[0].prevEvaluated).toBe(41);
	});

	// Recurrence #4338 (retro P2): five classified matrix cells (python, yaml,
	// shell, dockerfile, prisma) read `unknown`. Five of 28 is 17.9%, inside the
	// 20% count margin, so only the cell-by-cell comparison holds the PR.
	it("fails the #4338 shape: exactly five of 28 classified matrix cells flipped to unknown", () => {
		const headMatrix = matrixDoc(Array(28).fill("direct"));
		const flipped = matrixDoc([
			...Array(23).fill("direct"),
			...Array(5).fill("unknown"),
		]);
		const root = stage({ ...head, "docs/lsp-capability-matrix.md": flipped });
		const records = checkDocs(root, (p) =>
			p === "docs/lsp-capability-matrix.md" ? headMatrix : (head[p] ?? null),
		);
		const count = records.find(
			(r) => r.producer === "probe-clean-signal:docs/lsp-capability-matrix.md",
		);
		// The count margin alone passes it: this is the gap the cells close.
		expect(count).toMatchObject({ evaluated: 23, prevEvaluated: 28, ok: true });
		const failed = records.filter((r) => !r.ok);
		expect(failed.map((r) => r.producer)).toEqual([
			"probe-clean-signal:docs/lsp-capability-matrix.md#cells",
		]);
		expect(failed[0].reason).toBe(
			"5 cell(s) classified at HEAD turned unknown: l23|s, l24|s, l25|s, l26|s, l27|s",
		);
	});

	// #4537: expiry is legitimate, but only HEAD can justify it (#4338 M1).
	it.each([
		["2026-10-10", true],
		["2026-10-11", true],
		["2026-10-12", false],
		["2026-10-17", false],
		["garbage", false],
		["2026-02-30", false],
		[undefined, false],
	])(
		"judges the M1 five-cell loss with HEAD firstMissed %s as %s",
		(stamp, ok) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-16T23:59:00Z"));
			try {
				const state = (firstMissed: string | undefined) =>
					`\n## Capability matrix refresh state (nightly-generated)\n\n\`\`\`json\n${JSON.stringify({ "first-publish": Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${23 + i}`, { firstMissed }])) })}\n\`\`\`\n`;
				const headMatrix = matrixDoc(Array(28).fill("direct")) + state(stamp);
				// An expired stamp in the output must not authorize an unstamped HEAD.
				const flipped =
					matrixDoc([
						...Array(23).fill("direct"),
						...Array(5).fill("unknown"),
					]) + state("2026-10-01");
				const root = stage({
					...head,
					"docs/lsp-capability-matrix.md": flipped,
				});
				const records = checkDocs(root, (p) =>
					p === "docs/lsp-capability-matrix.md"
						? headMatrix
						: (head[p] ?? null),
				);
				expect(records.every((r) => r.ok)).toBe(ok);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("fails a larger flip on the count and on the cells", () => {
		const flipped = matrixDoc([
			...Array(20).fill("direct"),
			...Array(10).fill("unknown"),
		]);
		const root = stage({ ...head, "docs/lsp-capability-matrix.md": flipped });
		const failed = checkDocs(root, (p) => head[p] ?? null).filter((r) => !r.ok);
		expect(failed.map((r) => r.producer)).toEqual([
			"probe-clean-signal:docs/lsp-capability-matrix.md",
			"probe-clean-signal:docs/lsp-capability-matrix.md#cells",
		]);
	});

	it("does not hold a cell the regeneration measured differently, or a row it dropped", () => {
		const root = stage({
			...head,
			"docs/lsp-capability-matrix.md": matrixDoc([
				"empty-first",
				...Array(28).fill("direct"),
			]),
		});
		expect(
			checkDocs(root, (p) => head[p] ?? null).filter((r) => !r.ok),
		).toEqual([]);
	});

	it("fails a doc the regeneration did not produce", () => {
		const root = stage({
			"docs/servercapabilities.md": head["docs/servercapabilities.md"],
		});
		const failed = checkDocs(root, (p) => head[p] ?? null).filter((r) => !r.ok);
		expect(failed.map((r) => r.reason)).toContain(
			"no record: the producer did not report how much it evaluated",
		);
	});
});

describe("checkRecords and main: the dedicated floor step (#4514)", () => {
	const headText = (p: string) =>
		p === "docs/servercapabilities.md" ? serverCapsDoc(41) : null;
	const writeAll = (dir: string, counts: Record<string, number>) => {
		for (const [producer, evaluated] of Object.entries(counts))
			fs.writeFileSync(
				path.join(dir, `${producer}.json`),
				JSON.stringify({ producer, evaluated }),
			);
	};
	const healthy = {
		"characterize-lsp": 46,
		"probe-clean-signal": 42,
		"server-capabilities": 41,
		"measure-lsp-idle-eviction": 35,
	};

	it("passes four healthy records", () => {
		const dir = tmp();
		writeAll(dir, healthy);
		expect(checkRecords(dir, headText).map((r) => r.ok)).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it("fails the degraded night of 2026-10-15 on every producer", () => {
		const dir = tmp();
		writeAll(dir, {
			"characterize-lsp": 21,
			"probe-clean-signal": 21,
			"server-capabilities": 16,
			"measure-lsp-idle-eviction": 15,
		});
		expect(checkRecords(dir, headText).filter((r) => !r.ok)).toHaveLength(4);
	});

	it("fails a producer that wrote no record (it crashed or timed out)", () => {
		const dir = tmp();
		const { "characterize-lsp": _omit, ...rest } = healthy;
		writeAll(dir, rest);
		const failed = checkRecords(dir, headText).filter((r) => !r.ok);
		expect(failed.map((r) => r.producer)).toEqual(["characterize-lsp"]);
	});

	// Recurrence (review r1 of #4514): the probe record counts measured rows (43
	// live) and the matrix counts first-publish cells (<= 29); comparing the two
	// made that drop check unable to fire and printed a misleading "at HEAD 28".
	it("does not compare probe-clean-signal's rows with HEAD's matrix cells", () => {
		const dir = tmp();
		writeAll(dir, { ...healthy, "probe-clean-signal": 32 });
		const record = checkRecords(dir, (p) =>
			p === "docs/lsp-capability-matrix.md"
				? matrixDoc(Array(45).fill("direct"))
				: null,
		).find((r) => r.producer === "probe-clean-signal");
		expect(record).toMatchObject({ prevEvaluated: null, ok: true });
	});

	// Recurrence (review r1 of #4514): gitHeadText returned null on any git
	// failure, so a broken checkout turned the drop guard off and the night
	// passed. Only "HEAD has no such file" is a missing baseline.
	it("gitHeadText: null for a file HEAD lacks, text for one it has, throws when git cannot read HEAD", () => {
		expect(gitHeadText("docs/no-such-doc-4514.md")).toBeNull();
		expect(gitHeadText("package.json")).toContain('"name"');
		expect(() => gitHeadText("package.json", tmp())).toThrow(
			/git could not read HEAD for package.json/,
		);
	});

	it("main fails closed, naming why, when HEAD cannot be read", () => {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dir = tmp();
		writeAll(dir, healthy);
		const unreadable = () => {
			throw new Error("git could not read HEAD for docs/x.md: not a repo");
		};
		expect(main(["--records", dir], unreadable)).toBe(1);
		expect(out).toHaveBeenCalledWith(
			"✗  assert-evaluated  evaluated floor  0  git could not read HEAD for docs/x.md: not a repo",
		);
	});

	it("main --records --docs judges the producers' records and the regenerated docs in one pass", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dir = tmp();
		writeAll(dir, healthy);
		// Records are healthy and HEAD agrees with them; the regenerated caps doc
		// holds 16 of HEAD's 41 servers, so only the --docs half can fail this.
		const root = tmp();
		fs.mkdirSync(path.join(root, "docs"));
		fs.writeFileSync(
			path.join(root, "docs/servercapabilities.md"),
			serverCapsDoc(16),
		);
		const head41 = (p: string) =>
			p === "docs/servercapabilities.md" ? serverCapsDoc(41) : null;
		expect(main(["--records", dir], head41, root)).toBe(0);
		expect(main(["--records", dir, "--docs"], head41, root)).toBe(1);
	});

	it("main exits 0 when everything holds, 1 below a floor, 2 on a usage error", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const ok = tmp();
		writeAll(ok, {
			"characterize-lsp": 500,
			"probe-clean-signal": 500,
			"server-capabilities": 500,
			"measure-lsp-idle-eviction": 500,
		});
		expect(main(["--records", ok])).toBe(0);
		const low = tmp();
		writeAll(low, { ...healthy, "characterize-lsp": 1 });
		expect(main(["--records", low])).toBe(1);
		expect(main([])).toBe(2);
	});
});

// Recurrence #4518: the producers outside the LSP nightly (the APFS anchors,
// the Swift crash-watch) derive their count in shell, so the one helper needs a
// door a workflow step can use without writing a record file. Same record
// shape, same floor comparison; an empty count is a producer that did not
// report, never a zero it measured.
describe("--count: a workflow step's own count against a floor (#4518)", () => {
	it("passes a count at the floor and fails one below it, with the one record shape", () => {
		expect(checkCount("apfs-anchors=200", 200)).toEqual({
			producer: "apfs-anchors",
			evaluated: 200,
			floor: 200,
			prevEvaluated: null,
			ok: true,
			reason: "ok",
		});
		const low = checkCount("apfs-anchors=199", 200);
		expect(low.ok).toBe(false);
		expect(low.reason).toBe("evaluated 199, below the floor of 200");
	});

	it("reads an empty, missing or non-numeric count as a producer that never reported", () => {
		for (const spec of [
			"swift-crash-watch=",
			"swift-crash-watch",
			"swift-crash-watch=abc",
			"swift-crash-watch=-1",
			"swift-crash-watch=1.5",
		]) {
			const record = checkCount(spec, 1);
			expect(record, spec).toMatchObject({
				producer: "swift-crash-watch",
				evaluated: 0,
				ok: false,
			});
			expect(record.reason, spec).toMatch(/no record/);
		}
	});

	it("main exits 0 at the floor, 1 on a zero count, 1 on a missing count, 2 without a valid --floor", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(main(["--count", "swift-crash-watch=1", "--floor", "1"])).toBe(0);
		expect(main(["--count", "swift-crash-watch=0", "--floor", "1"])).toBe(1);
		expect(main(["--count", "swift-crash-watch=", "--floor", "1"])).toBe(1);
		expect(main(["--count", "swift-crash-watch=1"])).toBe(2);
		expect(main(["--count", "swift-crash-watch=1", "--floor", "0"])).toBe(2);
		expect(main(["--count", "swift-crash-watch=1", "--floor", "x"])).toBe(2);
		// `--count` with no value, or a flag where its value belongs, is a usage
		// error: it used to be dropped silently (`--docs --count` exited 0).
		expect(main(["--count"])).toBe(2);
		expect(main(["--count", "--floor", "5"])).toBe(2);
		expect(main(["--docs", "--count"], () => null)).toBe(2);
	});

	it("prints the failing row in the shape the red-night notifier lists, and a step-summary row", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const summary = path.join(tmp(), "summary.md");
		vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
		try {
			main(["--count", "apfs-anchors=3", "--floor", "200"]);
		} finally {
			vi.unstubAllEnvs();
		}
		expect(log).toHaveBeenCalledWith(
			"✗  apfs-anchors  evaluated floor  3  evaluated 3, below the floor of 200",
		);
		expect(fs.readFileSync(summary, "utf8")).toContain(
			"| apfs-anchors | 3 | 200 | n/a | evaluated 3, below the floor of 200 |",
		);
	});
});

// Recurrence #4518 (found while reusing the helper): the refresh-PR job
// (tool-smoke-prs) runs `scripts/assert-evaluated.mjs` on a fresh checkout that
// never builds, and the helper imported scripts/lib/clean-signal.mjs, which
// imports `dist/clients/lsp/server-traits.js`. The guard died with
// ERR_MODULE_NOT_FOUND, so every refresh PR was held for a reason that was not
// a degraded night. A static import walk, not a spawn, so it needs no admission.
describe("the helper loads on a checkout with no dist/ (#4518)", () => {
	const root = path.resolve(import.meta.dirname, "../..");
	const inDist = (file: string) => file.includes(`${path.sep}dist${path.sep}`);
	/** Every module reachable through a relative specifier (a dist/ one is listed, not read). */
	const closure = (entry: string) => {
		const seen = new Set<string>();
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			if (inDist(file)) return;
			const code = stripSource(fs.readFileSync(file, "utf8"), {
				strings: "keep",
			});
			// Every relative module specifier, whatever carries it: a named or
			// aliased import, a side-effect import, a re-export, a dynamic import().
			for (const m of code.matchAll(/"(\.{1,2}\/[^"]+\.(?:mjs|js|ts|mts))"/g))
				visit(path.resolve(path.dirname(file), m[1]));
		};
		visit(path.resolve(root, entry));
		return [...seen];
	};

	it("reaches no module under dist/ from either entry point", () => {
		for (const entry of [
			"scripts/assert-evaluated.mjs",
			"scripts/lib/assert-evaluated.mjs",
		]) {
			const files = closure(entry);
			expect(files.length, entry).toBeGreaterThanOrEqual(2);
			expect(files.filter(inDist).map((f) => path.relative(root, f))).toEqual(
				[],
			);
		}
	});
});
