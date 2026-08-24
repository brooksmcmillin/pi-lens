import { describe, expect, it } from "vitest";
import {
	INVALID_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywords,
	parseCloseKeywords,
} from "../../scripts/check-close-keywords.mjs";

describe("close-keyword parser (#1320)", () => {
	it("parses one close keyword", () => {
		expect(parseCloseKeywords("Closes #123")).toMatchObject({
			issues: [123],
			commaLists: [],
		});
	});

	it("parses multiple correctly separated close keywords", () => {
		expect(
			parseCloseKeywords("Fixes #1. resolves #2; CLOSED #3"),
		).toMatchObject({
			issues: [1, 2, 3],
			commaLists: [],
		});
	});

	it("flags a comma-separated close list", () => {
		expect(lintCloseKeywords("Closes #123, #456")).toMatchObject({
			issues: [123],
			commaLists: [123],
			valid: false,
		});
	});

	it("accepts comma punctuation between separately keyworded issues", () => {
		expect(lintCloseKeywords("Closes #123, fixes #456").valid).toBe(true);
	});

	it("does not treat refs as close keywords", () => {
		expect(parseCloseKeywords("Refs #123, relates to #456")).toMatchObject({
			issues: [],
			commaLists: [],
		});
	});

	it("handles case variants and optional colon", () => {
		expect(
			parseCloseKeywords("CLOSES: #7; FiXeD #8; ResolveD #9").issues,
		).toEqual([7, 8, 9]);
	});

	it("ignores cross-repository references", () => {
		expect(
			parseCloseKeywords("Closes owner/repo#123; fixes #456"),
		).toMatchObject({
			issues: [456],
			commaLists: [],
		});
	});

	it("deduplicates repeated issue references", () => {
		expect(parseCloseKeywords("Closes #12. Fixes #12").issues).toEqual([12]);
	});

	it("exposes the exact lint failure message", () => {
		expect(INVALID_CLOSE_KEYWORD_MESSAGE).toBe(
			'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").',
		);
	});

	// #1355 review: quoted examples are documentation, not intent.
	it("ignores close keywords inside fenced code blocks", () => {
		const result = lintCloseKeywords(
			"Real.\n```\nCloses #1, #2\n```\nCloses #99.",
		);
		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([99]);
	});

	it("ignores close keywords in blockquotes and inline code", () => {
		expect(lintCloseKeywords("> Closes #1, #2\nCloses #99.").valid).toBe(true);
		expect(
			lintCloseKeywords("Use `Closes #1, #2` never. Closes #7.").valid,
		).toBe(true);
	});

	it("reports the offending line for a comma list", () => {
		const result = lintCloseKeywords("Intro.\nCloses #12, #13\nOutro.");
		expect(result.valid).toBe(false);
		expect(result.offendingLines).toEqual(["Closes #12, #13"]);
	});
});
