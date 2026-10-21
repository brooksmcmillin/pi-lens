import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_getWarmWordIndexCacheStateForTests,
	_resetWarmWordIndexCacheForTests,
	acquireWarmWordIndex,
} from "../../clients/mcp/analyze.js";
import { symbolSearch } from "../../clients/lens-engine.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	_projectSnapshotParseCacheRetainsWordIndexForTests,
	_resetProjectSnapshotParseCacheForTests,
	getSnapshotBodyReadCountForTests,
	resetSnapshotBodyReadCountForTests,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import {
	buildWordIndex,
	notifyWordIndexPublished,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocumentForEdit,
} from "../../clients/word-index.js";
import { suspendAt } from "./interleaving-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

// Leases the warm entry (creating it on first use) and hands back what a query
// would see, so a case reads the cache exactly the way `symbolSearch` does.
function warmIndexFor(
	cwd: string,
): ReturnType<typeof acquireWarmWordIndex>["index"] {
	const lease = acquireWarmWordIndex(cwd);
	try {
		return lease.index;
	} finally {
		lease.release();
	}
}

function persistIndex(cwd: string, symbol: string): void {
	const index = buildWordIndex([
		{
			path: path.join(cwd, "src", `${symbol}.ts`),
			content: `export const ${symbol} = true;`,
		},
	]);
	saveProjectSnapshot(cwd, {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: cwd,
		generatedAt: new Date().toISOString(),
		seq: 0,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [],
		wordIndex: serializeWordIndex(index),
	});
}

describe("MCP warm word-index lifecycle (#1370)", () => {
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		const env = setupTestEnvironment("word-index-eviction-");
		cleanup = env.cleanup;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		process.env.PI_LENS_WORD_INDEX_IDLE_EVICT_MS = "20";
		process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS = "8";
	});

	afterEach(() => {
		_resetWarmWordIndexCacheForTests();
		_resetProjectSnapshotParseCacheForTests();
		delete process.env.PILENS_DATA_DIR;
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		delete process.env.PI_LENS_WORD_INDEX_IDLE_EVICT_MS;
		delete process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS;
		vi.useRealTimers();
		vi.restoreAllMocks();
		cleanup?.();
	});

	it("adopts a published index into an empty entry for that root only (#4583)", () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "adopting-project");
		const other = path.join(process.env.PILENS_DATA_DIR!, "other-project");
		const cold = acquireWarmWordIndex(cwd);
		expect(cold.index).toBeUndefined();
		cold.release();
		const index = buildWordIndex([
			{
				path: path.join(cwd, "src", "adopted.ts"),
				content: "export const adoptedSymbol = true;",
			},
		]);

		// A publish for a sibling root never fills this root's entry.
		notifyWordIndexPublished(other, index, "cold_query");
		expect(warmIndexFor(cwd)).toBeUndefined();
		// Nor does an index without the forward map the cache requires.
		notifyWordIndexPublished(
			cwd,
			{ ...index, forward: undefined as never },
			"cold_query",
		);
		expect(warmIndexFor(cwd)).toBeUndefined();
		// The publishing root's own empty entry adopts the live object (no re-parse).
		notifyWordIndexPublished(cwd, index, "cold_query");
		expect(warmIndexFor(cwd)).toBe(index);
	});

	it("keeps the live in-place index when a build publishes for the same root (#4583)", () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "live-project");
		persistIndex(cwd, "liveSymbol");
		const liveLease = acquireWarmWordIndex(cwd);
		const liveIndex = liveLease.index!;
		liveLease.release();

		const published = buildWordIndex([
			{
				path: path.join(cwd, "src", "other.ts"),
				content: "export const otherSymbol = true;",
			},
		]);
		notifyWordIndexPublished(cwd, published, "session_start");

		// The entry stays the copy every `pilens_analyze` edit is applied to in
		// place, so an unpersisted edit cannot be dropped by a publish.
		expect(warmIndexFor(cwd)).toBe(liveIndex);
		expect(searchWordIndex(warmIndexFor(cwd)!, "live symbol")).toHaveLength(1);
	});

	// The reason the guard is "keep an entry that holds ANY index", not "keep the
	// larger one": the live copy carries edits the debounced persist has not
	// written yet, and a published index can easily hold more documents.
	it("keeps unpersisted in-place edits when a larger index is published (#4583)", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "edited-project");
		persistIndex(cwd, "edited");
		const liveLease = acquireWarmWordIndex(cwd);
		const liveIndex = liveLease.index!;
		liveLease.release();
		// The per-edit seam `pilens_analyze` uses mutates this copy in place; the
		// debounced persist has not landed, so this document exists only here.
		expect(
			await updateWordIndexDocumentForEdit(liveIndex, {
				path: path.join(cwd, "src", "edited.ts"),
				content: "export const pendingEdit = true;",
			}),
		).toBe(true);
		expect(liveIndex.docCount).toBe(1);

		const published = buildWordIndex([
			{
				path: path.join(cwd, "src", "other.ts"),
				content: "export const otherSymbol = true;",
			},
			{
				path: path.join(cwd, "src", "third.ts"),
				content: "export const thirdSymbol = true;",
			},
		]);
		// The build that publishes holds MORE documents than the live entry, which
		// is exactly the shape a "keep the larger index" widening would replace.
		expect(published.docCount).toBeGreaterThan(liveIndex.docCount);
		notifyWordIndexPublished(cwd, published, "session_start");

		expect(warmIndexFor(cwd)).toBe(liveIndex);
		expect(searchWordIndex(warmIndexFor(cwd)!, "pending edit")).toHaveLength(1);
	});

	it("idle-evicts and performs a real deserialize rebuild on the next query", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "project");
		persistIndex(cwd, "authenticateUser");
		const first = acquireWarmWordIndex(cwd);
		expect(searchWordIndex(first.index!, "authenticate user")).toHaveLength(1);
		const firstIndex = first.index;
		first.release();

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(0);

		const rebuilt = acquireWarmWordIndex(cwd);
		expect(rebuilt.index).not.toBe(firstIndex);
		expect(searchWordIndex(rebuilt.index!, "authenticate user")).toHaveLength(
			1,
		);
		rebuilt.release();
	});

	it("lease-guards a suspended query from idle eviction", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "busy-project");
		persistIndex(cwd, "leasedSymbol");
		const lease = acquireWarmWordIndex(cwd);
		const queryStep = vi.fn(async (index: NonNullable<typeof lease.index>) =>
			searchWordIndex(index, "leased symbol"),
		);
		const suspension = suspendAt(queryStep, async (index) =>
			searchWordIndex(index, "leased symbol"),
		);
		const query = queryStep(lease.index!).finally(() => lease.release());
		await suspension.admitted;

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(1);
		suspension.release();
		expect(await query).toHaveLength(1);
		suspension.restore();
	});

	it("evicts the least-recently-used idle root at the configured cap", async () => {
		process.env.PI_LENS_WORD_INDEX_MAX_WARM_ROOTS = "2";
		const roots = ["oldest", "middle", "newest"].map((name) =>
			path.join(process.env.PILENS_DATA_DIR!, name),
		);
		for (const [i, root] of roots.entries()) {
			persistIndex(root, `symbol${i}`);
			const lease = acquireWarmWordIndex(root);
			lease.release();
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(2);
		expect(_getWarmWordIndexCacheStateForTests().keys).not.toContain(roots[0]);
		const rebuiltOldest = acquireWarmWordIndex(roots[0]);
		rebuiltOldest.release();
		// Re-adding the evicted oldest root must evict one of the two prior residents.
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(2);
	});

	it("unrefs owned timers and clears them on disposal", () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "dispose-project");
		persistIndex(cwd, "disposeSymbol");
		const lease = acquireWarmWordIndex(cwd);
		lease.release();
		const timer = _getWarmWordIndexCacheStateForTests().timers[0];
		expect(timer).toBeDefined();
		expect(timer?.hasRef?.()).toBe(false);
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		_resetWarmWordIndexCacheForTests();
		expect(clearSpy).toHaveBeenCalledWith(timer);
		expect(_getWarmWordIndexCacheStateForTests()).toMatchObject({
			size: 0,
			keys: [],
			timers: [],
		});
	});

	it("re-reads the full body once per warm-index eviction cycle and serves metadata from the stripped cache", async () => {
		const cwd = path.join(process.env.PILENS_DATA_DIR!, "snapshot-project");
		persistIndex(cwd, "snapshotSymbol");
		// Model a reader process that did not perform the write/promotion itself.
		_resetProjectSnapshotParseCacheForTests();
		resetSnapshotBodyReadCountForTests();

		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		// acquireWarmWordIndex performs the sole full-body read; symbolSearch's
		// metadata load shares the postings-stripped cached body.
		expect(getSnapshotBodyReadCountForTests()).toBe(1);
		expect(_projectSnapshotParseCacheRetainsWordIndexForTests()).toBe(false);

		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		expect(getSnapshotBodyReadCountForTests()).toBe(1);

		await vi.advanceTimersByTimeAsync(20);
		expect(_getWarmWordIndexCacheStateForTests().size).toBe(0);
		expect((await symbolSearch("snapshot symbol", cwd)).results).toHaveLength(
			1,
		);
		expect(getSnapshotBodyReadCountForTests()).toBe(2);
		expect(_projectSnapshotParseCacheRetainsWordIndexForTests()).toBe(false);
	});
});
