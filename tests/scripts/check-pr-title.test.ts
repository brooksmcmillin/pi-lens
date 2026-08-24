import { describe, expect, it } from "vitest";
import {
	MISSING_ISSUE_REF_MESSAGE,
	MISSING_PREFIX_MESSAGE,
	lintPrTitle,
} from "../../scripts/check-pr-title.mjs";

describe("PR title lint (#1844)", () => {
	it("accepts a conventional prefix with an issue ref in the title", () => {
		expect(lintPrTitle("fix: repair the widget cache (refs #123)")).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("accepts a scoped prefix", () => {
		expect(
			lintPrTitle("feat(lsp): add native fallback (closes #456)"),
		).toMatchObject({
			valid: true,
		});
	});

	// Policy (#1917 review F1): the issue ref must live in the TITLE. Merges
	// are merge commits from the PR title, so a ref sitting only in the body
	// never survives into the merge-commit subject line -- it must not
	// rescue an otherwise-unreferenced title. This is the regression case
	// for the fallback (`|| ISSUE_REF.test(body)`) that used to live here.
	it("rejects a title with no issue ref even when the body has one", () => {
		const result = lintPrTitle("chore: tidy scripts", "Refs #789");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_ISSUE_REF_MESSAGE);
	});

	it("rejects a title with no conventional prefix", () => {
		const result = lintPrTitle("Repair the widget cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("rejects a prefix not in the allowed set", () => {
		const result = lintPrTitle("wip: repair the widget cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("rejects a title with no issue reference", () => {
		const result = lintPrTitle("fix: repair the widget cache");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_ISSUE_REF_MESSAGE);
	});

	it("rejects a prefix with no colon-space separator", () => {
		const result = lintPrTitle("fix:repair the cache (#123)");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(MISSING_PREFIX_MESSAGE);
	});

	it("reports both errors when both are missing", () => {
		const result = lintPrTitle("repair the cache");
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			MISSING_PREFIX_MESSAGE,
			MISSING_ISSUE_REF_MESSAGE,
		]);
	});

	it("accepts a cross-repo style issue ref count in the title (# followed by digits only)", () => {
		expect(lintPrTitle("fix: repair cache #123")).toMatchObject({
			valid: true,
		});
	});
});
