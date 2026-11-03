import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	_resetProviderCacheTtlForTests,
	clearCachePrefixSession,
	DEFAULT_PROVIDER_CACHE_TTL_MS,
	emitCacheUsageSummaryAtSessionEnd,
	MAX_ROLLING_DIGEST_CHARS,
	MAX_ROLLING_DIGEST_MESSAGES,
	rollingDigestAt,
	rollingMessageDigests,
} from "../../clients/cache-observability.js";
import {
	logCacheUsage,
	observeCacheContext,
	observeCachePrefix,
	recordToolResultDelivery,
	resetCachePrefixObservation,
} from "../support/cache-session-scopes.js";
import {
	getDegradationSummary,
	renderDegradationLines,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

function assistantMessage(overrides?: Record<string, unknown>) {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-4",
		usage: {
			input: 1200,
			output: 340,
			cacheRead: 8000,
			cacheWrite: 512,
			totalTokens: 9540,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.037,
			},
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

describe("cache-observability — response-side usage (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		// #1071 keeps per-session attribution state in the same module, so a test
		// that logs usage must not leak a gap baseline into the next one.
		resetCachePrefixObservation();
	});

	it("logs one cache_usage record for an assistant message that carries usage", () => {
		logCacheUsage(assistantMessage());

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_usage",
				durationMs: 0,
				metadata: {
					provider: "anthropic",
					model: "claude-opus-4",
					providerIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					modelIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					providerIdentityStatus: "complete",
					modelIdentityStatus: "complete",
					providerIdentityTruncated: false,
					modelIdentityTruncated: false,
					cacheRead: 8000,
					cacheWrite: 512,
					// #4718 review F1: no prior baseline, so this read becomes it.
					cacheBaseline: "advanced",
					input: 1200,
					output: 340,
					cost: 0.037,
					providerUsageMalformedFields: [],
					interTurnGapMs: null,
					gapBasis: "no-prior-turn",
					cacheMissCause: null,
					cacheMissKind: null,
					cacheMissUnknownReason: null,
					modelProviderChanged: false,
					cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
					priorCacheRead: null,
					injectedCharsSinceLastTurn: 0,
					newTranscriptCharsSinceLastTurn: 0,
					attributionCharsCapped: false,
					injectedBytes: {
						sessionGuidance: 0,
						turnFindings: 0,
						testFindings: 0,
						agentNudge: 0,
						turnEndAdvisory: 0,
						other: 0,
					},
					injectedFindingsRepeated: 0,
					toolResultBytes: 0,
					toolResultsTruncated: 0,
				},
			},
		]);
	});

	it("logs nothing for an assistant message with no usage (does not throw)", () => {
		expect(() =>
			logCacheUsage(assistantMessage({ usage: undefined })),
		).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});

	it("logs nothing for a non-assistant (tool_result / user) message", () => {
		logCacheUsage({
			role: "toolResult",
			toolName: "read",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		logCacheUsage({ role: "user", content: "hi" });
		expect(latencyEntries).toHaveLength(0);
	});

	it("never throws on malformed input", () => {
		expect(() => logCacheUsage(undefined)).not.toThrow();
		expect(() => logCacheUsage(null)).not.toThrow();
		expect(() => logCacheUsage("nope")).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — context observations (#1018 follow-up)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("logs a no-injection observation with bounded structural metadata", () => {
		observeCacheContext({
			sessionId: "session-alpha",
			turnIndex: 3,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private prompt" }],
		});

		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0]).toMatchObject({
			phase: "cache_context",
			metadata: {
				version: 1,
				sessionId: "session-alpha",
				turnIndex: 3,
				injectionEnabled: false,
				injectionSources: [],
				injectedMessageCount: 0,
				injectedChars: 0,
				injectedBytes: 0,
				existingMessageCount: 1,
				resultMessageCount: 1,
				placement: "none",
			},
		});
		// #1938: the prefix/first-message pair was removed — it always reported
		// "unknown" past 64 messages. `cache_prefix_break` is the surviving
		// first-message stability signal.
		expect(latencyEntries[0].metadata).not.toHaveProperty("prefixObservation");
		expect(latencyEntries[0].metadata).not.toHaveProperty("firstMessageChange");
		expect(latencyEntries[0].metadata?.observationId).toMatch(/^ctx-/);
	});

	it.each([
		["prepend", [], [{ role: "user", content: "injected" }]],
		[
			"insert-before-final",
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "prompt" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "injected" },
				{ role: "user", content: "prompt" },
			],
		],
		[
			"append",
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
				{ role: "user", content: "injected" },
			],
		],
	] as const)(
		"records %s placement and source",
		(placement, existing, result) => {
			observeCacheContext({
				sessionId: "s",
				turnIndex: 1,
				injectionEnabled: true,
				injectionSlices: [
					{
						source: "session-guidance",
						messages: [{ role: "user", content: "injected" }],
					},
					{ source: "turn-findings", messages: [] },
					{ source: "test-findings", messages: [] },
					{ source: "agent-nudge", messages: [] },
				],
				existingMessages: existing,
				resultMessages: result,
				placement,
			});
			const metadata = latencyEntries[0].metadata;
			expect(metadata?.placement).toBe(placement);
			// Empty slices are not contributors: the derived source list names only
			// what actually produced a message (#1071).
			expect(metadata?.injectionSources).toEqual(["session-guidance"]);
			expect(metadata?.injectedMessageCount).toBe(1);
			expect(metadata?.existingMessageCount).toBe(existing.length);
			expect(metadata?.resultMessageCount).toBe(result.length);
		},
	);

	it("cache_prefix_break still distinguishes a baseline from a later first-message change (#1938: cache_context no longer echoes this)", () => {
		const first = { role: "user", content: "first" };
		const changed = { role: "user", content: "changed" };
		const baseline = observeCachePrefix([first], 0, "s");
		expect(baseline).toBe("baseline");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [first],
		});
		const actualChange = observeCachePrefix([changed], 1, "s");
		expect(actualChange).toBe("changed");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [changed],
		});

		// #1938: cache_context records no longer carry prefixObservation /
		// prefixBaseline — that pair reported "unknown" on 97% of real records.
		const observations = latencyEntries.filter(
			(entry) => entry.phase === "cache_context",
		);
		for (const observation of observations) {
			expect(observation.metadata).not.toHaveProperty("prefixObservation");
			expect(observation.metadata).not.toHaveProperty("prefixBaseline");
		}
		// The surviving signal is the provider-independent local change signal,
		// still emitted directly by observeCachePrefix.
		expect(
			latencyEntries.find(
				(entry) =>
					entry.phase === "cache_prefix_break" &&
					entry.metadata?.baseline === undefined,
			),
		).toBeDefined();
	});

	it("names the request hook and the message the prefix anchors on (#4631)", () => {
		// A pi 0.87+ request: the hook that sees the full transcript reports which
		// one it is, and the prefix hash names the SYSTEM head it anchored on, so a
		// rewritten head is readable instead of a stable-looking conversation.
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "system", content: "BASE" }],
			placement: "append",
			injectionHook: "context_with_system",
		});
		expect(latencyEntries[0].metadata?.injectionHook).toBe(
			"context_with_system",
		);

		// A caller that does not name its hook records `null`, never a guess.
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private" }],
		});
		expect(latencyEntries[1].metadata?.injectionHook).toBeNull();

		observeCachePrefix([{ role: "system", content: "BASE" }], 0, "s");
		observeCachePrefix(
			[{ role: "system", content: "BASE\n\nMERGED SECTION" }],
			1,
			"s",
		);
		const prefixRows = latencyEntries.filter(
			(entry) => entry.phase === "cache_prefix_break",
		);
		expect(prefixRows).toHaveLength(2);
		for (const row of prefixRows) {
			expect(row.metadata?.firstMessageRole).toBe("system");
		}
	});

	it("sees a rebuilt system head whose sections and tool table changed (#4631, F1)", () => {
		// pi 1.3.0's `context_with_system` transcript leads with its SYSTEM head:
		// `content` is empty, the prompt lives in `sections`, and the tool table in
		// `toolsAdded`. Hashed as `{ role, content }` that head is the constant
		// `{"role":"system","content":""}`, so a rebuilt head read as a stable
		// prefix and the miss verdict stayed `unknown` — the #4631 symptom.
		const head = (over: Record<string, unknown> = {}) => ({
			role: "system",
			content: "",
			sections: {
				preamble: "You are an expert coding assistant operating inside pi.",
				rules: "- Use bash for file operations",
				cwd: "<cwd>\n/proj\n</cwd>",
			},
			timestamp: 1792479807686,
			toolsAdded: [{ name: "read" }, { name: "bash" }],
			...over,
		});

		// A SECTION-ONLY rebuild: every other field, `content` included, is
		// untouched. This is the change the old projection could not see.
		expect(observeCachePrefix([head()], 0, "sec")).toBe("baseline");
		expect(
			observeCachePrefix(
				[
					head({
						sections: {
							preamble:
								"You are an expert coding assistant operating inside pi.",
							rules: "- Use rg instead of grep",
							cwd: "<cwd>\n/proj\n</cwd>",
						},
					}),
				],
				1,
				"sec",
			),
		).toBe("changed");

		// A TOOL-TABLE-only rebuild: the prompt is byte-identical, `toolsAdded`
		// grew the way a `pi_lens_activate_tools` delta grows it.
		expect(observeCachePrefix([head()], 0, "tool")).toBe("baseline");
		expect(
			observeCachePrefix(
				[
					head({
						toolsAdded: [
							{ name: "read" },
							{ name: "bash" },
							{ name: "ast_grep_search" },
						],
					}),
				],
				1,
				"tool",
			),
		).toBe("changed");

		// Control both ways: an unchanged head must NOT read as a break, or the
		// signal would trade a permanent "stable" for a permanent "changed".
		expect(observeCachePrefix([head()], 0, "same")).toBe("baseline");
		expect(observeCachePrefix([head()], 1, "same")).toBe("unchanged");

		const breakRows = latencyEntries.filter(
			(entry) =>
				entry.phase === "cache_prefix_break" &&
				entry.metadata?.baseline === undefined,
		);
		expect(breakRows).toHaveLength(2);
		for (const row of breakRows) {
			expect(row.metadata?.firstMessageRole).toBe("system");
			expect(row.metadata?.previousHash).not.toBe(row.metadata?.currentHash);
		}
	});

	it("caps counts and hashes without writing prompt or finding contents", () => {
		const privateText = "DO_NOT_LOG_THIS_PROMPT_".repeat(20_000);
		observeCacheContext({
			sessionId: "s",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: privateText }],
				},
			],
			existingMessages: Array.from({ length: 70 }, (_, i) => ({
				role: "user",
				content: `m${i}`,
			})),
			resultMessages: [{ role: "user", content: privateText }],
			placement: "prepend",
		});

		const entry = latencyEntries[0];
		expect(entry.metadata?.injectedChars).toBe(16_384);
		expect(entry.metadata?.injectedBytes).toBeLessThanOrEqual(65_536);
		expect(entry.metadata?.injectedCountsCapped).toBe(true);
		expect(entry.metadata?.sequenceHashTruncated).toBe(true);
		expect(entry.metadata?.beforeSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.metadata?.afterSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(entry.metadata)).not.toContain(
			"DO_NOT_LOG_THIS_PROMPT",
		);
	});

	it("still reports an honest sequenceHashTruncated flag for an oversized message, without an unknown prefixObservation/firstMessageChange pair (#1938)", () => {
		const existing = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-a`,
		};
		const changedSuffix = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-b`,
		};
		observeCacheContext({
			sessionId: "s",
			turnIndex: 5,
			injectionEnabled: false,
			existingMessages: [existing],
			resultMessages: [changedSuffix],
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sequenceContentHashTruncated: true,
		});
		// The removed pair must not resurface under any name.
		expect(metadata).not.toHaveProperty("firstMessageChanged");
		expect(metadata).not.toHaveProperty("firstMessageChange");
		expect(metadata).not.toHaveProperty("firstMessageHashTruncated");
		expect(metadata).not.toHaveProperty("beforeFirstMessageHash");
		expect(metadata).not.toHaveProperty("afterFirstMessageHash");
		expect(metadata).not.toHaveProperty("prefixHashTruncated");
		expect(metadata).not.toHaveProperty("prefixContentHashTruncated");
		expect(metadata).not.toHaveProperty("prefixMessageCountTruncated");
		expect(metadata).not.toHaveProperty("beforePrefixHash");
		expect(metadata).not.toHaveProperty("afterPrefixHash");
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("prefixObservationUnknown");
		expect(metadata).not.toHaveProperty("prefixBaseline");
	});

	it("does not force prefixObservation/firstMessageChange to unknown on a 200-message transcript (#1938)", () => {
		const existingMessages = Array.from({ length: 200 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `message ${i}`,
		}));
		observeCacheContext({
			sessionId: "s",
			turnIndex: 100,
			injectionEnabled: false,
			existingMessages,
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		// Either the field reports a real value (never "unknown"), or it has been
		// removed from the record entirely — both satisfy the #1938 acceptance
		// criterion. What it must never do is silently report "unknown" just
		// because the transcript is long, which is what pre-fix code does past
		// MAX_HASHED_MESSAGES (64) messages. This repo's chosen fix removes the
		// field outright (see the module doc), so assert that directly too.
		if ("prefixObservation" in metadata) {
			expect(metadata.prefixObservation).not.toBe("unknown");
		}
		if ("firstMessageChange" in metadata) {
			expect(metadata.firstMessageChange).not.toBe("unknown");
		}
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("firstMessageChange");
	});

	it("marks a secondary context observation without a session-local turn", () => {
		observeCacheContext({
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private" }],
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sessionRole: "concurrent-secondary",
			turnScope: "unavailable-concurrent-secondary",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});

	it("adds only session/turn correlation to cache usage when the host has no request id", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "s",
			turnIndex: 4,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "s",
			turnIndex: 4,
			turnScope: "process-global-runtime",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("requestId");
	});

	it("does not present the shared process turn as a secondary session turn", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "secondary",
			turnScope: "unavailable-concurrent-secondary",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});
});

describe("cache-observability — request-side prefix stability (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	const first = { role: "user", content: "the original first user turn" };
	const changed = { role: "user", content: "a DIFFERENT first user turn" };
	const SID = "session-alpha";

	it("logs a baseline on first observation, then a break when messages[0] changes", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "ok" }],
			0,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(1);
		const baseline = latencyEntries[0];
		expect(baseline.phase).toBe("cache_prefix_break");
		expect(baseline.metadata?.baseline).toBe(true);
		expect(baseline.metadata?.previousHash).toBeNull();
		expect(baseline.metadata?.sessionId).toBe(SID);
		expect(baseline.metadata?.sessionRole).toBe("primary");
		const baselineHash = baseline.metadata?.currentHash as string;
		expect(typeof baselineHash).toBe("string");

		// messages[0] changed within the SAME session -> one break record.
		observeCachePrefix(
			[changed, { role: "assistant", content: "ok" }],
			1,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(2);
		const brk = latencyEntries[1];
		expect(brk).toMatchObject({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_prefix_break",
			durationMs: 0,
		});
		expect(brk.metadata?.turnIndex).toBe(1);
		expect(brk.metadata?.previousHash).toBe(baselineHash);
		expect(brk.metadata?.currentHash).not.toBe(baselineHash);
		expect(brk.metadata?.baseline).toBeUndefined();
		expect(brk.metadata?.sessionId).toBe(SID);
	});

	it("logs NOTHING when messages[0] is identical across calls (same session)", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 1" }],
			0,
			SID,
		);
		expect(latencyEntries).toHaveLength(1); // baseline only

		// Same messages[0] content, different later messages / turnIndex — no break.
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 2 differs" }],
			1,
			SID,
		);
		observeCachePrefix(
			[{ role: "user", content: "the original first user turn" }],
			2,
			SID,
		);
		expect(latencyEntries).toHaveLength(1);
	});

	it("does NOT log a break when a DIFFERENT session id first appears (subagent/new)", () => {
		// Parent session establishes its baseline.
		observeCachePrefix([first], 0, "session-parent", "primary");
		expect(latencyEntries).toHaveLength(1);

		// A concurrent subagent (different id) with a DIFFERENT messages[0] must NOT
		// be compared against the parent — it gets its OWN baseline, no break.
		observeCachePrefix(
			[changed],
			0,
			"session-subagent",
			"concurrent-secondary",
		);
		expect(latencyEntries).toHaveLength(2);
		const sub = latencyEntries[1];
		expect(sub.metadata?.baseline).toBe(true);
		expect(sub.metadata?.previousHash).toBeNull();
		expect(sub.metadata?.sessionId).toBe("session-subagent");
		expect(sub.metadata?.sessionRole).toBe("concurrent-secondary");
		expect(latencyEntries.some((e) => e.metadata?.baseline === undefined)).toBe(
			false,
		); // no break record emitted for either session
	});

	it("keeps two concurrent sessions' baselines independent (no cross-contamination)", () => {
		observeCachePrefix([first], 0, "sid-A", "primary");
		observeCachePrefix([changed], 0, "sid-B", "concurrent-secondary");
		latencyEntries.length = 0;

		// Each session re-observing its OWN unchanged messages[0] => no break.
		observeCachePrefix([first], 1, "sid-A", "primary");
		observeCachePrefix([changed], 1, "sid-B", "concurrent-secondary");
		expect(latencyEntries).toHaveLength(0);
	});

	it("resume: same session id across rounds keeps the baseline and catches a real break", () => {
		observeCachePrefix([first], 0, "resumed-session");
		expect(latencyEntries).toHaveLength(1); // baseline

		// Simulate resume: SAME id observes again; unchanged => still no break.
		observeCachePrefix([first], 1, "resumed-session");
		expect(latencyEntries).toHaveLength(1);

		// A genuine post-resume change to messages[0] IS caught.
		observeCachePrefix([changed], 2, "resumed-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("resumed-session");
	});

	it("clearCachePrefixSession drops one session's baseline (re-baselines on next observe)", () => {
		observeCachePrefix([first], 0, "shutdown-session");
		expect(latencyEntries).toHaveLength(1);

		clearCachePrefixSession("shutdown-session");

		// After clearing, the next observation re-logs a baseline (not a break),
		// even with a changed messages[0].
		observeCachePrefix([changed], 1, "shutdown-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBe(true);
		expect(latencyEntries[1].metadata?.previousHash).toBeNull();
	});

	it("falls back to a single bucket when no session id is given", () => {
		observeCachePrefix([first], 0);
		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0].metadata?.sessionId).toBe("<no-session>");

		// Same fallback bucket, changed messages[0] => a break (old single-var semantics).
		observeCachePrefix([changed], 1);
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("<no-session>");
	});

	it("does nothing on an empty transcript and never throws", () => {
		expect(() => observeCachePrefix([], 0, SID)).not.toThrow();
		expect(() => observeCachePrefix(undefined, 0, SID)).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — miss attribution (#1071)", () => {
	const BASE_MS = 1_700_000_000_000;

	function usageMessage(cacheRead: number, input: number) {
		return assistantMessage({
			usage: { input, output: 10, cacheRead, cacheWrite: 0 },
		});
	}

	function logUsage(cacheRead: number, input: number, sessionId = "attr") {
		logCacheUsage(usageMessage(cacheRead, input), undefined, {
			sessionId,
			turnIndex: 0,
		});
	}

	/**
	 * One record that reports the provider's own cache WRITE, which is the
	 * evidence `nextCacheBaseline` reads (#4718 review F1): a rewrite charges the
	 * tokens it built again, a durable shrink charges almost nothing.
	 */
	function logWrite(
		cacheRead: number,
		cacheWrite: number,
		input = 100,
		sessionId = "attr",
	) {
		logCacheUsage(
			assistantMessage({
				usage: { input, output: 10, cacheRead, cacheWrite },
			}),
			undefined,
			{ sessionId, turnIndex: 0 },
		);
	}

	/** One record from a different provider/model, for the switch transitions. */
	function logForeignUsage(cacheRead: number, cacheWrite: number) {
		logCacheUsage(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { input: 9_000, output: 10, cacheRead, cacheWrite },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
	}

	function lastUsageMetadata(): Record<string, unknown> {
		const usageEntries = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		);
		return (usageEntries[usageEntries.length - 1]?.metadata ?? {}) as Record<
			string,
			unknown
		>;
	}

	/**
	 * Fire a bare `context` observation. This is REQUEST time: the moment the
	 * provider looks the prompt cache up, and the endpoint the gap measures to.
	 */
	function observeRequest(sessionId = "attr") {
		observeCacheContext({
			sessionId,
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
	}

	/** Feed one `context` observation so the ledger sees real injected content. */
	function observeInjection(chars: number, sessionId = "attr") {
		observeCacheContext({
			sessionId,
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "x".repeat(chars) }],
				},
			],
			placement: "insert-before-final",
		});
	}

	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
		// #4687: an unknown miss now records a bounded ledger entry (once per
		// session), so the ledger's session boundary is part of this reset.
		resetDegradationLedger();
		_resetProviderCacheTtlForTests();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		vi.useFakeTimers();
		vi.setSystemTime(BASE_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		_resetProviderCacheTtlForTests();
	});

	it("returns no verdict for the first record in a session", () => {
		logUsage(0, 5_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			cacheMissKind: null,
			cacheMissUnknownReason: "no-prior-sample",
			priorCacheRead: null,
		});
	});

	it("measures the gap to request time, not to the message_end that follows", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 4_000);
		observeRequest();
		// 5s of generation follows the request. It is not idle time.
		vi.setSystemTime(BASE_MS + 9_000);
		logUsage(8_100, 100);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 4_000,
			gapBasis: "request-time",
			priorCacheRead: 8_000,
			cacheMissCause: null,
		});
	});

	it("does not read a short idle plus a long generation as ttl-expired", () => {
		// The reviewer's probe: 10s idle, then 70s of generation. The message-end
		// basis would measure 80s and fire ttl-expired; the request-time basis
		// measures the 10s that actually elapsed before the cache lookup.
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 10_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 80_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 10_000,
			gapBasis: "request-time",
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "no-local-explanation",
		});
	});

	it("reports missing request correlation instead of inferring ttl from message-end time", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 70_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 70_000,
			gapBasis: "message-end-fallback",
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "request-correlation-unavailable",
		});
	});

	it("clears the request stamp at each turn boundary", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 1_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 2_000);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({ gapBasis: "request-time" });
		// No context call this turn: the previous turn's stamp must not be reused.
		vi.setSystemTime(BASE_MS + 3_000);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			gapBasis: "message-end-fallback",
			interTurnGapMs: 1_000,
		});
	});

	it("attributes a zero read after a long idle gap to ttl-expired", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 166_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 170_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheMissKind: "zero-read",
			interTurnGapMs: 166_000,
			gapBasis: "request-time",
			cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});
	});

	it("treats a request-time gap exactly at the threshold as expired and one below it as not", () => {
		logUsage(8_000, 100, "boundary-at");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest("boundary-at");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS + 3_000);
		logUsage(0, 9_000, "boundary-at");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			gapBasis: "request-time",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});

		vi.setSystemTime(BASE_MS);
		logUsage(8_000, 100, "boundary-below");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS - 1);
		observeRequest("boundary-below");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS + 3_000);
		// The same 9,000-token prompt as above: a 100-token prompt would be a
		// shrink by its own numbers (#4718 verify F11), not a timing question.
		logUsage(0, 9_000, "boundary-below");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			gapBasis: "request-time",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS - 1,
		});
	});

	it("honors the configured threshold instead of the default", () => {
		process.env.PI_LENS_PROVIDER_CACHE_TTL_MS = "1000";
		_resetProviderCacheTtlForTests();
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 2_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 2_500);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheTtlThresholdMs: 1_000,
		});
	});

	it("attributes a miss after a first-message change to prefix-broke", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 5_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissKind: "zero-read",
		});
	});

	it("attributes a shortfall across a provider or model switch", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionId: "attr",
			turnIndex: 1,
		});
		// Change the identity on the next request; the preceding zero remains a
		// normal same-provider observation and establishes the comparison point.
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 2 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "model-provider-changed",
			cacheMissKind: "zero-read",
			modelProviderChanged: true,
		});
	});

	it("keeps a directly observed model switch above truncated request evidence", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logCacheUsage(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "model-provider-changed",
			cacheMissUnknownReason: null,
		});
	});

	it("fails closed when provider/model evidence is unavailable", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("does not infer ttl when provider/model identity is unavailable", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("does not infer partial eviction when provider/model identity is unavailable", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: {
					input: 20_000,
					output: 10,
					cacheRead: 3_000,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("prefers the observed prefix break over the idle-gap heuristic", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
	});

	it("keeps a direct prefix break above missing identity and truncated request evidence", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissUnknownReason: null,
		});
	});

	it("re-arms the prefix-break flag after each usage record", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({ cacheMissCause: "unknown" });
	});

	it("measures a second consecutive rewrite against the last healthy read (#4687 item 3)", () => {
		// The measured sequence: a healthy 8,000, a head rewrite that reads 257,
		// then the same 257 again. Comparing against the previous read made the
		// second turn a cache HIT, so the session's second rewrite was invisible.
		// This is the shape of a provider that reports its writes (Anthropic,
		// Bedrock): the rebuilt 9,732 tokens are `cacheWrite`, `input` is the tail.
		// The prompt is still the size of the old prefix, so it is not a shrink;
		// the zero-write shape is the F8 rows below.
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 1_000);
		logWrite(257, 9_732);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			cacheBaseline: "held",
		});

		// No request observation between the two usage records: the prefix is not
		// re-declared stable, and the SECOND rewrite is still a miss against the
		// last healthy read, not a hit against the first miss's remainder.
		vi.setSystemTime(BASE_MS + 2_000);
		logWrite(257, 9_732);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			cacheBaseline: "held",
		});
	});

	// #4718 review F1: the baseline transitions, one row each. `held` keeps the
	// last healthy read, `shrunk` replaces it, `advanced` is a healthy read.
	it("moves the baseline to a larger read (grow)", () => {
		logUsage(8_000, 100);
		logUsage(9_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: null,
			cacheBaseline: "advanced",
		});
		logUsage(9_000, 100);
		expect(lastUsageMetadata()).toMatchObject({ priorCacheRead: 9_000 });
	});

	it("keeps the baseline across an unchanged read", () => {
		logUsage(8_000, 100);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: null,
			cacheBaseline: "advanced",
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: null,
		});
	});

	it("re-baselines a durable prefix shrink (compaction)", () => {
		// A compacted session reads a 2,000-token prefix where 8,000 used to be.
		// The provider wrote nothing back: the smaller prefix was already cached,
		// so the dropped tokens were never in this request.
		logUsage(8_000, 100);
		logUsage(2_000, 100);
		const transition = lastUsageMetadata();
		expect(transition).toMatchObject({
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
		});
		// The NEXT turn is measured against the smaller prefix, so it is not a
		// second false miss against a prefix that no longer exists.
		logUsage(2_100, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 2_000,
			cacheMissKind: null,
			cacheMissCause: null,
		});
		expect(transition.cacheBaseline).toBe("shrunk");
	});

	it("re-baselines a shrink and then tracks the regrowth", () => {
		logUsage(8_000, 100);
		logUsage(2_000, 100);
		const shrunk = lastUsageMetadata();
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 2_000,
			cacheMissCause: null,
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: null,
		});
		expect(shrunk.cacheBaseline).toBe("shrunk");
	});

	it("clears the baseline across a model/provider switch", () => {
		// The old provider's read says nothing about the new provider's prefix, so
		// the switch clears the baseline instead of measuring the new provider
		// against it for the rest of the session.
		logUsage(8_000, 100);
		logForeignUsage(3_000, 0);
		const switched = lastUsageMetadata();
		expect(switched).toMatchObject({
			cacheMissCause: "model-provider-changed",
			priorCacheRead: 8_000,
		});
		logForeignUsage(3_000, 0);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: null,
			cacheMissCause: null,
		});
		logForeignUsage(3_100, 0);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 3_000,
			cacheMissCause: null,
		});
		expect(switched.cacheBaseline).toBe("switched");
	});

	// #4718 review F8 (Greptile thread 13): Gemini, Vertex, Mistral and OpenAI
	// report `cacheWrite: 0` on every record, so a rebuilt prefix comes back as
	// fresh `input`, not as a write. Reading a zero write as "the prompt got
	// smaller" made the first rewrite a shrink and the second one a hit.
	describe("a provider that never reports cache writes (#4718 review F8)", () => {
		function logGemini(cacheRead: number, input: number) {
			logCacheUsage(
				assistantMessage({
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-2.5-pro",
					usage: { input, output: 10, cacheRead, cacheWrite: 0 },
				}),
				undefined,
				{ sessionId: "attr", turnIndex: 0 },
			);
		}

		it("keeps a second zero-write rewrite a miss against the last healthy read", () => {
			logGemini(8_000, 100);
			logGemini(257, 9_742);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissKind: "low-read",
				priorCacheRead: 8_000,
				cacheBaseline: "held",
			});
			logGemini(257, 9_742);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissKind: "low-read",
				priorCacheRead: 8_000,
				cacheBaseline: "held",
			});
		});

		it("re-baselines a compaction from the prompt size, not from a write", () => {
			logGemini(8_000, 100);
			logGemini(2_000, 310);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissKind: "low-read",
				cacheMissCause: "prefix-shrunk",
				cacheBaseline: "shrunk",
			});
			logGemini(2_100, 100);
			expect(lastUsageMetadata()).toMatchObject({
				priorCacheRead: 2_000,
				cacheMissCause: null,
			});
		});

		it("holds a real miss that follows a shrink", () => {
			logGemini(8_000, 100);
			logGemini(2_000, 310);
			logGemini(200, 1_810);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissKind: "low-read",
				priorCacheRead: 2_000,
				cacheBaseline: "held",
			});
			logGemini(200, 1_810);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissKind: "low-read",
				priorCacheRead: 2_000,
				cacheBaseline: "held",
			});
		});
	});

	// The state table's row the round-2 rule missed on every provider: a
	// non-append write that also shortens the prompt (a smaller rebuilt head)
	// re-writes almost everything, yet the write stays below the shortfall.
	it("keeps a rewrite that also shortens the prompt a miss", () => {
		logUsage(8_000, 100);
		logWrite(257, 7_143);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			cacheBaseline: "held",
		});
		logWrite(257, 7_143);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			cacheBaseline: "held",
		});
	});

	// #4718 review F9: the boundary of the shrink rule. A shrink is a prompt
	// below half the baseline (the ratio that makes a read low) that still read
	// something from cache.
	it("keeps a compaction that writes its summary a shrink", () => {
		logUsage(8_000, 100);
		logWrite(2_000, 300, 0);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "shrunk",
		});
	});

	it("holds a prompt exactly at half the baseline", () => {
		logUsage(8_000, 100);
		logWrite(2_000, 2_000, 0);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			cacheBaseline: "held",
		});
	});

	it("holds a zero read even when the prompt shrank", () => {
		logUsage(8_000, 100);
		logWrite(0, 2_000, 0);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissKind: "zero-read",
			cacheBaseline: "held",
		});
		logWrite(2_000, 0, 100);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "shrunk",
		});
	});

	// #4718 verify F11: a compaction changes the prefix, so the provider usually
	// serves NOTHING on the compacted turn (13 of 13 real compactions in the
	// maintainer's log). Requiring a non-zero read left every one of them an
	// unexplained miss, and two compactions wrote the row. The real `01a14e00`
	// sequence, with request-time evidence.
	it("names a zero-read compaction and keeps it out of the unexplained count", () => {
		logUsage(245_272, 100);
		observeRequest();
		logUsage(0, 67_400);
		const first = lastUsageMetadata();
		observeRequest();
		logUsage(67_716, 293);
		const after = lastUsageMetadata();
		observeRequest();
		logUsage(244_169, 100);
		observeRequest();
		logUsage(0, 61_733);
		const second = lastUsageMetadata();
		expect(
			renderDegradationLines().filter((line) =>
				line.includes("prompt-cache-miss-unexplained"),
			),
		).toEqual([]);
		expect(
			getDegradationSummary().some(
				(entry) => entry.kind === "prompt-cache-miss-unexplained",
			),
		).toBe(false);
		expect(first).toMatchObject({
			gapBasis: "request-time",
			cacheMissKind: "zero-read",
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "held",
		});
		// The next turn reads the compacted prefix and moves the baseline to it.
		expect(after).toMatchObject({
			priorCacheRead: 245_272,
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "shrunk",
		});
		expect(second).toMatchObject({
			cacheMissKind: "zero-read",
			cacheMissCause: "prefix-shrunk",
		});
	});

	// An aborted or errored request carries pi-ai's empty usage (every count 0).
	// A zero prompt is no evidence of a smaller prompt, so it stays a miss.
	it("keeps an empty usage record a counted miss", () => {
		logUsage(8_000, 100);
		logWrite(0, 0, 0);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissKind: "zero-read",
			cacheMissCause: "unknown",
			cacheBaseline: "held",
		});
	});

	// #4718 review F7: the shrink turn used to classify as `unknown`, so two
	// compactions in one session wrote `prompt-cache-miss-unexplained` ("no
	// local cause") for a prefix the provider served exactly as asked.
	it("names a durable shrink and keeps it out of the unexplained count", () => {
		logUsage(8_000, 100);
		observeRequest();
		logUsage(3_000, 100);
		const first = lastUsageMetadata();
		observeRequest();
		logUsage(1_000, 100);
		const second = lastUsageMetadata();
		// The symptom first: two shrinks must not render the "no local cause" row.
		expect(
			renderDegradationLines().filter((line) =>
				line.includes("prompt-cache-miss-unexplained"),
			),
		).toEqual([]);
		expect(
			getDegradationSummary().some(
				(entry) => entry.kind === "prompt-cache-miss-unexplained",
			),
		).toBe(false);
		expect(first).toMatchObject({
			gapBasis: "request-time",
			cacheMissKind: "low-read",
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "shrunk",
		});
		expect(second).toMatchObject({
			priorCacheRead: 3_000,
			cacheMissCause: "prefix-shrunk",
			cacheBaseline: "shrunk",
		});
	});

	it("reads a head whose keys moved as an unchanged prefix (#4687 item 6)", () => {
		const head = {
			role: "system",
			content: "",
			sections: { preamble: "prompt", rules: ["a", "b"] },
			toolsAdded: [{ name: "read" }],
		};
		const reordered = {
			toolsAdded: [{ name: "read" }],
			sections: { rules: ["a", "b"], preamble: "prompt" },
			content: "",
			role: "system",
		};
		expect(observeCachePrefix([head], 0, "attr")).toBe("baseline");
		expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(head));
		expect(observeCachePrefix([reordered], 1, "attr")).toBe("unchanged");
		// Only the baseline row: an equal head is not a prefix break.
		expect(
			latencyEntries.filter((e) => e.phase === "cache_prefix_break"),
		).toHaveLength(1);
	});

	it("attributes a mid-list tool delta to tool-set-changed (#4687 item 2)", () => {
		// Typed wide on purpose: the runtime object is the host's whole message,
		// and the delta fields are exactly what the observer must read.
		const head: Record<string, unknown> = {
			role: "system",
			content: "",
			sections: { preamble: "prompt" },
			toolsAdded: [{ name: "read" }],
		};
		const delta: Record<string, unknown> = {
			role: "system",
			content: "",
			toolsAdded: [{ name: "ast_grep_search" }],
		};
		logUsage(8_000, 100);
		observeCachePrefix([head, { role: "user", content: "prompt" }], 0, "attr");
		logUsage(8_000, 100);
		// pi appends the activation's tool delta as a NEW system message; the head
		// (messages[0]) never moves, which is why the first-message hash missed it.
		observeCachePrefix(
			[head, { role: "user", content: "prompt" }, delta],
			1,
			"attr",
		);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(257, 9_732);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "tool-set-changed",
			cacheMissKind: "low-read",
		});
	});

	it("attributes a mid-list prompt delta to system-prompt-changed (#4687 item 2)", () => {
		const head: Record<string, unknown> = {
			role: "system",
			content: "",
			sections: { preamble: "prompt" },
			toolsAdded: [{ name: "read" }],
		};
		logUsage(8_000, 100);
		observeCachePrefix([head, { role: "user", content: "prompt" }], 0, "attr");
		logUsage(8_000, 100);
		// A reload after AGENTS.md changed appends a system message carrying the
		// rebuilt prompt. No tool table moved, so the cause is the prompt itself.
		observeCachePrefix(
			[
				head,
				{ role: "user", content: "prompt" },
				{ role: "system", content: "NEW PROJECT RULES" },
			],
			1,
			"attr",
		);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(257, 9_732);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "system-prompt-changed",
			cacheMissKind: "low-read",
		});
	});

	it("attributes a low read with fresh input far above new content to partial-eviction", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 20_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			injectedCharsSinceLastTurn: 200,
			attributionCharsCapped: false,
		});
	});

	// #4718 round 3 class sweep (the F8 shape): Anthropic and Bedrock carry the
	// re-sent tokens in `cacheWrite`, not in `input`, so reading `input` alone
	// made eviction unreachable there and the miss fell through to `unknown`.
	it("attributes an eviction the provider re-wrote to partial-eviction", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		vi.setSystemTime(BASE_MS + 1_000);
		logWrite(3_000, 20_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
		});
	});

	it("does not call it eviction when fresh input matches the new content", () => {
		logUsage(8_000, 100);
		observeInjection(8_000);
		vi.setSystemTime(BASE_MS + 1_000);
		// The 4,100 written tokens keep the prompt at the old prefix's size, so
		// this is a miss and not a shrink (#4718 review F8).
		logWrite(3_000, 4_100, 900);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "no-local-explanation",
		});
	});

	it("does not manufacture partial eviction from non-finite provider input", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				usage: {
					input: Number.POSITIVE_INFINITY,
					output: 10,
					cacheRead: 3_000,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "malformed-provider-usage",
			input: null,
			providerUsageMalformedFields: ["input"],
		});
	});

	it("distinguishes malformed cacheRead from an absent provider field", () => {
		logCacheUsage(
			assistantMessage({
				usage: {
					input: 100,
					output: 10,
					cacheRead: Number.NaN,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheRead: null,
			cacheMissCause: null,
			cacheMissUnknownReason: "malformed-provider-usage",
			providerUsageMalformedFields: ["cacheRead"],
		});
		emitCacheUsageSummaryAtSessionEnd("attr", "primary");
		const summary = latencyEntries.find(
			(entry) => entry.phase === "cache_usage_summary",
		)?.metadata as Record<string, unknown>;
		expect(summary.unknownEvidenceReasons).toMatchObject({
			"malformed-provider-usage": 1,
		});
	});

	it("sanitizes every logged malformed numeric field with a fixed bounded field list", () => {
		logCacheUsage(
			assistantMessage({
				usage: {
					input: Number.POSITIVE_INFINITY,
					output: Number.NaN,
					cacheRead: -1,
					cacheWrite: Number.NEGATIVE_INFINITY,
					cost: { total: Number.NaN },
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		const metadata = lastUsageMetadata();
		expect(metadata).toMatchObject({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			cost: null,
			cacheMissUnknownReason: "malformed-provider-usage",
			providerUsageMalformedFields: [
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"cost.total",
			],
		});
		expect(JSON.stringify(metadata)).not.toMatch(/Infinity|NaN/);
	});

	it("distinguishes a provider-reported miss despite a stable local prefix", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeRequest();
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "zero-read",
			cacheMissUnknownReason: "provider-reported-zero-stable-prefix",
		});
	});

	it("distinguishes a provider-reported low read despite a stable local prefix", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeRequest();
		// A low read (3,900 of 8,000) whose prompt is not a shrink (4,400 is above
		// half the baseline, #4718 review F8) and whose 500 uncached tokens stay
		// under the eviction floor, so only the stable-prefix branch explains it.
		logWrite(3_900, 400);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "provider-reported-low-read-stable-prefix",
		});
	});

	it("does not claim stable-prefix evidence when the bounded sequence hash truncated", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "sequence-hash-truncated",
		});
	});

	it("reads ttl-expired across an ordinary long tool result (#4687 item 4)", () => {
		// Before #4687 a 20,000-character message made the BOUNDED sequence hash
		// truncate, and the truncation gate ran before the TTL rule, so a genuine
		// request-time expiry read `unknown / sequence-hash-truncated`. The gap is
		// measured from the request clock, so content truncation cannot refute it.
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [
				{ role: "user", content: "prompt" },
				{ role: "toolResult", content: "t".repeat(20_000) },
			],
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			gapBasis: "request-time",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});
	});

	it("does not infer partial eviction when request sequence evidence truncated", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logUsage(3_000, 20_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "sequence-hash-truncated",
		});
	});

	const incompleteContextCases = [
		[
			"cyclic content",
			() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value;
			},
		],
		[
			"a throwing enumerable getter",
			() => {
				const value: Record<string, unknown> = {};
				Object.defineProperty(value, "secret", {
					enumerable: true,
					get: () => {
						throw new Error("unreadable");
					},
				});
				return value;
			},
		],
		[
			"an unreadable proxy",
			() =>
				new Proxy(
					{},
					{
						ownKeys: () => {
							throw new Error("unreadable");
						},
					},
				),
		],
	] as const;

	it.each(incompleteContextCases)(
		"fails ttl closed when context hashing sees %s",
		(_label, make) => {
			logUsage(8_000, 100);
			vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
			observeCacheContext({
				sessionId: "attr",
				turnIndex: 1,
				injectionEnabled: false,
				existingMessages: [{ role: "user", content: make() }],
			});
			const contextMetadata = [...latencyEntries]
				.reverse()
				.find((entry) => entry.phase === "cache_context")?.metadata;
			expect(contextMetadata?.sequenceHashIncomplete).toBe(true);
			logUsage(0, 9_000);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissCause: "unknown",
				cacheMissUnknownReason: "request-evidence-incomplete",
			});
		},
	);

	it.each(incompleteContextCases)(
		"fails partial eviction closed when context hashing sees %s",
		(_label, make) => {
			logUsage(8_000, 100);
			observeCacheContext({
				sessionId: "attr",
				turnIndex: 1,
				injectionEnabled: false,
				existingMessages: [{ role: "user", content: make() }],
			});
			const contextMetadata = [...latencyEntries]
				.reverse()
				.find((entry) => entry.phase === "cache_context")?.metadata;
			expect(contextMetadata?.sequenceHashIncomplete).toBe(true);
			logUsage(3_000, 20_000);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissCause: "unknown",
				cacheMissUnknownReason: "request-evidence-incomplete",
			});
		},
	);

	it.each(["provider", "model"] as const)(
		"compares the full %s identity when values differ only after the log cap",
		(field) => {
			const shared = "x".repeat(200);
			const firstIdentity = `${shared}PRIVATE_SUFFIX_A`;
			const secondIdentity = `${shared}PRIVATE_SUFFIX_B`;
			logCacheUsage(
				assistantMessage({
					[field]: firstIdentity,
					usage: { input: 100, output: 10, cacheRead: 8_000, cacheWrite: 0 },
				}),
				undefined,
				{ sessionId: "attr", turnIndex: 0 },
			);
			const first = lastUsageMetadata();
			observeRequest();
			logCacheUsage(
				assistantMessage({
					[field]: secondIdentity,
					usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
				}),
				undefined,
				{ sessionId: "attr", turnIndex: 1 },
			);
			const second = lastUsageMetadata();
			expect(second).toMatchObject({
				cacheMissCause: "model-provider-changed",
				[`${field}IdentityTruncated`]: true,
			});
			expect(second[field]).toBe(shared);
			expect(second[`${field}IdentityHash`]).toMatch(/^[a-f0-9]{64}$/);
			expect(second[`${field}IdentityHash`]).not.toBe(
				first[`${field}IdentityHash`],
			);
			expect(JSON.stringify(second)).not.toContain("PRIVATE_SUFFIX_B");
		},
	);

	it("separates missing-id primary and secondary buckets and fails correlation closed", () => {
		logCacheUsage(usageMessage(8_000, 100), undefined, {
			sessionRole: "primary",
			turnIndex: 0,
		});
		observeCacheContext({
			sessionRole: "primary",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionRole: "primary",
			turnIndex: 1,
		});
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "request-correlation-unavailable",
		});

		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionRole: "concurrent-secondary",
		});
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: null,
			cacheMissCause: null,
			cacheMissUnknownReason: "no-prior-sample",
			turnScope: "unavailable-concurrent-secondary",
		});

		emitCacheUsageSummaryAtSessionEnd(undefined, "primary");
		emitCacheUsageSummaryAtSessionEnd(undefined, "concurrent-secondary");
		const summaries = latencyEntries
			.filter((entry) => entry.phase === "cache_usage_summary")
			.map((entry) => entry.metadata);
		expect(summaries).toEqual([
			expect.objectContaining({ sessionRole: "primary", usageRecords: 2 }),
			expect.objectContaining({
				sessionRole: "concurrent-secondary",
				usageRecords: 1,
			}),
		]);
	});

	// #4718 review F2: the doc says the first unexplained miss counts silently.
	// It did not: `recordDegradation` added the group entry on the first miss, so
	// `/lens-perf` and `pilens_health` rendered "⚠ prompt-cache-miss-unexplained:
	// 1" before the second-miss threshold the record exists for.
	it("keeps the first unexplained miss out of the ledger", () => {
		const missLines = () =>
			renderDegradationLines().filter((line) =>
				line.includes("prompt-cache-miss-unexplained"),
			);
		logUsage(8_000, 100);
		logUsage(0, 9_000);
		expect(missLines()).toEqual([]);
		logUsage(0, 9_000);
		expect(missLines()).toEqual([
			expect.stringContaining("prompt-cache-miss-unexplained: 1"),
		]);
		// Later misses only raise the count the reader sees.
		logUsage(0, 9_000);
		expect(missLines()).toEqual([
			expect.stringContaining("prompt-cache-miss-unexplained: 2"),
		]);
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "prompt-cache-miss-unexplained",
		);
		expect(group?.latestReasons.at(-1)?.subject).toBe("attr");
		// #4718 review F10: the ledger count is ADMITTED misses (the total less
		// the silent first); the session's exact total is the summary's
		// `unknown` counter.
		expect(group?.count).toBe(2);
		emitCacheUsageSummaryAtSessionEnd("attr", "primary");
		const summary = latencyEntries.find(
			(entry) => entry.phase === "cache_usage_summary",
		);
		expect(summary?.metadata).toMatchObject({
			cacheMissCauses: { unknown: 3 },
		});
	});

	// #4718 review F5: without a stable session id every miss shares one
	// `<no-session>` bucket, so two unrelated sessions would combine toward the
	// second-miss row and the row would blame the provider for a telemetry gap.
	it("does not count unexplained misses that share the no-session bucket", () => {
		const logAnonymous = (cacheRead: number) =>
			logCacheUsage(usageMessage(cacheRead, 100), undefined, {
				sessionRole: "primary",
				turnIndex: 0,
			});
		logAnonymous(8_000);
		logAnonymous(0);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "request-correlation-unavailable",
		});
		logAnonymous(0);
		logAnonymous(0);
		expect(
			getDegradationSummary().some(
				(entry) => entry.kind === "prompt-cache-miss-unexplained",
			),
		).toBe(false);
		expect(
			renderDegradationLines().filter((line) =>
				line.includes("prompt-cache-miss-unexplained"),
			),
		).toEqual([]);
	});

	it("suppresses the eviction verdict when the char accumulators were capped", () => {
		logUsage(8_000, 100);
		observeInjection(40_000);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 900_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			attributionCharsCapped: true,
		});
	});

	it("keeps partial-eviction reachable when a large complete tool-result batch lands", () => {
		// #1071 review round 1, F2: transcript growth used to run through the
		// 16 KiB injection cap, so a routine 20,000-char tool-result batch latched
		// attributionCharsCapped and suppressed the verdict. Split it into bounded
		// messages here so #1996's independent sequence-completeness gate is open.
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: true,
			existingMessages: [
				{ role: "user", content: "prompt" },
				...Array.from({ length: 10 }, () => ({
					role: "toolResult",
					content: "t".repeat(2_000),
				})),
			],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "f".repeat(200) }],
				},
			],
			placement: "insert-before-final",
		});
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 30_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			newTranscriptCharsSinceLastTurn: 20_000,
			injectedCharsSinceLastTurn: 200,
			attributionCharsCapped: false,
		});
	});

	it("drops the baseline when a usage record carries no readable cacheRead", () => {
		// The gap would be one turn long while the baseline was two turns old, so
		// the stored baseline is cleared rather than carried (#1071 review, F4).
		logUsage(8_000, 100);
		logCacheUsage(
			assistantMessage({ usage: { input: 100, output: 10, cacheWrite: 0 } }),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissUnknownReason: "cache-read-unavailable",
		});
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: null,
			cacheMissCause: null,
			cacheMissKind: null,
			cacheMissUnknownReason: "no-prior-sample",
		});
	});

	it("reports no verdict for a healthy read", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(7_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: null,
			cacheMissKind: null,
		});
	});

	it("resets the per-turn char accumulators at each usage record", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 200,
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 0,
			newTranscriptCharsSinceLastTurn: 0,
		});
	});

	it("counts transcript growth between context observations", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "1234" }],
		});
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [
				{ role: "user", content: "1234" },
				{ role: "user", content: "567890" },
			],
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			newTranscriptCharsSinceLastTurn: 6,
		});
	});

	it("keeps attribution state per session", () => {
		logUsage(8_000, 100, "session-a");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000, "session-b");
		expect(lastUsageMetadata()).toMatchObject({
			sessionId: "session-b",
			interTurnGapMs: null,
			cacheMissCause: null,
		});
	});

	it("drops attribution state when a session shuts down", () => {
		logUsage(8_000, 100);
		clearCachePrefixSession("attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			priorCacheRead: null,
		});
	});

	it("emits one bounded fixed-key summary and retires the session state", () => {
		logUsage(8_000, 100, "summary");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest("summary");
		logUsage(0, 9_000, "summary");
		observeCachePrefix([{ role: "user", content: "first" }], 2, "summary");
		observeRequest("summary");
		logUsage(0, 9_000, "summary");

		emitCacheUsageSummaryAtSessionEnd("summary", "primary");
		const summaryEntries = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage_summary",
		);
		expect(summaryEntries).toHaveLength(1);
		expect(summaryEntries[0]?.metadata).toEqual({
			version: 1,
			sessionId: "summary",
			sessionRole: "primary",
			usageRecords: 3,
			cacheHits: 1,
			missObservations: 2,
			cacheMissCauses: {
				"ttl-expired": 1,
				"prefix-broke": 0,
				"tool-set-changed": 0,
				"system-prompt-changed": 0,
				"partial-eviction": 0,
				"model-provider-changed": 0,
				"injection-dropped": 0,
				"prefix-shrunk": 0,
				unknown: 1,
			},
			unknownEvidenceReasons: {
				"no-prior-sample": 0,
				"cache-read-unavailable": 0,
				"malformed-provider-usage": 0,
				"request-correlation-unavailable": 0,
				"request-evidence-incomplete": 0,
				"sequence-hash-truncated": 0,
				"model-provider-unavailable": 0,
				"provider-reported-zero-stable-prefix": 1,
				"provider-reported-low-read-stable-prefix": 0,
				"no-local-explanation": 0,
			},
		});
		expect(JSON.stringify(summaryEntries[0]?.metadata)).not.toContain("first");

		emitCacheUsageSummaryAtSessionEnd("summary", "primary");
		expect(
			latencyEntries.filter((entry) => entry.phase === "cache_usage_summary"),
		).toHaveLength(1);
	});
});

describe("cache-observability — per-source injection attribution (#1071)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("splits a mixed payload by contributing source", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "12345678" }],
				},
				{
					source: "agent-nudge",
					messages: [
						{ role: "user", content: "abc" },
						{ role: "user", content: "de" },
					],
				},
			],
			placement: "insert-before-final",
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionSourceBreakdown).toEqual([
			{
				source: "turn-findings",
				messageCount: 1,
				chars: 8,
				bytes: 8,
				estimatedTokens: 2,
				countsCapped: false,
			},
			{
				source: "agent-nudge",
				messageCount: 2,
				chars: 5,
				bytes: 5,
				estimatedTokens: 2,
				countsCapped: false,
			},
		]);
		expect(metadata.injectionSources).toEqual(["turn-findings", "agent-nudge"]);
		expect(metadata.injectedChars).toBe(13);
		expect(metadata.injectedEstimatedTokens).toBe(4);
		expect(metadata.injectionOccurred).toBe(true);
	});

	it("labels the token figure as an estimate, never as provider usage", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "test-findings",
					messages: [{ role: "user", content: "ab" }],
				},
			],
		});
		expect(latencyEntries[0].metadata?.injectedTokenBasis).toBe(
			"chars-per-token-4-estimate-not-provider-measured",
		);
	});

	it("reports no injection and no sources for an empty payload", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [{ source: "turn-findings", messages: [] }],
		});
		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionOccurred).toBe(false);
		expect(metadata.injectionSources).toEqual([]);
		expect(metadata.injectionSourceBreakdown).toEqual([]);
	});

	it("keeps the per-source split free of injected content", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 3,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "SECRET_FINDING_TEXT" }],
				},
			],
		});
		expect(JSON.stringify(latencyEntries[0].metadata)).not.toContain(
			"SECRET_FINDING_TEXT",
		);
	});

	it("carries UTF-8 bytes and repeated findings onto the existing turn row", () => {
		const finding = "src/例.ts:7 no-unused-vars";
		const sources = [
			["session-guidance", "src/guidance.ts:1 guidance-rule"],
			["turn-findings", finding],
			["test-findings", "tests/a.py:2 rule=E501"],
			["agent-nudge", "src/nudge.go:3 nudge-rule"],
		] as const;
		for (const [source, content] of sources) {
			observeCacheContext({
				sessionId: "bytes",
				turnIndex: 1,
				injectionEnabled: true,
				injectionSlices: [{ source, messages: [{ role: "user", content }] }],
			});
		}
		logCacheUsage(assistantMessage(), undefined, { sessionId: "bytes" });
		const first = latencyEntries.find((entry) => entry.phase === "cache_usage");
		expect(first?.metadata?.injectedBytes).toEqual({
			sessionGuidance: Buffer.byteLength("src/guidance.ts:1 guidance-rule"),
			turnFindings: Buffer.byteLength(finding),
			testFindings: Buffer.byteLength("tests/a.py:2 rule=E501"),
			agentNudge: Buffer.byteLength("src/nudge.go:3 nudge-rule"),
			turnEndAdvisory: 0,
			other: 0,
		});
		expect(first?.metadata?.injectedFindingsRepeated).toBe(0);

		observeCacheContext({
			sessionId: "bytes",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: finding }],
				},
			],
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "bytes" });
		const second = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		)[1];
		expect(second?.metadata?.injectedFindingsRepeated).toBe(1);
	});

	it("writes zero source bytes when context injection is disabled", () => {
		observeCacheContext({
			sessionId: "disabled",
			turnIndex: 1,
			injectionEnabled: false,
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "disabled" });
		expect(
			latencyEntries.find((entry) => entry.phase === "cache_usage")?.metadata,
		).toMatchObject({
			injectedBytes: {
				sessionGuidance: 0,
				turnFindings: 0,
				testFindings: 0,
				agentNudge: 0,
				turnEndAdvisory: 0,
				other: 0,
			},
			injectedFindingsRepeated: 0,
		});
	});

	// #2841 via #4965: the identities live on the session's scope, so the
	// session's end (its scope retires) is the reset; a same-id restart binds a
	// new scope and counts nothing it saw before as repeated.
	it("resets repeated-finding identities at a session_start boundary", () => {
		const finding = "src/reset.ts:7 rule=E1";
		const observe = (turnIndex: number) =>
			observeCacheContext({
				sessionId: "reset",
				turnIndex,
				injectionEnabled: true,
				injectionSlices: [
					{
						source: "turn-findings",
						messages: [{ role: "user", content: finding }],
					},
				],
			});

		observe(1);
		logCacheUsage(assistantMessage(), undefined, { sessionId: "reset" });
		resetCachePrefixObservation();
		observe(2);
		logCacheUsage(assistantMessage(), undefined, { sessionId: "reset" });

		const rows = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		);
		expect(rows[0]?.metadata?.injectedFindingsRepeated).toBe(0);
		expect(rows[1]?.metadata?.injectedFindingsRepeated).toBe(0);
		expect(rows[1]?.metadata?.injectedBytes).toEqual({
			sessionGuidance: 0,
			turnFindings: Buffer.byteLength(finding),
			testFindings: 0,
			agentNudge: 0,
			turnEndAdvisory: 0,
			other: 0,
		});
	});
});

describe("cache-observability — tool-result delivery bytes (#2800 item 7)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	const usageRows = () =>
		latencyEntries.filter((entry) => entry.phase === "cache_usage");

	it("sums two tool calls' delivered bytes onto the turn row", () => {
		recordToolResultDelivery({
			sessionId: "row",
			bytes: 100,
			truncated: false,
		});
		recordToolResultDelivery({
			sessionId: "row",
			bytes: 233,
			truncated: false,
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "row" });
		expect(usageRows()[0]?.metadata).toMatchObject({
			toolResultBytes: 333,
			toolResultsTruncated: 0,
		});
	});

	it("counts truncated results and resets both figures at the turn boundary", () => {
		recordToolResultDelivery({ sessionId: "turn", bytes: 50, truncated: true });
		recordToolResultDelivery({
			sessionId: "turn",
			bytes: 10,
			truncated: false,
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "turn" });
		expect(usageRows()[0]?.metadata).toMatchObject({
			toolResultBytes: 60,
			toolResultsTruncated: 1,
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "turn" });
		expect(usageRows()[1]?.metadata).toMatchObject({
			toolResultBytes: 0,
			toolResultsTruncated: 0,
		});
	});

	it("saturates the byte sum at the attribution bound and never goes negative", () => {
		recordToolResultDelivery({
			sessionId: "sat",
			bytes: 5_000_000,
			truncated: false,
		});
		recordToolResultDelivery({ sessionId: "sat", bytes: -12, truncated: true });
		logCacheUsage(assistantMessage(), undefined, { sessionId: "sat" });
		const metadata = usageRows()[0]?.metadata;
		expect(metadata?.toolResultBytes).toBeLessThanOrEqual(1_048_576);
		expect(metadata?.toolResultsTruncated).toBe(1);
	});
});

describe("cache-observability — where a request stops repeating the last one (#4743)", () => {
	const SID = "divergence";
	const head = { role: "system", content: "head" };
	const first = { role: "user", content: "first question" };
	const answer = { role: "assistant", content: "first answer" };
	const second = { role: "user", content: "second question" };
	/** `second` as request N carried it: pi-lens extended the prompt. */
	const secondInjected = {
		role: "user",
		content:
			"second question\n\n[pi-lens automated context — not a user request]",
	};
	const later = { role: "assistant", content: "second answer" };

	function observe(
		resultMessages: ReadonlyArray<{ role: string; content: unknown }>,
		injectedPositions: number[] = [],
	) {
		observeCacheContext({
			sessionId: SID,
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: resultMessages,
			resultMessages,
			injectedPositions,
		});
		return latencyEntries
			.filter((entry) => entry.phase === "cache_context")
			.at(-1)?.metadata;
	}

	function usage(cacheRead: number, input: number) {
		logCacheUsage(
			assistantMessage({
				usage: { input, output: 10, cacheRead, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: SID, turnIndex: 0 },
		);
		return latencyEntries
			.filter((entry) => entry.phase === "cache_usage")
			.at(-1)?.metadata;
	}

	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
		resetDegradationLedger();
	});

	it("names a miss after a request that dropped pi-lens's span `injection-dropped`", () => {
		expect(observe([head, first])).toMatchObject({
			prefixDivergence: "baseline",
		});
		usage(10_000, 100);
		// Request N: pi-lens extended the new prompt at position 3.
		expect(observe([head, first, answer, secondInjected], [3])).toMatchObject({
			prefixDivergence: "append-only",
			injectedSpanCount: 1,
		});
		usage(10_000, 100);
		// Request N+1 is pi's own transcript: it stops repeating N at position 3.
		expect(observe([head, first, answer, second, later])).toMatchObject({
			prefixDivergence: "diverged",
			firstDifferingMessageIndex: 3,
			previousRequestMessageCount: 4,
			divergedAtInjection: true,
		});
		expect(usage(0, 10_100)).toMatchObject({
			cacheMissCause: "injection-dropped",
			cacheMissKind: "zero-read",
		});
	});

	it("does not blame an injection for a break where pi-lens added nothing", () => {
		observe([head, first]);
		usage(10_000, 100);
		observe([head, first, answer, secondInjected], [3]);
		usage(10_000, 100);
		// The transcript changed at position 1, before the pi-lens span.
		expect(
			observe([head, { role: "user", content: "summary" }, second, later]),
		).toMatchObject({
			prefixDivergence: "diverged",
			firstDifferingMessageIndex: 1,
			divergedAtInjection: false,
		});
		expect(usage(0, 10_100)?.cacheMissCause).not.toBe("injection-dropped");
	});

	it("reads a request that repeats the previous one whole as append-only, with no cause", () => {
		observe([head, first, answer, secondInjected], [3]);
		usage(10_000, 100);
		expect(
			observe([head, first, answer, secondInjected, later], [3]),
		).toMatchObject({
			prefixDivergence: "append-only",
			firstDifferingMessageIndex: null,
			divergedAtInjection: false,
		});
		expect(usage(10_050, 100)?.cacheMissCause).toBeNull();
	});

	it("reports an unhashable request as unavailable, and the request after it too", () => {
		observe([head, first]);
		const cyclic: Record<string, unknown> = { role: "user" };
		cyclic.content = cyclic;
		expect(observe([head, cyclic as never])).toMatchObject({
			prefixDivergence: "unavailable",
			rollingDigestGap: "unserializable",
		});
		// Nothing to compare against is not a fresh baseline.
		expect(observe([head, first])).toMatchObject({
			prefixDivergence: "unavailable",
			rollingDigestGap: null,
		});
	});
});

describe("rollingMessageDigests bounds (#4743)", () => {
	it("hashes up to MAX_ROLLING_DIGEST_MESSAGES messages and refuses one more", () => {
		const messages = Array.from(
			{ length: MAX_ROLLING_DIGEST_MESSAGES },
			(_, index) => ({ role: "user", content: `m${index}` }),
		);
		expect(rollingMessageDigests(messages).complete).toBe(true);
		expect(
			rollingMessageDigests([
				...messages,
				{ role: "user", content: "one more" },
			]),
		).toEqual({ complete: false, gap: "too-many-messages" });
	});

	it("hashes a transcript of exactly MAX_ROLLING_DIGEST_CHARS and refuses one char more", () => {
		// `{"role":"user","content":"` + text + `"}` serializes to text + 28.
		const wrap = (text: string) => [{ role: "user", content: text }];
		const exact = "x".repeat(MAX_ROLLING_DIGEST_CHARS - 28);
		expect(JSON.stringify(wrap(exact)[0])).toHaveLength(
			MAX_ROLLING_DIGEST_CHARS,
		);
		expect(rollingMessageDigests(wrap(exact)).complete).toBe(true);
		expect(rollingMessageDigests(wrap(`${exact}x`))).toEqual({
			complete: false,
			gap: "too-many-chars",
		});
	});

	it("gives two lists the same digest at i exactly when their first i + 1 messages match", () => {
		const a = rollingMessageDigests([
			{ role: "user", content: "same" },
			{ role: "user", content: "a" },
		]);
		const b = rollingMessageDigests([
			{ role: "user", content: "same" },
			{ role: "user", content: "b" },
		]);
		expect(rollingDigestAt(a, 0)).toBe(rollingDigestAt(b, 0));
		expect(rollingDigestAt(a, 1)).not.toBe(rollingDigestAt(b, 1));
		expect(rollingDigestAt(a, 2)).toBeUndefined();
	});
});
