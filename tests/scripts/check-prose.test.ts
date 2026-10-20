import { describe, expect, it } from "vitest";
import { checkProse } from "../../scripts/check-prose.mjs";
import { lintPrBody } from "../../scripts/check-pr-body.mjs";
import { htmlCommentEnd } from "../../scripts/lib/defect-shapes.mjs";

describe("checkProse", () => {
	it("blocks the long sentence from the #4274 comment", () => {
		const result = checkProse(
			"The harness derives repoRoot from import.meta.url, and its sibling worktree case uses two scratch projects, not git worktree add, while the surrounding selection runs many files concurrently and makes the timing-sensitive case fail only under contention.",
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("sentence-length");
	});

	it("accepts clean prose and reports passive voice as a warning", () => {
		const result = checkProse("Run the focused test. Read the result.");
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
		const passive = checkProse("The result was recorded.");
		expect(passive.valid).toBe(true);
		expect(passive.warnings.join(" ")).toContain("passive-voice");
	});

	it("does not count code, URLs, tables, blockquotes, or log lines", () => {
		const text = [
			"```text",
			"This line contains far more than thirty ordinary words and must remain ignored because it is a transcript or code block that users paste for evidence while reviewing a change in CI.",
			"```",
			"https://example.com/a/very-long-url-that-is-not-prose",
			"> This quoted line contains far more than thirty words and must remain ignored.",
			"FAIL This log line contains far more than thirty words and must remain ignored.",
			"| A | This table cell contains far more than thirty words and must remain ignored. |",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("blocks please and downgrades it in warn mode", () => {
		const result = checkProse("Please do the requested check.");
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('remove "please"');
		const warning = checkProse("Please do the requested check.", {
			mode: "warn",
		});
		expect(warning).toMatchObject({ valid: true, errors: [] });
		expect(warning.warnings.join(" ")).toContain('remove "please"');
	});

	it("ignores comments, generated footers, and trailing metadata", () => {
		const long =
			"This generated metadata contains enough ordinary words to exceed the prose limit and must remain ignored when the checker reads a body supplied by a hosting service.";
		const text = [
			"<!--",
			long,
			"-->",
			long.replace("generated metadata", "footer metadata"),
			"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
			"Co-Authored-By: Example <example@example.com>",
			"Signed-off-by: Example <example@example.com>",
			"Refs: #4280",
			"Closes: #4280",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("keeps abbreviations, paths, versions, and list items stable", () => {
		const result = checkProse(
			"- Handle e.g. scripts/check-prose.mjs and version 1.2.3.\n- Run the clean test.",
		);
		expect(result.valid).toBe(true);
	});

	it("splits ordered and unordered list items into sentences", () => {
		const item =
			"3. **Warn:** a retired glossary term in prose. Read the retired terms from the AGENTS.md glossary at run time, so the list never drifts. The glossary sweep test already parses that source. Warn only, because several retirements depend on context.";
		expect(checkProse(item)).toEqual({ valid: true, errors: [], warnings: [] });
		expect(
			checkProse(
				"- This deliberately has enough ordinary words to exceed the prose limit because it never reaches a terminal sentence boundary and must remain one sentence while the checker preserves this unbroken paragraph for its length guard.",
			).errors.join(" "),
		).toContain("sentence-length");
	});

	it("can downgrade blocking findings in warn mode", () => {
		const result = checkProse("Please simply do this.", { mode: "warn" });
		expect(result).toMatchObject({ valid: true, errors: [] });
		expect(result.warnings.join(" ")).toContain("filler");
	});

	const longAfterEnd =
		"This deliberately long sentence sits after a comment close and contains enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never miss visible text.";
	// Recurrence (#4565): this masker ended an HTML comment at `-->` alone,
	// so text GitHub renders after `--!>`, `<!-->` or `<!--->` was masked,
	// and a gating rule read visible prose as absent. Each row names one of
	// the four ends the HTML spec gives a comment (13.2.5.43-46).
	const commentEnds: Array<[string, string]> = [
		["`-->`", `<!-- note --> ${longAfterEnd}`],
		["`--!>`", `<!-- note --!> ${longAfterEnd}`],
		["`<!-->`", `<!--> ${longAfterEnd}`],
		["`<!--->`", `<!---> ${longAfterEnd}`],
	];
	for (const [end, text] of commentEnds)
		it(`counts a long sentence after the ${end} end`, () => {
			expect(checkProse(text).errors.join(" ")).toContain("sentence-length");
		});

	it("still hides a long sentence inside a comment", () => {
		const hidden =
			"This comment body sits inside the comment and carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never count hidden text as prose.";
		expect(
			checkProse(`<!-- ${hidden} --> Run the test.`).errors.join(" "),
		).not.toContain("sentence-length");
	});

	it("hides a continuation line that starts with the abrupt-end dash", () => {
		// Recurrence (#4565 round 7): the masker calls the owner at index 0 of a
		// continuation line, where the comment is in body state, but the owner
		// applied its `>` and `->` abrupt-end arms at every `from`. A line that
		// starts with `->` then closed the comment early and hidden words
		// reached the gate. Both arms belong to the comment-start states only.
		const hidden =
			"This comment continuation carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never count hidden text as prose.";
		const result = checkProse(`<!--\n-> ${hidden}\n--> Run the test.`);
		expect(result.errors.join(" ")).not.toContain("sentence-length");
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("applies the abrupt ends at the opener only, never mid-comment", () => {
		// The owner's precondition, which F1 in the round-7 verify walked into:
		// `>` and `->` close inside `<!--` itself, so they answer only when `from`
		// is the opener's end. check-prose skips a blockquote line before it
		// masks, so no masker row reaches the `>` arm; this pins the contract the
		// next per-line consumer inherits.
		expect(htmlCommentEnd("<!--> tail", 4)).toBe(5);
		expect(htmlCommentEnd("<!---> tail", 4)).toBe(6);
		expect(htmlCommentEnd("> tail", 0)).toBe(-1);
		expect(htmlCommentEnd("-> tail", 0)).toBe(-1);
	});

	it("applies the checker to PR prose sections only", () => {
		const long =
			"This sentence has enough ordinary words to exceed the prose limit and should fail when it appears in a Summary section because the PR body gate checks that section during every local and CI validation run.";
		const body = `## Why\nShort reason.\n\n## Notes for the reviewer\nShort note.\n\n## Summary\n${long}\n\n## Tests\n\`\`\`text\n${long}\n\`\`\`\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.`;
		expect(lintPrBody(body, { workingTree: true }).errors.join(" ")).toContain(
			"sentence-length",
		);
		expect(
			lintPrBody(body, { proseMode: "warn" }).errors.join(" "),
		).not.toContain("sentence-length");
	});
});
