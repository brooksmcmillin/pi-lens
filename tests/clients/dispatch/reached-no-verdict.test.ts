/**
 * #4484 round 3, R1: a run has a verdict only when it read the file and
 * finished. A skip states a not-applicable reason from the closed taxonomy, or
 * it reached no verdict.
 *
 * Recurrence: `reachedNoVerdict` read every skip without an unavailable
 * primary as a verdict, so the LSP line-limit skip, the ast-grep size-cap skip
 * and the tree-sitter WASM-abort skip retired recorded blockers (review probes
 * P1 to P3, TLC MutSkipVerdict).
 */
import { describe, expect, it } from "vitest";
import {
	RUNNER_SKIP_REASONS,
	reachedNoVerdict,
} from "../../../clients/dispatch/types.js";

describe("reachedNoVerdict (#4484 round 3)", () => {
	it("reads a skip with a stated not-applicable reason as a verdict", () => {
		for (const skipReason of RUNNER_SKIP_REASONS) {
			expect(reachedNoVerdict({ status: "skipped", skipReason })).toBe(false);
		}
	});

	it("reads a skip without a stated reason as no verdict", () => {
		expect(reachedNoVerdict({ status: "skipped" })).toBe(true);
	});

	it("reads a skip naming a reason outside the taxonomy as no verdict", () => {
		expect(
			reachedNoVerdict({
				status: "skipped",
				skipReason: "file-too-large" as never,
			}),
		).toBe(true);
	});
});
