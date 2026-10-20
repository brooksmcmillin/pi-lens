/**
 * #4484 round 3 (R3): a recorded finding is kept by an observation only of
 * the same identity at its own position.
 *
 * Recurrence it prevents: identity alone let an untouched occurrence of the
 * same rule keep a fixed blocker alive and hold the commit gate shut on a line
 * the agent never touched (review F1, TLC MutTwinIdentity).
 */
import { describe, expect, it } from "vitest";
import {
	ANY_POSITION,
	retainRecordedFindings,
} from "../../clients/finding-identity.js";

type F = { tool: string; rule: string; message: string; line: number };
const f = (line: number, message = "returns unknown"): F => ({
	tool: "ast-grep-napi",
	rule: "no-unknown-returns",
	message,
	line,
});
const never = () => false;

describe("retainRecordedFindings", () => {
	it("retires a fixed finding although the same rule still matches elsewhere", () => {
		const fixed = f(6);
		const untouched = f(3);
		const { kept, retired } = retainRecordedFindings([fixed], [untouched], {
			positionOf: (d) => d.line,
			keepUnobserved: never,
		});
		expect(kept).toEqual([]);
		expect(retired).toEqual([fixed]);
	});

	it("keeps a moved finding as its observed copy at the mapped line", () => {
		const recorded = f(6);
		const observed = f(7);
		const { kept } = retainRecordedFindings([recorded], [f(4), observed], {
			positionOf: (d) => d.line + 1,
			keepUnobserved: never,
		});
		expect(kept).toEqual([observed]);
		expect(kept[0]).toBe(observed);
	});

	it("matches nothing for a finding whose line was edited", () => {
		const recorded = f(6);
		const { kept, retired } = retainRecordedFindings([recorded], [f(6)], {
			positionOf: () => undefined,
			keepUnobserved: never,
		});
		expect(kept).toEqual([]);
		expect(retired).toEqual([recorded]);
	});

	it("keeps an unmatched finding whose source reached no verdict", () => {
		const recorded = f(6);
		const { kept } = retainRecordedFindings([recorded], [], {
			positionOf: (d) => d.line,
			keepUnobserved: () => true,
		});
		expect(kept).toEqual([recorded]);
	});

	// helm-lint cites its own line in the message: after an edit above it the
	// message changes with the line, and the moved finding must still match.
	it("folds the digits of a message that cites its own line", () => {
		const recorded = f(4, "deploy.yaml:4: nil pointer");
		const observed = f(5, "deploy.yaml:5: nil pointer");
		const { kept } = retainRecordedFindings([recorded], [observed], {
			positionOf: (d) => d.line + 1,
			keepUnobserved: never,
		});
		expect(kept).toEqual([observed]);
	});

	it("does not let a different message at the same line stand in", () => {
		const recorded = f(2, "Cannot find name 'BAD_CALL'.");
		const { kept } = retainRecordedFindings(
			[recorded],
			[f(2, "Cannot find name 'BAD_OTHER'.")],
			{ positionOf: (d) => d.line, keepUnobserved: never },
		);
		expect(kept).toEqual([]);
	});

	// Round 4 (G1, verify probes P11c, P11d, P18): with no alignment the carry
	// read the recorded line number as it was, found nothing there, and
	// retired a blocker still on disk. Without a position it matches its
	// identity anywhere instead, which fails closed.
	it("matches an unaligned finding by its identity at any line", () => {
		const recorded = f(3);
		const moved = f(1103);
		const { kept, retired } = retainRecordedFindings([recorded], [moved], {
			positionOf: () => ANY_POSITION,
			keepUnobserved: never,
		});
		expect(kept).toEqual([moved]);
		expect(retired).toEqual([]);
	});

	it("retires an unaligned finding whose identity nothing observes", () => {
		const recorded = f(3);
		const { kept, retired } = retainRecordedFindings(
			[recorded],
			[f(9, "returns any")],
			{ positionOf: () => ANY_POSITION, keepUnobserved: never },
		);
		expect(kept).toEqual([]);
		expect(retired).toEqual([recorded]);
	});

	it("lets a positioned finding take its own match before an unaligned one", () => {
		const positioned = f(6);
		const unaligned = f(2);
		const atSix = f(6);
		const { kept, retired } = retainRecordedFindings(
			[unaligned, positioned],
			[atSix],
			{
				positionOf: (d) => (d === unaligned ? ANY_POSITION : d.line),
				keepUnobserved: never,
			},
		);
		expect(kept).toEqual([atSix]);
		expect(retired).toEqual([unaligned]);
	});
	// Round 5 (K1, verify probe P22): identity anywhere let an untouched,
	// never-delivered occurrence with other text take over a fixed blocker.
	// Only an observed finding `matchesAnywhere` admits (its line holds the
	// recorded text) stands in.
	it("matches an unplaced finding only where its own text is", () => {
		const recorded = f(2);
		const otherText = f(5);
		const sameText = f(9);
		const { kept, retired } = retainRecordedFindings(
			[recorded],
			[otherText, sameText],
			{
				positionOf: () => ANY_POSITION,
				keepUnobserved: never,
				matchesAnywhere: (_prior, observed) => observed !== otherText,
			},
		);
		expect(kept).toEqual([sameText]);
		expect(retired).toEqual([]);
		const alone = retainRecordedFindings([recorded], [otherText], {
			positionOf: () => ANY_POSITION,
			keepUnobserved: never,
			matchesAnywhere: (_prior, observed) => observed !== otherText,
		});
		expect(alone.retired).toEqual([recorded]);
	});
});
