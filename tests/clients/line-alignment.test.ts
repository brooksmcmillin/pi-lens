/**
 * #4484 round 3 (R2): where a recorded blocker's line sits after a write.
 *
 * Recurrence it prevents: the carry matched a recorded blocker by identity
 * alone, so after an edit an untouched occurrence of the same rule stood in
 * for the fixed one (review F1, probes P9/P10). The carry now maps the
 * recorded line through this alignment; a wrong map would keep a fixed
 * blocker or retire a moved one.
 */
import { describe, expect, it } from "vitest";
import {
	alignLines,
	boundedAnchor,
	lineHashesOf,
	lineHashOf,
	linesOfRanges,
	linesOwedByContent,
	MAX_ALIGNMENT_LINES,
	MAX_OWED_LINE_TEXTS,
	MAX_OWED_RANGES,
	owedByContentOnly,
	owedContentOf,
	owedRangesAfterDispatch,
	rangesOfLines,
	stampLineHashes,
} from "../../clients/line-alignment.js";

const hashes = (text: string) => {
	const h = lineHashesOf(text);
	if (!h) throw new Error("no hashes");
	return h;
};
const textOf = (text: string) => {
	const lines = text.split("\n");
	return (line: number): string | undefined => lines[line - 1];
};
const map = (before: string, after: string, maxEdits?: number) =>
	alignLines(hashes(before), hashes(after), maxEdits);

describe("alignLines", () => {
	it("maps unchanged files line for line", () => {
		const m = map("a\nb\nc\n", "a\nb\nc\n");
		expect([1, 2, 3, 4].map((l) => m?.(l))).toEqual([1, 2, 3, 4]);
	});

	it("shifts lines below an inserted line", () => {
		const m = map("a\nb\nc\n", "x\na\nb\nc\n");
		expect([1, 2, 3].map((l) => m?.(l))).toEqual([2, 3, 4]);
	});

	it("maps an edited line nowhere and keeps its neighbours", () => {
		const m = map("a\nb\nc\n", "a\nB\nc\n");
		expect([1, 2, 3].map((l) => m?.(l))).toEqual([1, undefined, 3]);
	});

	it("maps a deleted line nowhere and pulls the rest up", () => {
		const m = map("a\nb\nc\nd\n", "a\nc\nd\n");
		expect([1, 2, 3, 4].map((l) => m?.(l))).toEqual([1, undefined, 2, 3]);
	});

	it("aligns several hunks at once", () => {
		const m = map("a\nb\nc\nd\ne\nf\n", "a\nX\nb\nc\nE\nf\ng\n");
		expect([1, 2, 3, 4, 5, 6].map((l) => m?.(l))).toEqual([
			1,
			3,
			4,
			undefined,
			undefined,
			6,
		]);
	});

	// Two identical lines (two occurrences of one rule): the one the edit
	// changed maps nowhere, the untouched one keeps its own place.
	it("tells two identical lines apart by the edit between them", () => {
		const twin = "f(): unknown {\n";
		const m = map(`${twin}x\n${twin}`, `${twin}x\nf(): string {\n`);
		expect(m?.(1)).toBe(1);
		expect(m?.(3)).toBeUndefined();
	});

	it("treats a whitespace-only change as the same line", () => {
		const m = map("a\n\tb\n", "a\n    b\n");
		expect(m?.(2)).toBe(2);
	});

	it("has no alignment once the change exceeds the edit cap", () => {
		expect(map("a\nb\nc\n", "x\ny\nz\n", 2)).toBeUndefined();
		expect(map("a\nb\nc\n", "x\ny\nz\n", 6)?.(1)).toBeUndefined();
	});

	it("maps lines outside the old file nowhere", () => {
		const m = map("a\n", "a\n");
		expect(m?.(0)).toBeUndefined();
		expect(m?.(3)).toBeUndefined();
	});
});

// Round 4 (G3): the anchor lived in a cache bounded by count only. It now
// sits on the blocker record; this pins its size per record.
describe("anchor size", () => {
	it("keeps 4 bytes per line, and nothing past the line cap", () => {
		const text = "x\n".repeat(MAX_ALIGNMENT_LINES - 1);
		expect(lineHashesOf(text)?.byteLength).toBe(4 * MAX_ALIGNMENT_LINES);
		expect(lineHashesOf(`${text}x\n`)).toBeUndefined();
	});
});

describe("ranges and lines", () => {
	it("round-trips owed lines through merged ranges", () => {
		const ranges = rangesOfLines([7, 3, 4, 9, 8, 3]);
		expect(ranges).toEqual([
			{ start: 3, end: 4 },
			{ start: 7, end: 9 },
		]);
		expect(linesOfRanges(ranges)).toEqual([3, 4, 7, 8, 9]);
	});
});

// R4. Recurrences: a runner with no verdict owed nothing, so a blocker first
// written then was withheld as out of range forever (TLC MutOwedRanges); and
// a collect-later runner, in flight on every write, would owe every edited
// line for good and widen each later edit's range.
describe("owedRangesAfterDispatch", () => {
	const owed = new Map([["ast-grep-napi", [{ start: 9, end: 9 }]]]);
	const run = (over: Partial<Parameters<typeof owedRangesAfterDispatch>[0]>) =>
		owedRangesAfterDispatch({
			noVerdict: [],
			collectLater: [],
			modifiedRanges: [{ start: 3, end: 4 }],
			owed,
			lineCount: () => 12,
			delivers: true,
			...over,
		});

	it("owes a runner without a verdict the edit's range and its earlier owed lines", () => {
		expect(run({ noVerdict: ["ast-grep-napi", "eslint"] })).toEqual(
			new Map([
				[
					"ast-grep-napi",
					[
						{ start: 3, end: 4 },
						{ start: 9, end: 9 },
					],
				],
				["eslint", [{ start: 3, end: 4 }]],
			]),
		);
	});

	it("owes the whole file after a dispatch without a range", () => {
		expect(
			run({ noVerdict: ["eslint"], modifiedRanges: undefined }).get("eslint"),
		).toEqual([{ start: 1, end: 12 }]);
	});

	it("owes nothing to a runner still in flight or one with a verdict", () => {
		expect(run({ noVerdict: ["lsp"], collectLater: ["lsp"] }).size).toBe(0);
		expect(run({}).size).toBe(0);
	});

	// Recurrence: an unauthored run (#3226) withholds the blocker channel, yet
	// its verdict discharged the owed lines, so the blocker they held was
	// never delivered or recorded (TLC MutOwedRanges via the opaque step).
	it("keeps every earlier owed line after a run that may not deliver", () => {
		expect(run({ delivers: false }).get("ast-grep-napi")).toEqual([
			{ start: 9, end: 9 },
		]);
	});

	// Recurrence (#4484 round 6): napi's Gate B verdict discharged the lines
	// an earlier skip owed napi, though the ast-grep server's gate sees only
	// the edit. A blocker first written during that skip would never reach
	// napi's range when it next runs.
	it("keeps a runner whose verdict covers only the edit owed its earlier lines outside the edit", () => {
		const scoped = new Map([
			[
				"ast-grep-napi",
				[
					{ start: 3, end: 3 },
					{ start: 9, end: 9 },
				],
			],
		]);
		expect(
			run({ editScoped: ["ast-grep-napi"], owed: scoped }).get("ast-grep-napi"),
		).toEqual([{ start: 9, end: 9 }]);
		expect(
			run({
				editScoped: ["ast-grep-napi"],
				owed: new Map([["ast-grep-napi", [{ start: 4, end: 4 }]]]),
			}).size,
		).toBe(0);
	});
});

// Round 5. Recurrences: a file with no record kept only an owing runner's id,
// so the next write owed it the whole file and an untouched, pre-existing
// finding became a new STOP (K2, verify probe P23); past 64 owed ranges the
// same widening followed; and owed lines without alignment were the whole
// file too.
describe("owed lines by content", () => {
	const text = "a\nb\nc\nb\nd\n";
	const scattered = Array.from({ length: MAX_OWED_RANGES + 1 }, (_, i) => ({
		start: 2 * i + 1,
		end: 2 * i + 1,
	}));

	it("owes the lines whose text matches an owed line, wherever they moved", () => {
		const owed = owedContentOf([{ start: 2, end: 2 }], hashes(text));
		expect(owed).toEqual(Uint32Array.from([lineHashOf("b")]));
		expect(
			linesOwedByContent(owed, hashes(`x\n${text}`), 7, textOf(`x\n${text}`)),
		).toEqual([
			{ start: 3, end: 3 },
			{ start: 5, end: 5 },
		]);
		expect(
			linesOwedByContent(owed, hashes("a\nc\n"), 3, textOf("a\nc\n")),
		).toEqual([]);
	});

	// #4509 (N2, probe P31b): a write owed the text `}` owed every closing
	// brace in the file, so an older, untouched finding on any of them came
	// back as owed and pinned. A line with no word character is not owed by
	// its text; an unread line (undefined) stays owed.
	it("does not owe a line with no word character by its text", () => {
		const braces = "f() {\n}\ng() {\n}\n";
		const owed = owedContentOf(
			[{ start: 1, end: 2 }],
			hashes(braces),
		) as Uint32Array;
		expect(linesOwedByContent(owed, hashes(braces), 5, textOf(braces))).toEqual(
			[{ start: 1, end: 1 }],
		);
		expect(
			linesOwedByContent(owed, hashes(braces), 5, () => undefined),
		).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 4 },
		]);
		expect(
			linesOwedByContent(
				Uint32Array.from([lineHashOf("$x")]),
				hashes("$x\n"),
				2,
				textOf("$x\n"),
			),
		).toEqual([{ start: 1, end: 1 }]);
	});

	it("owes the whole file when the content is unknown or past the cap", () => {
		expect(owedContentOf([{ start: 1, end: 2 }], undefined)).toBe("whole-file");
		const many = Array.from(
			{ length: MAX_OWED_LINE_TEXTS + 1 },
			(_, i) => `l${i}`,
		).join("\n");
		expect(
			owedContentOf([{ start: 1, end: MAX_OWED_LINE_TEXTS + 1 }], hashes(many)),
		).toBe("whole-file");
		expect(
			linesOwedByContent("whole-file", hashes(text), 6, textOf(text)),
		).toEqual([{ start: 1, end: 6 }]);
		expect(
			linesOwedByContent(
				Uint32Array.from([lineHashOf("b")]),
				undefined,
				6,
				textOf(text),
			),
		).toEqual([{ start: 1, end: 6 }]);
	});

	it("owes a runner past the range cap the content of its ranges, not the whole file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const anchor = boundedAnchor(
			hashes(lines),
			new Map([["eslint", scattered]]),
		);
		expect(anchor.owedRanges.has("eslint")).toBe(false);
		const content = anchor.owedContent?.get("eslint");
		expect(content).toBeInstanceOf(Uint32Array);
		expect((content as Uint32Array).length).toBe(MAX_OWED_RANGES + 1);
		const kept = boundedAnchor(
			hashes(lines),
			new Map([["eslint", scattered.slice(0, MAX_OWED_RANGES)]]),
		);
		expect(kept.owedRanges.get("eslint")).toHaveLength(MAX_OWED_RANGES);
		expect(kept.owedContent).toBeUndefined();
	});

	it("keeps only owed content once a file's hashes may go", () => {
		const anchor = boundedAnchor(
			hashes(text),
			new Map([["ast-grep-napi", [{ start: 4, end: 5 }]]]),
		);
		expect(owedByContentOnly(anchor)).toEqual({
			lineHashes: undefined,
			owedRanges: new Map(),
			owedContent: new Map([
				[
					"ast-grep-napi",
					Uint32Array.from([lineHashOf("b"), lineHashOf("d")]).sort(),
				],
			]),
		});
		expect(
			owedByContentOnly(boundedAnchor(hashes(text), new Map())),
		).toBeUndefined();
	});
});

// Round 5 (K1): a recorded blocker carries its own line's text, so a write
// with no position for it matches only a line with that text.
describe("stampLineHashes", () => {
	it("stamps each own finding with its line's hash and keeps an existing one", () => {
		const findings = [
			{ line: 2, filePath: "a.ts" },
			{ line: 1, filePath: "a.ts", lineHash: 7 },
			{ line: 1, filePath: "b.ts" },
			{ line: 9, filePath: "a.ts" },
		];
		const stamped = stampLineHashes(
			findings,
			"x\n  y;\n",
			(d) => d.filePath === "a.ts",
		);
		expect(stamped[0]).toEqual({
			line: 2,
			filePath: "a.ts",
			lineHash: lineHashOf("y;"),
		});
		expect(stamped[1]).toBe(findings[1]);
		expect(stamped[2]).toBe(findings[2]);
		expect(stamped[3]).toBe(findings[3]);
		expect(findings[0]).not.toHaveProperty("lineHash");
	});
});
