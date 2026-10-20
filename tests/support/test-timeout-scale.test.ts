import { describe, expect, it } from "vitest";
import { scaledTestTimeout, testTimeoutScale } from "./test-timeout-scale.js";

describe("test-timeout-scale", () => {
	it("multiplies a budget by the factor the lane declares", () => {
		// 3 is the Windows unit leg's declared factor (ci.yml
		// `PI_LENS_TEST_TIMEOUT_SCALE: '3'`), the lane that motivated the seam.
		expect(scaledTestTimeout(60_000, { PI_LENS_TEST_TIMEOUT_SCALE: "3" })).toBe(
			180_000,
		);
		expect(scaledTestTimeout(60_000, { PI_LENS_TEST_TIMEOUT_SCALE: "1" })).toBe(
			60_000,
		);
	});

	it("leaves the budget unscaled when the lane declares nothing", () => {
		expect(testTimeoutScale({})).toBe(1);
		expect(scaledTestTimeout(60_000, {})).toBe(60_000);
	});

	it("falls back to an unscaled budget for a zero, negative or unparseable factor", () => {
		// A zero or NaN factor would hand Vitest a zero budget, so each of these
		// must resolve to 1 rather than to the parsed value.
		for (const raw of ["0", "-2", "abc", "", "NaN", "Infinity", " -0 "]) {
			expect(testTimeoutScale({ PI_LENS_TEST_TIMEOUT_SCALE: raw }), raw).toBe(
				1,
			);
			expect(
				scaledTestTimeout(60_000, { PI_LENS_TEST_TIMEOUT_SCALE: raw }),
				raw,
			).toBe(60_000);
		}
	});

	it("reads the live process environment by default", () => {
		const original = process.env.PI_LENS_TEST_TIMEOUT_SCALE;
		try {
			process.env.PI_LENS_TEST_TIMEOUT_SCALE = "2";
			expect(testTimeoutScale()).toBe(2);
		} finally {
			if (original === undefined) delete process.env.PI_LENS_TEST_TIMEOUT_SCALE;
			else process.env.PI_LENS_TEST_TIMEOUT_SCALE = original;
		}
	});
});
