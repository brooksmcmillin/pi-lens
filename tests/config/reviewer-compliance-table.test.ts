/**
 * The reviewer contract's diff-keyed compliance pass (#4585).
 *
 * Recurrence: on 2026-10-17 Greptile caught four rule violations our reviewers
 * missed on the same heads: #4577 shipped round-4 cases with no red-first or
 * mutation proof (principles §2), #4575 moved code without its TLA+ model and
 * added the saveOnly rule with no mutation red (AGENTS shape 68), and #4566's
 * new launcher cells failed on Windows (AGENTS "Test requirements"). The
 * contract said to read AGENTS.md and the principles once, so a rule was never
 * re-applied hunk by hunk. The table keys each rule on what the diff touches.
 *
 * The scan reads comment- and fence-blanked markdown (`blankMarkdown`), so a
 * row quoted in an example cannot satisfy a row. Both directions are scanned:
 * a shape the table does not recognise (a three-cell row, an anchor naming no
 * catalog entry) reds as unclassified instead of passing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { blankMarkdown } from "../../scripts/lib/defect-shapes.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(REPO_ROOT, "docs/pi-lens-reviewer.md");
const SECTION = "Compliance pass";

/** Every row carries a rule anchor: a principles section, a catalog shape, or
 * a named AGENTS.md section. */
const RULE_ANCHOR = [/principles §\d/, /shapes? \d/, /AGENTS "/];

/** Every row names the recurrence that earned it. */
const RECURRENCE = /#\d{3,}/;

/** Column headings the parser depends on, in order. */
const COLUMNS = ["Diff touches", "Check", "Evidence to quote", "Recurrence"];

export interface ComplianceRow {
	cells: string[];
}

/** The section's span in `text`, found on the blanked copy so a heading inside
 * a fence or an HTML comment does not open it. */
export function sectionSpan(text: string): [number, number] | undefined {
	const blanked = blankMarkdown(text);
	const start = blanked.search(new RegExp(`^## ${SECTION}\\s*$`, "m"));
	if (start < 0) return undefined;
	const next = blanked.slice(start + 1).search(/^## /m);
	return [start, next < 0 ? text.length : start + 1 + next];
}

export function sectionBody(text: string): string {
	const span = sectionSpan(text);
	return span ? text.slice(span[0], span[1]) : "";
}

/**
 * Table rows in `markdown`, in document order, without the header and its
 * separator. Structure is read from the blanked copy, so a fence or an HTML
 * comment contributes no rows, while cell text comes from the raw line.
 */
export function tableRows(markdown: string): string[][] {
	const rawLines = markdown.split(/\r?\n/);
	const blanked = blankMarkdown(markdown).split(/\r?\n/);
	const rows: string[][] = [];
	for (const [index, line] of rawLines.entries()) {
		if (!(blanked[index] ?? "").trimStart().startsWith("|")) continue;
		rows.push(
			line
				.trim()
				.replace(/^\|/, "")
				.replace(/\|$/, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
	}
	return rows;
}

/**
 * Structural problems in one data row. Empty when the row is well formed:
 * four cells, a non-empty diff trigger, a rule anchor, quoted evidence, and a
 * named recurrence.
 */
export function rowProblems(row: string[]): string[] {
	const problems: string[] = [];
	if (row.length !== COLUMNS.length)
		problems.push(`expected ${COLUMNS.length} cells, found ${row.length}`);
	const [touches = "", check = "", evidence = "", recurrence = ""] = row;
	if (!touches) problems.push("no diff trigger");
	if (!RULE_ANCHOR.some((anchor) => anchor.test(check)))
		problems.push("check cell names no rule anchor");
	if (!evidence) problems.push("no evidence named");
	if (!RECURRENCE.test(recurrence))
		problems.push("no recurrence (issue or PR number)");
	return problems;
}

/** Every data row of the section's first table, header row removed. */
export function complianceRows(markdown: string): string[][] {
	const rows = tableRows(sectionBody(markdown)).filter(
		(row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === ""),
	);
	return rows.slice(1);
}

describe("reviewer compliance pass (#4585)", () => {
	const markdown = fs.readFileSync(DOC, "utf8");
	const body = sectionBody(markdown);
	const rows = complianceRows(markdown);

	// Recurrence: the 2026-10-17 Greptile threads above; the contract had no
	// diff-keyed pass, so four rules were missed on heads our reviewers read.
	it("keeps a Compliance pass section in the reviewer contract", () => {
		expect(blankMarkdown(markdown)).toMatch(/^## Compliance pass\s*$/m);
		expect(body.trim()).not.toBe("");
	});

	it("names the four diff-keyed columns", () => {
		const header = tableRows(body)[0] ?? [];
		expect(header).toEqual(COLUMNS);
	});

	// Recurrence: the 2026-10-17 Greptile audit added seven judgement rows (lifecycle
	// axes, path provenance, the executing rung, the cache key, the failure-path
	// record, the model plus monitoring doc, and the whole-diff habit), so the
	// count is pinned rather than ranged: a trimmed row is a lost rule.
	it("pins the audited row population", () => {
		expect(rows.length).toBe(23);
	});

	it("gives every row a diff trigger, a rule anchor, evidence and a recurrence", () => {
		const offenders = rows
			.map((row, index) => ({ row, problems: rowProblems(row), index }))
			.filter((entry) => entry.problems.length > 0)
			.map(
				(entry) =>
					`row ${entry.index + 1} (${entry.row[0] ?? "?"}): ${entry.problems.join("; ")}`,
			);
		expect(offenders).toEqual([]);
	});

	// Recurrence: #4585 mechanises the first four rows in
	// scripts/check-pr-body.mjs; without the pointer a reviewer keeps doing
	// the work twice.
	it("points at the lint that mechanises the first four rows", () => {
		expect(body).toContain("#4585");
	});

	it("names no rule anchor outside the catalog and the principles", () => {
		for (const check of rows.map((row) => row[1] ?? "")) {
			expect(
				RULE_ANCHOR.some((anchor) => anchor.test(check)),
				check,
			).toBe(true);
		}
	});
});

describe("compliance-table detector", () => {
	const header = `| ${COLUMNS.join(" | ")} |\n| --- | --- | --- | --- |\n`;

	it("reads no rows from a table quoted in a fence", () => {
		const quoted = [
			"## Compliance pass",
			"",
			"```markdown",
			header,
			"| a new test | principles §2 | a transcript | #4577 |",
			"```",
			"",
		].join("\n");
		expect(complianceRows(quoted)).toEqual([]);
	});

	it("reds a row with no recurrence", () => {
		const doc = [
			"## Compliance pass",
			"",
			header,
			"| a new test | principles §2 | a transcript | nothing yet |",
			"",
		].join("\n");
		const [row] = complianceRows(doc);
		expect(rowProblems(row ?? [])).toContain(
			"no recurrence (issue or PR number)",
		);
	});

	it("reds a row whose check names no rule anchor", () => {
		const doc = [
			"## Compliance pass",
			"",
			header,
			"| a new test | see the docs | a transcript | #4577 |",
			"",
		].join("\n");
		const [row] = complianceRows(doc);
		expect(rowProblems(row ?? [])).toContain("check cell names no rule anchor");
	});

	it("reds a row the table shape does not classify", () => {
		const doc = [
			"## Compliance pass",
			"",
			header,
			"| a new test | principles §2 | #4577 |",
			"",
		].join("\n");
		const [row] = complianceRows(doc);
		expect(rowProblems(row ?? [])).toContain("expected 4 cells, found 3");
	});
});
