/**
 * #3662: a subagent that binds between the primary's replacement
 * `session_shutdown` and its successor's `session_start` must not take the
 * primary slot, and must not demote the real successor.
 *
 * The recurrence these guard: `releasePrimarySession()` (#2129 F3) leaves the
 * process with no registered primary for the whole replacement gap, so a gap
 * `startup` start classified `primary`, registered itself, and the reloaded
 * primary's own start then probed a live foreign ctx and classified
 * `concurrent-secondary` — skipping the full `handleSessionStart`.
 *
 * Everything here drives the real `decideSessionStart`/`releasePrimarySession`
 * pair that `index.ts` calls; nothing is mocked. The start and shutdown
 * reasons are pi 0.85.1's own vocabulary (`SessionStartEvent.reason` /
 * `SessionShutdownEvent.reason`, `core/extensions/types.d.ts`): every
 * replacement shutdown (`reload`, `new`, `resume`, `fork`) is followed by a
 * start carrying the same reason (`core/agent-session-runtime.js`,
 * `core/agent-session.js` `reload()`), and `startup` is only a runtime's first
 * bind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetSessionLifecycleForTests,
	decideSessionStart,
	getActiveSessionId,
	getSecondarySessionCount,
	releasePrimarySession,
	SUCCESSOR_PENDING_TTL_MS,
} from "../../clients/session-lifecycle.js";

const REPO = "/repo/host";
const TEMP_ROOT = "/tmp/subagent-wt";

function liveCtx(): unknown {
	return { isIdle: () => true };
}

function successorPendingReasons(): Array<{
	subject: string;
	reason: string;
}> {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "session-successor-pending",
		)?.latestReasons ?? []
	);
}

/** The primary starts, then shuts down for `reason` (pi releases it). */
function primaryShutsDown(reason: string | undefined): void {
	const first = decideSessionStart(liveCtx(), "host-session", REPO, "startup");
	expect(first.classification).toBe("primary");
	releasePrimarySession(reason);
}

describe("successor-pending gap (#3662)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	for (const root of [REPO, TEMP_ROOT]) {
		it(`a gap subagent in ${root} declines and the reloaded primary runs the full start`, () => {
			primaryShutsDown("reload");

			const gap = decideSessionStart(liveCtx(), "subagent", root, "startup");
			expect(gap.classification).toBe("concurrent-secondary");
			expect(gap.runFullSessionStart).toBe(false);
			expect(getActiveSessionId()).toBeUndefined();

			const successor = decideSessionStart(
				liveCtx(),
				"host-session",
				REPO,
				"reload",
			);
			expect(successor.classification).toBe("primary");
			expect(successor.runFullSessionStart).toBe(true);
			expect(getActiveSessionId()).toBe("host-session");
		});
	}

	for (const reason of ["new", "resume", "fork"]) {
		it(`the ${reason} successor with a new session id is primary after a gap subagent`, () => {
			primaryShutsDown(reason);
			decideSessionStart(liveCtx(), "subagent", REPO, "startup");

			const successor = decideSessionStart(
				liveCtx(),
				`${reason}-session`,
				REPO,
				reason,
			);
			expect(successor.classification).toBe("primary");
			expect(getActiveSessionId()).toBe(`${reason}-session`);
		});
	}

	it("a quit leaves nothing pending: the next startup is primary", () => {
		// #2129 F3 re-arm: without it a later root would decline forever.
		primaryShutsDown("quit");
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("later");
	});

	it("a shutdown with no reason leaves nothing pending", () => {
		primaryShutsDown(undefined);
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
	});

	it("a gap start with no reason fails safe to primary", () => {
		primaryShutsDown("reload");
		const next = decideSessionStart(liveCtx(), "host-session", REPO, undefined);
		expect(next.classification).toBe("primary");
	});

	it("the gap decline records one successor-pending degradation", () => {
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "subagent-1", REPO, "startup");
		decideSessionStart(liveCtx(), "subagent-2", TEMP_ROOT, "startup");
		expect(getSecondarySessionCount()).toBe(2);
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
		]);
	});

	it("a live-sibling decline after the successor registered is not a gap decline", () => {
		// The marker is only read while no primary is registered; a subagent
		// beside the live successor must not be reported as a gap decline.
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "host-session", REPO, "reload");
		const sibling = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
		expect(sibling.classification).toBe("concurrent-secondary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("a marker exactly as old as the bound has expired", () => {
		// Pins the bound's edge: the marker declines strictly inside the
		// window, so an off-by-one `<=` would keep declining at the bound.
		vi.useFakeTimers();
		primaryShutsDown("reload");
		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
		const atBound = decideSessionStart(liveCtx(), "at-bound", REPO, "startup");
		expect(atBound.classification).toBe("primary");
	});

	it("with the guard off a gap startup is primary, as before #3662", () => {
		// I5: PI_LENS_CONCURRENT_SESSION_GUARD=0 restores pre-guard behavior
		// for the whole guard, including the successor-pending decline.
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		try {
			primaryShutsDown("reload");
			const gap = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
			expect(gap.classification).toBe("primary");
			expect(gap.runFullSessionStart).toBe(true);
		} finally {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		}
	});

	it("a marker older than the bound expires: the late startup is primary", () => {
		// A replacement whose successor never starts (pi `reload()` with no
		// bindings, a host without `rebindSession`) must not decline every
		// later start for the process lifetime (catalog shape 17).
		vi.useFakeTimers();
		primaryShutsDown("new");

		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS - 1);
		expect(
			decideSessionStart(liveCtx(), "inside", REPO, "startup").classification,
		).toBe("concurrent-secondary");

		vi.advanceTimersByTime(2);
		const late = decideSessionStart(liveCtx(), "late", REPO, "startup");
		expect(late.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("late");
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
			"expired",
		]);
	});
});
