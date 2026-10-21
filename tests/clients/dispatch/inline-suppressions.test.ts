import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	applyInlineSuppressions,
	parseInlineSuppressionRuleIds,
	splitInlineSuppressionPayload,
	type SuppressibleDiagnostic,
} from "../../../clients/dispatch/inline-suppressions.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";

type D = SuppressibleDiagnostic & { message?: string };

describe("applyInlineSuppressions (#442 — shared by mode=all + mode=full)", () => {
	it("suppresses a finding via a same-line `# pi-lens-ignore` comment", () => {
		const content = "import os\neval(x)  # pi-lens-ignore: no-eval\n";
		const diags: D[] = [{ line: 2, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	it("suppresses via a comment on the line immediately above", () => {
		const content = "# pi-lens-ignore: no-eval\neval(x)\n";
		const diags: D[] = [{ line: 2, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	it("supports the // comment style and multiple comma-separated rules", () => {
		const content = "eval(x); // pi-lens-ignore: no-eval, no-debugger\n";
		const diags: D[] = [
			{ line: 1, rule: "no-eval" },
			{ line: 1, rule: "no-debugger" },
			{ line: 1, rule: "other-rule" },
		];
		expect(applyInlineSuppressions(diags, content).map((d) => d.rule)).toEqual([
			"other-rule",
		]);
	});

	it("keeps text after a non-final reason separator out of the rule list", () => {
		// Regression: a separator before a comma used to make the later text a
		// second rule, so `no-b` was suppressed by this malformed payload.
		const content = "// pi-lens-ignore: no-a -- reason, no-b\n";
		const diags: D[] = [
			{ line: 1, rule: "no-a" },
			{ line: 1, rule: "no-b" },
		];
		expect(applyInlineSuppressions(diags, content).map((d) => d.rule)).toEqual([
			"no-b",
		]);
	});

	it("does not parse commas inside a trailing reason as rule ids", () => {
		// Regression: a comma in reason prose used to suppress a rule named by the
		// prose after the comma.
		const content = "// pi-lens-ignore: no-a -- reason, with comma\n";
		const diags: D[] = [
			{ line: 1, rule: "no-a" },
			{ line: 1, rule: "with comma" },
		];
		expect(applyInlineSuppressions(diags, content).map((d) => d.rule)).toEqual([
			"with comma",
		]);
	});

	for (const [separator, explanation] of [
		[" -- ", "an intentional exception"],
		[" — ", "an intentional exception"],
		[": ", "an intentional exception"],
	] as const) {
		it(`ignores a trailing reason after ${separator.trim()}`, () => {
			const content = `eval(x); // pi-lens-ignore: no-eval${separator}${explanation}\n`;
			const diags: D[] = [{ line: 1, rule: "no-eval" }];
			expect(applyInlineSuppressions(diags, content)).toEqual([]);
		});
	}

	it("does NOT suppress a different rule or an out-of-range line", () => {
		// The comment on line 1 covers line 1 + line 2 (next-line semantics), so the
		// "different line" case uses line 3 to stay out of range.
		const content = "eval(x)  # pi-lens-ignore: no-eval\nalert(1)\neval(y)\n";
		const diags: D[] = [
			{ line: 1, rule: "no-alert" }, // same line, different rule
			{ line: 3, rule: "no-eval" }, // same rule, out-of-range line
		];
		expect(applyInlineSuppressions(diags, content)).toEqual(diags);
	});

	it("matches by the id field when rule is absent", () => {
		const content = "x  # pi-lens-ignore: my-check\n";
		const diags: D[] = [{ line: 1, id: "my-check" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	// The mode=full parity fix: findings surface as `ast-grep:<id>` / `<id>-js`
	// in some surfaces, but a user writes the bare id — both must suppress (#442).
	it("suppresses a normalized rule id (ast-grep: prefix / -js suffix)", () => {
		const content = "eval(x)  # pi-lens-ignore: no-eval\n";
		expect(
			applyInlineSuppressions([{ line: 1, rule: "ast-grep:no-eval" }], content),
		).toEqual([]);
		expect(
			applyInlineSuppressions([{ line: 1, rule: "no-eval-js" }], content),
		).toEqual([]);
	});

	it("suppresses a Pyright language-server copy by the bare code in the comment (#4629)", () => {
		const content =
			'value: int = "s"  # pi-lens-ignore: reportAssignmentType\n';
		for (const rule of [
			"Pyright:reportAssignmentType",
			"basedpyright:reportAssignmentType",
			"reportAssignmentType",
		]) {
			expect(applyInlineSuppressions([{ line: 1, rule }], content)).toEqual([]);
		}
		const foreign: D[] = [{ line: 1, rule: "ty:reportAssignmentType" }];
		expect(applyInlineSuppressions(foreign, content)).toEqual(foreign);
	});

	it("preserves a colon inside a namespaced rule id", () => {
		const content = "eval(x)  # pi-lens-ignore: ast-grep:no-eval\n";
		const diags: D[] = [{ line: 1, rule: "ast-grep:no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	// #1087 P3-1: the COMMENT token is now normalized too, not just the
	// diagnostic id. Previously a language-suffixed comment token (`no-eval-js`)
	// failed to suppress a finding surfaced under the normalized bare id
	// (`no-eval`), even though the identical `disable: ["no-eval-js"]` config key
	// worked (rule-policy normalizes both sides). The two surfaces are now
	// symmetric.
	it("suppresses via a language-suffixed comment token against a normalized id (#1087)", () => {
		const content = "eval(x)  # pi-lens-ignore: no-eval-js\n";
		expect(
			applyInlineSuppressions([{ line: 1, rule: "no-eval" }], content),
		).toEqual([]);
	});

	it("is a no-op when there are no ignore comments", () => {
		const content = "eval(x)\nalert(1)\n";
		const diags: D[] = [{ line: 1, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toBe(diags);
	});

	// #692: a scan reconcile (`lens_diagnostics mode=full`, `lsp_diagnostics`)
	// used to bake its scan-provenance label straight into `rule`
	// (`lens_diagnostics_full:no-eval`), which `normalizeSuppressRule` doesn't
	// strip — an inline `pi-lens-ignore: no-eval` comment suppressed the
	// per-edit-written entry but NOT the scan-written one. Now that
	// `scanOrigin` never touches `rule`, a scan conversion produces the exact
	// same `ast-grep:<id>` rule the per-edit path does, so suppression round-
	// trips identically regardless of which path wrote the entry.
	it("suppresses a scan-written entry (convertLspDiagnostics with scanOrigin) exactly like a per-edit one (#692)", () => {
		const content = "eval(x)  # pi-lens-ignore: no-eval\n";
		const raw: LSPDiagnostic[] = [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
				message: "no-eval finding",
				severity: 2,
				source: "ast-grep",
				code: "no-eval",
			} as LSPDiagnostic,
		];
		const perEdit = convertLspDiagnostics(raw, "/repo/a.js");
		const scanned = convertLspDiagnostics(raw, "/repo/a.js", {
			scanOrigin: "lens_diagnostics_full",
		});
		expect(applyInlineSuppressions(perEdit, content)).toEqual([]);
		expect(applyInlineSuppressions(scanned, content)).toEqual([]);
	});
});

// #4365 rotation batch 1: survivors of the per-module Stryker campaign. Each
// comment names the mutants the case kills. The redundant guards in
// splitInlineSuppressionPayload (`reasonMatch === null || trailingReason ===
// undefined`: both halves are true together) and the `.+` tails of
// TRAILING_REASON_RE (`.+` already absorbs extra whitespace and runs to the
// end of a single-line payload) are equivalent mutants and are not pinned.
describe("inline suppression syntax survivors (#4365)", () => {
	it("accepts the marker with no, one or several spaces before it and no space after the colon", () => {
		// Kills SUPPRESS_RE's `\s*` before `pi-lens-ignore` as `\s`, and
		// `:\s*(.+)` as `:\s(.+)` or `:\S*(.+)` (the latter captured only the
		// tail `a` of `rule-a`, suppressing the wrong rule).
		const diags = (): D[] => [{ line: 1, rule: "rule-a" }];
		for (const comment of [
			"x(); //pi-lens-ignore: rule-a",
			"x(); //    pi-lens-ignore: rule-a",
			"x(); // pi-lens-ignore:rule-a",
		]) {
			expect(applyInlineSuppressions(diags(), `${comment}\n`), comment).toEqual(
				[],
			);
		}
	});

	it("never lets an empty entry in the rule list match a diagnostic that carries no rule id", () => {
		// Kills `.filter(Boolean)` dropped from parseInlineSuppressionRuleIds: a
		// trailing or doubled comma left `""` in the list, and a finding with no
		// rule id (rawId `""`) was suppressed by `pi-lens-ignore: other,`.
		expect(parseInlineSuppressionRuleIds("no-a, ,no-b,")).toEqual([
			"no-a",
			"no-b",
		]);
		const ruleless: D[] = [{ line: 1 }];
		expect(
			applyInlineSuppressions(ruleless, "x(); // pi-lens-ignore: other,\n"),
		).toEqual(ruleless);
	});

	it("keeps the whole whitespace run before a reason separator out of the rule list", () => {
		// Kills `\s+--\s+` as `\s--\s+` and `\s+—\s+` as `\s—\s+`: with two
		// spaces before the separator the match started one space late, so the
		// rule list kept a trailing space and the reason lost a leading one.
		expect(splitInlineSuppressionPayload("no-a  -- because")).toEqual({
			ruleList: "no-a",
			trailingReason: "  -- because",
		});
		expect(splitInlineSuppressionPayload("no-a  — because")).toEqual({
			ruleList: "no-a",
			trailingReason: "  — because",
		});
	});

	it("returns the same array when there is nothing to filter, even if the file holds a suppression", () => {
		// Kills the `!content || !diagnostics.length` guard forced false or turned
		// `&&` (documented "same array if nothing is suppressed"): an empty
		// diagnostics list went through the scan and came back as a new array.
		const none: D[] = [];
		expect(applyInlineSuppressions(none, "x(); // pi-lens-ignore: a\n")).toBe(
			none,
		);
	});

	it("keeps a finding whose id normalizes to a different form when no comment names it", () => {
		// Kills the final `normId === rawId || !suppressed.has(...)` turned `&&`:
		// any finding reported as `ast-grep:<id>` (normalized form differs from the
		// raw one) was dropped as soon as the file held ANY unrelated suppression.
		const prefixed: D[] = [{ line: 5, rule: "ast-grep:no-eval" }];
		expect(
			applyInlineSuppressions(prefixed, "x(); // pi-lens-ignore: unrelated\n"),
		).toEqual(prefixed);
	});
});
