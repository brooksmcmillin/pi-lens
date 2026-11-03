// flake-shape: service-double — #4485: the expiry and peek reads go to the client an outstanding touch holds; a real server cannot be made to publish before the touch expires on demand
/**
 * #1899: the tier-3 outstanding-touch registry's own bounds, and the backlog
 * gauge the reconcile sweep writes.
 *
 * The registry is drained in full by every reconcile sweep, but the sweep runs
 * on pi's `agent_settled` quiet window. Dogfooding measured sweeps up to 52
 * minutes apart (cascade.log, 2026-08-09..20, 67 sweeps / 756 outcomes), so
 * between sweeps the registry had no size bound and no age bound at all. These
 * tests pin both bounds, and pin the gauge that makes backlog health readable
 * from cascade.log alone.
 *
 * The classifier, the reconcile verdicts, and the kill switch live in
 * cascade-tier.test.ts; this file covers only the bounds and the observability.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeMapKey } from "../../../clients/path-utils.js";

const registerQuietWindowTask = vi.fn();
// Module scope so the spy identity survives `vi.resetModules()` — a
// factory-local `vi.fn()` is rebuilt with the module, and the assertions would
// then read a different spy than the code under test called.
const logCascade = vi.fn();

vi.mock("../../../clients/quiet-window.js", () => ({
	registerQuietWindowTask,
}));

vi.mock("../../../clients/cascade-logger.js", () => ({
	logCascade,
}));

const FILE = "C:/repo/neighbor.ts";

/** Mirrors `MAX_OUTSTANDING_TOUCHES` in clients/lsp/cascade-tier.ts. */
const CAP = 256;
/** Mirrors `OUTSTANDING_TOUCH_MAX_AGE_MS` in clients/lsp/cascade-tier.ts. */
const MAX_AGE_MS = 15 * 60_000;

type Mod = typeof import("../../../clients/lsp/cascade-tier.js");
type Ledger = typeof import("../../../clients/degradation-ledger.js");

let mod: Mod;
let ledger: Ledger;

beforeEach(async () => {
	vi.resetModules();
	registerQuietWindowTask.mockReset();
	logCascade.mockClear();
	mod = await import("../../../clients/lsp/cascade-tier.js");
	ledger = await import("../../../clients/degradation-ledger.js");
	ledger.resetDegradationLedger();
	mod._resetOutstandingCascadeTouchesForTests();
	mod._resetCascadeTierReconcileRegistrationForTests();
});

function record(filePath: string, touchedAt: number): void {
	mod.recordOutstandingCascadeTouch({
		filePath,
		serverId: "typescript",
		touchedAt,
	});
}

function heldPaths(): string[] {
	return mod._getOutstandingCascadeTouchesForTests().map((t) => t.filePath);
}

function warm(serverId: string, rows: [string, unknown[], number][]) {
	return {
		client: {
			serverId,
			getAllDiagnostics: vi
				.fn()
				.mockReturnValue(
					new Map(
						rows.map(([p, diags, ts]) => [normalizeMapKey(p), { diags, ts }]),
					),
				),
		},
	};
}

function sweepGauge(): { phase: string; metadata: Record<string, unknown> } {
	const row = logCascade.mock.calls
		.map((call) => call[0])
		.find((candidate) => candidate?.phase === "cascade_tier3_reconcile");
	if (!row) throw new Error("no cascade_tier3_reconcile record was written");
	return row;
}

describe("registry size bound", () => {
	it("caps the registry and evicts the OLDEST touch first", () => {
		const base = Date.now();
		for (let i = 0; i < CAP; i++) record(`C:/repo/f${i}.ts`, base - CAP + i);
		expect(heldPaths()).toHaveLength(CAP);

		record("C:/repo/overflow.ts", base);

		const paths = heldPaths();
		expect(paths).toHaveLength(CAP);
		// f0 held the oldest touch, so it is the one that goes.
		expect(paths).not.toContain("C:/repo/f0.ts");
		expect(paths).toContain("C:/repo/f1.ts");
		expect(paths).toContain("C:/repo/overflow.ts");
	});

	it("records the eviction in the degradation ledger", () => {
		const base = Date.now();
		for (let i = 0; i <= CAP; i++) record(`C:/repo/f${i}.ts`, base - CAP + i);

		const group = ledger
			.getDegradationSummary()
			.find((g) => g.kind === "cascade-tier3-backlog-evicted");
		expect(group?.count).toBe(1);
	});

	it("does not evict while the registry is inside the cap", () => {
		const base = Date.now();
		for (let i = 0; i < CAP; i++) record(`C:/repo/f${i}.ts`, base - CAP + i);

		expect(
			ledger
				.getDegradationSummary()
				.find((g) => g.kind === "cascade-tier3-backlog-evicted"),
		).toBeUndefined();
	});

	// The `delete` before the `set` in `recordOutstandingCascadeTouch` is what
	// keeps the map in TOUCH order. Without it, `Map.set` on an existing key
	// keeps that key's ORIGINAL position, so a re-touched file would still be
	// evicted as "oldest" even though its touch is the newest in the registry.
	it("re-touching a file moves it to the newest position", () => {
		const base = Date.now();
		for (let i = 0; i < CAP; i++) record(`C:/repo/f${i}.ts`, base - CAP + i);
		record("C:/repo/f0.ts", base + 1);

		record("C:/repo/overflow.ts", base + 2);

		const paths = heldPaths();
		expect(paths).toContain("C:/repo/f0.ts");
		// f1 is now the oldest surviving touch, so it is the one evicted.
		expect(paths).not.toContain("C:/repo/f1.ts");
	});
});

describe("registry age bound", () => {
	it("drops a touch older than the bound when a new touch is recorded", () => {
		const now = Date.now();
		record("C:/repo/ancient.ts", now - MAX_AGE_MS - 1);
		record("C:/repo/fresh.ts", now);

		expect(heldPaths()).toEqual(["C:/repo/fresh.ts"]);
	});

	it("keeps a touch that is still inside the bound", () => {
		const now = Date.now();
		record("C:/repo/old-but-ok.ts", now - MAX_AGE_MS + 60_000);
		record("C:/repo/fresh.ts", now);

		expect(heldPaths()).toContain("C:/repo/old-but-ok.ts");
	});

	// The bound must hold when no further touch arrives to trigger the
	// record-time prune. That is the dogfood shape exactly: a burst of touches,
	// a long busy stretch with no cascade, then one very late quiet window.
	it("never reconciles a touch that aged past the bound while waiting for a sweep", async () => {
		const getWarmClientForFile = vi.fn();
		record("C:/repo/ancient.ts", Date.now() - MAX_AGE_MS - 1);

		const outcomes = await mod.reconcileOutstandingCascadeTouches({
			getWarmClientForFile,
		} as never);

		expect(outcomes).toEqual([]);
		expect(getWarmClientForFile).not.toHaveBeenCalled();
	});

	it("still reconciles a touch that is inside the bound", async () => {
		const touchedAt = Date.now() - 1_000;
		record(FILE, touchedAt);

		const outcomes = await mod.reconcileOutstandingCascadeTouches({
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(warm("typescript", [[FILE, [], touchedAt + 500]])),
		} as never);

		expect(outcomes[0]?.outcome).toBe("resolved-clean");
	});
});

describe("backlog gauge", () => {
	it("reports expired and evicted counts on the next sweep, then resets them", async () => {
		const base = Date.now();
		record("C:/repo/ancient.ts", base - MAX_AGE_MS - 1);
		for (let i = 0; i <= CAP; i++) record(`C:/repo/f${i}.ts`, base - CAP + i);

		mod.registerCascadeTierReconcileTask(
			() =>
				({
					getWarmClientForFile: vi.fn().mockResolvedValue(undefined),
				}) as never,
		);
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		expect(sweepGauge().metadata).toMatchObject({
			count: CAP,
			expired: 1,
			evicted: 1,
			capacity: CAP,
			maxAgeCapMs: MAX_AGE_MS,
		});

		// The two counters are since-last-sweep, not cumulative.
		logCascade.mockClear();
		await task();
		expect(sweepGauge().metadata).toMatchObject({ expired: 0, evicted: 0 });
	});

	it("breaks the unresolved count down by reason", async () => {
		const touchedAt = Date.now() - 1_000;
		mod.registerCascadeTierReconcileTask(
			() =>
				({
					getWarmClientForFile: vi
						.fn()
						.mockImplementation(async (filePath: string) =>
							filePath.endsWith("a.ts") ? undefined : warm("typescript", []),
						),
				}) as never,
		);
		record("C:/repo/a.ts", touchedAt);
		record("C:/repo/b.ts", touchedAt);

		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		const metadata = sweepGauge().metadata;
		expect(metadata.unresolved).toBe(2);
		expect(metadata.unresolvedByReason).toEqual({
			"warm-miss": 1,
			"no-publish": 1,
		});
		expect(metadata.maxAgeMs as number).toBeGreaterThan(0);
	});
});

/**
 * `unresolved` used to be one undifferentiated word covering five distinct
 * causes, which is what made the dogfood backlog unreadable: 676 of 756
 * outcomes were unresolved, and an EXPECTED silence from a `silentOnClean`
 * server looked exactly like a server that had gone cold.
 */
describe("unresolved reason discrimination", () => {
	async function reasonFor(
		getWarmClientForFile: ReturnType<typeof vi.fn>,
	): Promise<string | undefined> {
		const touchedAt = Date.now() - 1_000;
		record(FILE, touchedAt);
		const outcomes = await mod.reconcileOutstandingCascadeTouches({
			getWarmClientForFile,
		} as never);
		expect(outcomes[0]?.outcome).toBe("unresolved");
		return outcomes[0]?.unresolvedReason;
	}

	it("warm-miss: the server was idle-reaped since the touch", async () => {
		expect(await reasonFor(vi.fn().mockResolvedValue(undefined))).toBe(
			"warm-miss",
		);
	});

	it("server-mismatch: a different server is warm for the file now", async () => {
		expect(
			await reasonFor(
				vi.fn().mockResolvedValue(warm("deno", [[FILE, [], Date.now()]])),
			),
		).toBe("server-mismatch");
	});

	it("no-publish: the client holds no entry for the file at all", async () => {
		expect(
			await reasonFor(vi.fn().mockResolvedValue(warm("typescript", []))),
		).toBe("no-publish");
	});

	it("no-publish-since-touch: the only entry predates the touch", async () => {
		expect(
			await reasonFor(
				vi
					.fn()
					.mockResolvedValue(
						warm("typescript", [[FILE, [], Date.now() - 60_000]]),
					),
			),
		).toBe("no-publish-since-touch");
	});

	it("error: the client lookup threw", async () => {
		expect(await reasonFor(vi.fn().mockRejectedValue(new Error("boom")))).toBe(
			"error",
		);
	});
});

/**
 * #4485: the registry keeps only touches the in-lane wait left unanswered.
 * turn_end peeks it once after its settle, and an entry reaching the age bound
 * is read once more before it goes, so what it held is delivered or logged
 * instead of vanishing.
 */
describe("residual peek, expiry read and reset count (#4485)", () => {
	const errorDiag = {
		severity: 1,
		message: "late error",
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};

	function liveClient(rows: [string, unknown[], number][]) {
		return {
			serverId: "typescript",
			getAllDiagnostics: () =>
				new Map(
					rows.map(([p, diags, ts]) => [normalizeMapKey(p), { diags, ts }]),
				),
			isAlive: () => true,
		};
	}

	function rowsOf(phase: string) {
		return logCascade.mock.calls
			.map((call) => call[0])
			.filter((candidate) => candidate?.phase === phase);
	}

	// Recurrence (#4485): touches past the age bound were discarded unread;
	// the forensic window could not say what 153 of them held.
	it("an expiring outstanding touch is peeked once and its path logged", () => {
		const onResolvedFound = vi.fn();
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn() }) as never,
			{ onResolvedFound },
		);
		const touchedAt = Date.now() - 1_000;
		const client = liveClient([[FILE, [errorDiag], touchedAt + 10]]);
		const silentClient = liveClient([]);
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
			client: new WeakRef(client),
		} as never);
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/silent.ts",
			serverId: "typescript",
			touchedAt,
			client: new WeakRef(silentClient),
		} as never);

		// Both age past the bound together; the next touch's record-time prune
		// reaches them in one sweep.
		vi.useFakeTimers({ now: touchedAt + MAX_AGE_MS + 1_000 });
		try {
			record("C:/repo/fresh.ts", Date.now());
		} finally {
			vi.useRealTimers();
		}

		expect(heldPaths()).toEqual(["C:/repo/fresh.ts"]);
		expect(onResolvedFound).toHaveBeenCalledTimes(1);
		expect(onResolvedFound).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: FILE,
				diagnostics: [errorDiag],
				publishedAt: touchedAt + 10,
			}),
		);
		const expired = rowsOf("cascade_tier3_expired");
		expect(expired).toHaveLength(1);
		expect(expired[0].metadata).toMatchObject({
			count: 2,
			found: 1,
			clean: 0,
			unanswered: 1,
			paths: [FILE, "C:/repo/silent.ts"],
		});
	});

	it("a peek delivers answered touches and keeps the silent ones outstanding", () => {
		const onResolvedFound = vi.fn();
		const onResolvedClean = vi.fn();
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn() }) as never,
			{ onResolvedFound, onResolvedClean },
		);
		const touchedAt = Date.now() - 1_000;
		const client = liveClient([
			["C:/repo/found.ts", [errorDiag], touchedAt + 5],
			["C:/repo/clean.ts", [], touchedAt + 5],
			// Published before the touch: not an answer to it.
			["C:/repo/stale.ts", [], touchedAt - 5],
		]);
		for (const filePath of [
			"C:/repo/found.ts",
			"C:/repo/clean.ts",
			"C:/repo/stale.ts",
			"C:/repo/silent.ts",
		]) {
			mod.recordOutstandingCascadeTouch({
				filePath,
				serverId: "typescript",
				touchedAt,
				client: new WeakRef(client),
			} as never);
		}

		mod.peekOutstandingCascadeTouches();

		expect(onResolvedFound).toHaveBeenCalledTimes(1);
		expect(onResolvedFound).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: "C:/repo/found.ts" }),
		);
		expect(onResolvedClean).toHaveBeenCalledTimes(1);
		expect(onResolvedClean).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: "C:/repo/clean.ts",
				publishedAt: touchedAt + 5,
			}),
		);
		expect(heldPaths()).toEqual(["C:/repo/stale.ts", "C:/repo/silent.ts"]);
		const peek = rowsOf("cascade_tier3_peek");
		expect(peek).toHaveLength(1);
		expect(peek[0].metadata).toMatchObject({
			count: 4,
			found: 1,
			clean: 1,
			outstanding: 2,
		});
	});

	// Recurrence (#4495 round-2 verify R2-1): a late answer's run carried
	// only its publish stamp, so the pending record could not tell a write
	// that landed between the touch and the publish from no write at all.
	// Both reads hand on the touch's pre-notify stamp, the read bound.
	it("a late answer carries the touch's pre-notify stamp, from the peek and from the quiet-window reconcile", async () => {
		const onResolvedFound = vi.fn();
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn() }) as never,
			{ onResolvedFound },
		);
		const touchedAt = Date.now() - 1_000;
		const client = liveClient([[FILE, [errorDiag], touchedAt + 5]]);
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
			client: new WeakRef(client),
		} as never);
		mod.peekOutstandingCascadeTouches();
		expect(onResolvedFound).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: FILE, touchedAt }),
		);

		record(FILE, touchedAt);
		const outcomes = await mod.reconcileOutstandingCascadeTouches({
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warm("typescript", [[FILE, [errorDiag], touchedAt + 5]]),
				),
		} as never);
		expect(outcomes[0]).toMatchObject({ outcome: "resolved-found", touchedAt });
	});

	// Recurrence (#4495 review F3): the peek rebuilt the client's whole
	// per-file diagnostics map once per outstanding touch, O(touches x
	// tracked files) on turn_end's synchronous path.
	it("a peek reads each client's diagnostics once, however many touches it holds", () => {
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn() }) as never,
			{ onResolvedFound: vi.fn(), onResolvedClean: vi.fn() },
		);
		const touchedAt = Date.now() - 1_000;
		const client = liveClient([
			["C:/repo/found.ts", [errorDiag], touchedAt + 5],
			["C:/repo/clean.ts", [], touchedAt + 5],
		]);
		const read = vi.spyOn(client, "getAllDiagnostics");
		const other = liveClient([["C:/repo/other.ts", [], touchedAt + 5]]);
		const otherRead = vi.spyOn(other, "getAllDiagnostics");
		for (const filePath of [
			"C:/repo/found.ts",
			"C:/repo/clean.ts",
			"C:/repo/silent-1.ts",
			"C:/repo/silent-2.ts",
		]) {
			mod.recordOutstandingCascadeTouch({
				filePath,
				serverId: "typescript",
				touchedAt,
				client: new WeakRef(client),
			} as never);
		}
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/other.ts",
			serverId: "typescript",
			touchedAt,
			client: new WeakRef(other),
		} as never);

		mod.peekOutstandingCascadeTouches();

		expect(read).toHaveBeenCalledTimes(1);
		expect(otherRead).toHaveBeenCalledTimes(1);
		expect(heldPaths()).toEqual(["C:/repo/silent-1.ts", "C:/repo/silent-2.ts"]);
	});

	it("a peek of an empty registry writes no row", () => {
		mod.peekOutstandingCascadeTouches();
		expect(rowsOf("cascade_tier3_peek")).toEqual([]);
	});

	it("a session reset logs how many outstanding touches it dropped", () => {
		record("C:/repo/a.ts", Date.now());
		record("C:/repo/b.ts", Date.now());

		mod.resetCascadeTierSessionState();

		expect(heldPaths()).toEqual([]);
		const dropped = rowsOf("cascade_tier3_dropped");
		expect(dropped).toHaveLength(1);
		expect(dropped[0].metadata).toMatchObject({ count: 2 });

		logCascade.mockClear();
		mod.resetCascadeTierSessionState();
		expect(rowsOf("cascade_tier3_dropped")).toEqual([]);
	});
});
