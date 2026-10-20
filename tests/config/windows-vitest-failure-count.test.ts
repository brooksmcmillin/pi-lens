import { describe, expect, it } from "vitest";
import {
	parseWindowsVitestExecutedCount,
	parseWindowsVitestFailureCount,
} from "../../scripts/lib/windows-vitest-failure-count.mjs";

describe("Windows Vitest failure count", () => {
	it("parses the ANSI-colored CRLF runner line from job 112724408671", () => {
		// Recurrence: #4042 review round 3 — the Windows tee log's padded,
		// ANSI-colored CRLF summary was rendered as an unknown failure count.
		const line =
			"\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m57 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1703 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m19 skipped\x1b[39m\x1b[22m\x1b[90m (1779)\x1b[39m\r\n";
		expect(parseWindowsVitestFailureCount(line)).toBe(57);
	});

	it("keeps an absent summary unknown", () => {
		expect(parseWindowsVitestFailureCount("Vitest crashed\r\n")).toBeNull();
	});

	// Recurrence #4518: the Windows advisory read only `outcome == failure`, so a
	// subset that executed nothing (every file skipped) was green.
	it("counts executed tests: passed plus failed, never skipped", () => {
		const line =
			"\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m57 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1703 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m19 skipped\x1b[39m\x1b[22m\x1b[90m (1779)\x1b[39m\r\n";
		expect(parseWindowsVitestExecutedCount(line)).toBe(1760);
		expect(
			parseWindowsVitestExecutedCount(
				"      Tests  2516 passed | 26 skipped (2542)\n",
			),
		).toBe(2516);
		expect(
			parseWindowsVitestExecutedCount("      Tests  26 skipped (26)\n"),
		).toBeNull();
	});

	it("keeps an absent summary unknown for the executed count too", () => {
		expect(parseWindowsVitestExecutedCount("Vitest crashed\r\n")).toBeNull();
	});
});
