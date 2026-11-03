// flake-shape: in-process-mock — the cache_usage_summary and baseline rows go through logLatency and test mode skips the file sink, so a passed-through spy is the only reader (same seam as cache-observability.test.ts); the scope store under test is real (#4965)
/**
 * #4965 (shape 72): the cache observability keeps a session's attribution state
 * and `messages[0]` baseline in one cell on the session's scope, found by the
 * session's lookup key. These cases pin who owns that state and when it ends.
 * Replaces #2442's 32-session LRU/FIFO bound, which a scope's lifetime now
 * supplies: no table is left to grow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import * as realObservability from "../../clients/cache-observability.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { retireScope } from "../../clients/session-scope.js";
import { bindSession, retireBoundSessions } from "../support/bound-sessions.js";
import { observeCachePrefix } from "../support/cache-session-scopes.js";

const head = { role: "user", content: "the original first user turn" };
const other = { role: "user", content: "a DIFFERENT first user turn" };

beforeEach(() => {
	latencyEntries.length = 0;
	resetDegradationLedger();
});
afterEach(() => retireBoundSessions());

describe("cache observability state lives on the session's scope (#4965)", () => {
	it("a retired session's baseline ends with its scope, with no clearCachePrefixSession call", () => {
		// RECURRENCE GUARDED: shape 72. The baseline was a process table that only
		// an explicit clear (or an LRU cap) ended, so a session id reused after its
		// scope ended inherited the old baseline and logged a false break.
		const first = bindSession("ending");
		observeCachePrefix([head], 0, "ending");
		retireScope(first, "shutdown");

		// The id is reused by a new session start: its own scope, its own baseline.
		bindSession("ending");
		const verdict = observeCachePrefix([other], 1, "ending");

		expect(verdict).toBe("baseline");
		expect(latencyEntries.map((e) => e.metadata?.baseline)).toEqual([
			true,
			true,
		]);
	});

	it("a secondary's baseline is its own and survives the primary's scope retiring", () => {
		// RECURRENCE GUARDED: shape 72 (#473). A concurrent subagent and its parent
		// stomped one baseline, each logging a false prefix break.
		const primary = bindSession("primary-id", "primary");
		bindSession("secondary-id", "concurrent-secondary");
		observeCachePrefix([head], 0, "primary-id", "primary");
		observeCachePrefix([head], 0, "secondary-id", "concurrent-secondary");

		retireScope(primary, "shutdown");

		latencyEntries.length = 0;
		const verdict = observeCachePrefix(
			[head],
			1,
			"secondary-id",
			"concurrent-secondary",
		);
		expect(verdict).toBe("unchanged");
		expect(latencyEntries).toEqual([]);
	});

	it("a late observation for a retired session records no baseline and is counted once per store", () => {
		// RECURRENCE GUARDED: the resurrection a process table allowed: a late event
		// for a session whose scope retired re-created its state with no owner to
		// end it. Reads the module directly: the test helper would re-bind.
		const scope = bindSession("late");
		retireScope(scope, "shutdown");

		realObservability.observeCachePrefix([head], 0, "late");
		const verdict = realObservability.observeCachePrefix([head], 1, "late");

		expect(verdict).toBe("baseline");
		const missed = getDegradationSummary().filter(
			(group) => group.kind === "session-scope-lookup-missed",
		);
		expect(
			missed.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual(["cache-observability"]);
		expect(missed[0]?.count).toBeGreaterThanOrEqual(2);
	});

	it("a host that gives no session id keeps primary and secondary buckets apart", () => {
		// RECURRENCE GUARDED: with no stable id a secondary overwrote the primary's
		// baseline; the lookup key carries the role (`<role>:<no-session>`).
		bindSession(undefined, "primary");
		bindSession(undefined, "concurrent-secondary");
		observeCachePrefix([head], 0, undefined, "primary");
		const secondary = observeCachePrefix(
			[other],
			0,
			undefined,
			"concurrent-secondary",
		);
		const primary = observeCachePrefix([head], 1, undefined, "primary");

		expect({ secondary, primary }).toEqual({
			secondary: "baseline",
			primary: "unchanged",
		});
	});
});
