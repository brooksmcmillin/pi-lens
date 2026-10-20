import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	blankMarkdown,
	issueNumbers,
	parseDefectShapes,
} from "../../scripts/lib/defect-shapes.mjs";

// Recurrence (#4439): shapes 67 and 68 entered the AGENTS.md catalog on
// 2026-10-14 with no HISTORY.md entry, and nothing checked it. The retro
// contract (`docs/pi-lens-retro.md` step 4) puts each shape's issues and PRs in
// HISTORY.md, because AGENTS.md stays lean (agents-governance.test.ts keeps its
// reference count from growing). A shape has history when HISTORY.md, read as
// comment-blanked markdown, carries one of the shape's own issue or PR numbers
// from its catalog entry, or a heading naming `shape N`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const read = (file: string, env?: string): string =>
	fs.readFileSync(
		(env && process.env[env]) || path.join(REPO_ROOT, file),
		"utf8",
	);

/** Catalog shape numbers with no entry in `history`, ascending. */
function shapesWithoutHistory(agents: string, history: string): number[] {
	const blanked = blankMarkdown(history);
	const referenced = issueNumbers(blanked);
	const headed = new Set(
		// An ATX heading needs a space after its marks, and the number sits on the
		// heading's own line: a prose line opening with an issue reference
		// ("#4527's ... Shape" / "31") once counted as a heading naming shape 31.
		[...blanked.matchAll(/^#{1,6}[ \t][^\n]*\bshape[ \t]+(\d+)\b/gim)].map(
			(match) => Number(match[1]),
		),
	);
	return [...parseDefectShapes(agents)]
		.filter(
			([number, entry]) =>
				!headed.has(number) &&
				![...issueNumbers(entry)].some((issue) => referenced.has(issue)),
		)
		.map(([number]) => number)
		.sort((a, b) => a - b);
}

/**
 * The two baseline guards: `added` are uncovered shapes outside the baseline
 * (a new shape without history), `stale` are baseline shapes that gained
 * history (the baseline only shrinks).
 */
function baselineViolations(
	uncovered: readonly number[],
	baseline: readonly number[],
): { added: number[]; stale: number[] } {
	return {
		added: uncovered.filter((n) => !baseline.includes(n)),
		stale: baseline.filter((n) => !uncovered.includes(n)),
	};
}

// Shrink-only baseline: the 57 shapes without HISTORY.md coverage when #4439
// landed (2026-10-14). Backfill a shape's history, then delete its number here;
// never add one. A new shape lands with its HISTORY.md entry.
const NO_HISTORY_BASELINE: readonly number[] = [
	2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
	44, 45, 46, 47, 48, 51, 54, 55, 57, 58, 59, 60, 61, 63, 64, 65, 66,
];

describe("catalog shapes have a HISTORY.md entry (#4439)", () => {
	const agents = read("AGENTS.md", "PI_LENS_AGENTS_PATH");
	const history = read("HISTORY.md", "PI_LENS_HISTORY_PATH");
	const uncovered = shapesWithoutHistory(agents, history);

	const { added, stale } = baselineViolations(uncovered, NO_HISTORY_BASELINE);

	it("lets no shape outside the baseline lack a HISTORY.md entry", () => {
		expect(
			added,
			`shape(s) ${added.join(", ")} in AGENTS.md have no HISTORY.md entry: give each a HISTORY.md section whose heading names it, such as "## 2026-10-14 - model switch drift (shape 68)" (retro step 4), or cite one of its own issues there; never add to the baseline`,
		).toEqual([]);
	});

	it("keeps the baseline shrink-only: a covered shape leaves it", () => {
		expect(
			stale,
			`shape(s) ${stale.join(", ")} now have history: delete them from NO_HISTORY_BASELINE`,
		).toEqual([]);
	});

	it("lists only catalog shapes, once each, ascending", () => {
		const catalog = parseDefectShapes(agents);
		expect(NO_HISTORY_BASELINE.filter((n) => !catalog.has(n))).toEqual([]);
		expect([...NO_HISTORY_BASELINE]).toEqual(
			[...new Set(NO_HISTORY_BASELINE)].sort((a, b) => a - b),
		);
	});

	it("parses the whole catalog, so the scan is not vacuous", () => {
		expect(parseDefectShapes(agents).size).toBeGreaterThanOrEqual(68);
	});
});

describe("blankMarkdown options (#4439)", () => {
	const text = "- item\n\n    indented\n";

	it("blanks an indented block by default", () => {
		expect(blankMarkdown(text).trim()).toBe("- item");
	});

	it("keeps an indented block when indentedCode is false", () => {
		expect(blankMarkdown(text, { indentedCode: false })).toContain("indented");
	});
});

// Recurrence (#4565): the comment rule knew `-->` alone, so it blanked every
// line after a comment GitHub had already closed, and a gating rule then read
// a visible answer as absent. Each row names one end the HTML spec gives a
// comment (13.2.5.43-46) that the parser must agree the renderer has.
describe("blankMarkdown comment ends (#4565)", () => {
	const hidden = (markdown: string) => blankMarkdown(markdown);

	it("ends a comment at `--!>` and keeps the text after it", () => {
		const out = hidden("<!-- secret --!> visible");
		expect(out).not.toContain("secret");
		expect(out).toContain("visible");
	});

	it("reads `<!-->` as a complete empty comment", () => {
		const out = hidden("<!-->visible");
		expect(out).toContain("visible");
		expect(blankMarkdown("<!-->")).toBe("     ");
	});

	it("reads `<!--->` as a complete empty comment", () => {
		const out = hidden("<!--->visible");
		expect(out).toContain("visible");
		expect(blankMarkdown("<!--->")).toBe("      ");
	});

	it("does not end a comment at `--!` without the `>`", () => {
		// The comment end bang state consumes `!` and returns to the comment
		// state, so this text is still hidden; only `tail` is visible.
		const out = hidden("<!-- secret --! still hidden --> tail");
		expect(out).not.toContain("still hidden");
		expect(out).toContain("tail");
	});

	it("keeps the `-->` end and the unterminated tail", () => {
		expect(hidden("<!-- secret --> visible")).toContain("visible");
		expect(hidden("<!-- secret\nhidden")).not.toContain("hidden");
	});

	it("keeps a comment opener inside a fence literal", () => {
		// Fences go first: an opener in a fence is text, so it cannot swallow
		// the visible line after the fence.
		expect(hidden("```\n<!--\n```\nvisible")).toContain("visible");
	});

	it("keeps the line count and every line's length", () => {
		const out = hidden("<!-->\nafter");
		expect(out.split("\n")).toHaveLength(2);
		expect(out.split("\n")[0]).toHaveLength(5);
	});
});

describe("baselineViolations (#4439)", () => {
	// Recurrence (#4448 review F2): both guards survived neutering because only
	// an env override on the real files ever exercised them.
	it("flags an uncovered shape that is not in the baseline", () => {
		expect(baselineViolations([2, 69], [2, 3])).toEqual({
			added: [69],
			stale: [3],
		});
	});

	it("flags nothing when the uncovered shapes equal the baseline", () => {
		expect(baselineViolations([2, 3], [2, 3])).toEqual({
			added: [],
			stale: [],
		});
	});

	it("flags a baseline shape that gained history", () => {
		expect(baselineViolations([2], [2, 67])).toEqual({
			added: [],
			stale: [67],
		});
	});
});

describe("shapesWithoutHistory (#4439)", () => {
	const catalog = (...entries: string[]): string =>
		`## Recurring defect shapes\n\n${entries.join("\n\n")}\n\n## Next\n`;
	const shape = (n: number, text: string) => `${n}. **Shape ${n}:** ${text}`;

	it("ends a catalog entry at the next unindented line", () => {
		// Recurrence: text after an entry (a block tag, a heading) is not the
		// entry's, so a reference there, even on an indented line, must not
		// count as the shape's own.
		const agents = catalog(shape(1, "old.\n    continued (#100)."));
		const trailing = agents.replace(
			"\n\n## Next",
			"\nunindented prose\n    indented #200\n\n## Next",
		);
		expect(parseDefectShapes(trailing).get(1)).toContain("#100");
		expect(parseDefectShapes(trailing).get(1)).not.toContain("#200");
	});

	it("flags a new shape that HISTORY.md never mentions", () => {
		// Recurrence: shapes 67 and 68 landed with no HISTORY.md entry.
		const agents = catalog(shape(1, "old (#100)."), shape(69, "new (#900)."));
		expect(
			shapesWithoutHistory(agents, "# HISTORY\n\nPR #100 landed.\n"),
		).toEqual([69]);
	});

	it("accepts one of the shape's own issue references", () => {
		const agents = catalog(shape(1, "old (#100, #101)."));
		expect(shapesWithoutHistory(agents, "Fixed in #101.")).toEqual([]);
	});

	it("accepts a heading naming the shape when the entry cites no issue", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "## 2026-10-14 (shape 7)\n")).toEqual(
			[],
		);
	});

	it("ignores a shape number in prose that is not a heading", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "A relative of shape 7.\n")).toEqual([
			7,
		]);
	});

	// Recurrence (#4601 compliance F1): a prose line opening with an issue
	// reference and wrapping before the number ("#4527's ... Shape" / "31")
	// counted as a heading naming shape 31, so shape 31 left the baseline.
	it.each([
		["a line opening with an issue reference", "#4527's save. Shape 7 asks.\n"],
		["a number wrapped onto the next line", "## Retro, see shape\n7 below\n"],
	])("ignores %s as a heading naming the shape", (_name, history) => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, history)).toEqual([7]);
	});

	it("is not satisfied by a reference or heading inside an HTML comment", () => {
		const agents = catalog(shape(1, "old (#100)."), shape(7, "no issue."));
		const history =
			"<!-- #100 -->\n<!--\n## Retro (shape 7)\n-->\nplain text\n";
		expect(shapesWithoutHistory(agents, history)).toEqual([1, 7]);
	});

	// Recurrence (#4448 review F1): the first blanker handled only column-0
	// backtick fences and terminated comments, so each of these covered a
	// shape from text GitHub renders as code or hides.
	it.each([
		["a backtick fence", "```\n#100\n```\n"],
		["an indented fence in a list", "- item\n  ```\n  #100\n  ```\n"],
		["a tilde fence", "~~~\n#100\n~~~\n"],
		["a four-backtick fence", "````md\n```\nx\n```\n#100\n````\n"],
		[
			"a four-backtick fence that holds a short fence line",
			"````md\n```\n#100\n````\n",
		],
		["an unterminated comment", "<!-- #100\n"],
	])("is not satisfied by a reference in %s", (_name, history) => {
		const agents = catalog(shape(1, "old (#100)."));
		expect(shapesWithoutHistory(agents, history)).toEqual([1]);
	});

	it("is not satisfied by a shape heading inside a tilde fence", () => {
		const agents = catalog(shape(1, "no issue."));
		expect(
			shapesWithoutHistory(agents, "~~~\n## Retro (shape 1)\n~~~\n"),
		).toEqual([1]);
	});

	it("does not read a reference from a fence or unterminated comment in an entry", () => {
		for (const hidden of ["    ~~~\n    (#100)\n    ~~~", "    <!-- (#100)"])
			expect(
				shapesWithoutHistory(
					catalog(shape(1, `old.\n${hidden}`)),
					"Fixed in #100.",
				),
			).toEqual([1]);
	});

	it("keeps the heading route working beside the new blanker", () => {
		const agents = catalog(shape(1, "no issue."));
		expect(shapesWithoutHistory(agents, "## Retro (shape 1)\n")).toEqual([]);
	});

	it("does not read a reference from a comment in the catalog entry", () => {
		const agents = catalog(shape(1, "old.\n    <!-- #100 -->"));
		expect(shapesWithoutHistory(agents, "Fixed in #100.")).toEqual([1]);
	});
});
