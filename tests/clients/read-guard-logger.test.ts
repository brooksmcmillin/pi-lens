/**
 * #1913: `read_cap_trimmed` must survive `read-guard-logger`'s verbosity
 * gate at DEFAULT verbosity (PI_LENS_READ_GUARD_VERBOSE unset), while the
 * per-read `read_recorded` event stays gated as before.
 */
import { describe, expect, it } from "vitest";
import { shouldLogEvent } from "../../clients/read-guard-logger.js";

describe("shouldLogEvent", () => {
	it("always logs read_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("read_cap_trimmed")).toBe(true);
	});

	it("keeps read_recorded gated behind verbose mode", () => {
		expect(shouldLogEvent("read_recorded")).toBe(false);
	});

	it("still logs the pre-existing always-on events", () => {
		expect(shouldLogEvent("edit_blocked")).toBe(true);
	});
});
