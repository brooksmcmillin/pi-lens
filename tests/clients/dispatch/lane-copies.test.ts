/**
 * Direct witnesses for `laneCopyStandsFor` (#4509; #4629 review F1).
 *
 * The dispatcher-flow case that used to prove the drop arm now shares its
 * output with the overlap dedupe (#4629 keys both on the normalized rule), so
 * a `laneCopyStandsFor` that never drops stays green there. This file pins the
 * seam itself: an answering lane's copy stands for the covered run's finding
 * where it flags the same rule on the same line at an equal or stronger
 * semantic, and never where it does not.
 */
import { describe, expect, it } from "vitest";
import { laneCopyStandsFor } from "../../../clients/dispatch/lane-copies.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

function copy(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		id: "ast-grep:napi-copy",
		message: "eval() is forbidden",
		filePath: "app.ts",
		line: 3,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep-napi",
		rule: "no-eval",
		...overrides,
	};
}

describe("laneCopyStandsFor", () => {
	it("stands for an equal copy of the rule on the same line", () => {
		expect(laneCopyStandsFor([copy()])(copy())).toBe(true);
	});

	it("stands for a stronger copy of the rule on the same line", () => {
		const lane = copy({ severity: "error", semantic: "blocking" });
		expect(
			laneCopyStandsFor([lane])(
				copy({ severity: "warning", semantic: "warning" }),
			),
		).toBe(true);
	});

	it("never stands for a weaker copy of the rule on the same line", () => {
		const lane = copy({ severity: "warning", semantic: "warning" });
		expect(laneCopyStandsFor([lane])(copy())).toBe(false);
	});

	it("never stands for a different rule on the same line", () => {
		expect(laneCopyStandsFor([copy({ rule: "other-rule" })])(copy())).toBe(
			false,
		);
	});

	it("never stands for the same rule on another line", () => {
		expect(laneCopyStandsFor([copy({ line: 9 })])(copy())).toBe(false);
	});

	it("reads the lane's `ast-grep:` spelling as the run's bare rule", () => {
		const lane = copy({ rule: "ast-grep:no-eval" });
		expect(laneCopyStandsFor([lane])(copy({ rule: "no-eval" }))).toBe(true);
	});

	it("judges a copy with no line as line 1 on both sides", () => {
		const lane = copy({ line: undefined });
		expect(laneCopyStandsFor([lane])(copy({ line: undefined }))).toBe(true);
	});
});
