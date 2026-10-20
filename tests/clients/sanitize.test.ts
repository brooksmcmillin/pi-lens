import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../clients/sanitize.js";

describe("stripAnsi", () => {
	it("removes basic color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("removes extended escape sequences", () => {
		expect(stripAnsi("\x1b[2Jhello")).toBe("hello");
	});

	// #2461 round-2 (S3-r2): ANSI_ESCAPE_EXTENDED was widened from the
	// `[0-9;]*[A-Za-z]`-only-letters form to the full ECMA-48 CSI grammar
	// (parameter bytes `0-9;?`, intermediate bytes ` -/`, final byte `@-~`) so
	// it also strips private-mode sequences (`?`), sequences with an
	// intermediate byte (a space before the final letter), and final bytes
	// outside A-Za-z (`@`). These three cases were unpinned by any test — the
	// narrow pre-widening regex left all of them unmatched — so a silent
	// revert of the widening would pass the full suite. Mutation-proved:
	// reverting ANSI_ESCAPE_EXTENDED to `/\x1b\[[0-9;]*[A-Za-z]/g` reds all
	// three.
	it("removes a private-mode cursor-visibility sequence (CSI ? 25 l)", () => {
		expect(stripAnsi("\x1b[?25l")).toBe("");
	});

	it("removes a sequence with an intermediate byte (CSI 1;2 SP q)", () => {
		expect(stripAnsi("\x1b[1;2 q")).toBe("");
	});

	it("removes a sequence whose final byte is outside A-Za-z (CSI 1 @)", () => {
		expect(stripAnsi("\x1b[1@x")).toBe("x");
	});

	it("passes plain text through unchanged", () => {
		expect(stripAnsi("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});
});
