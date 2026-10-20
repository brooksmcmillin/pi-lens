/**
 * #4402 fault injection: each persist host's real `message` listener, and the
 * worker side's request listener, survive a malformed, an error-shaped and a
 * foreign message, and take the documented fallback.
 *
 * Recurrence (#4400): the project-snapshot host passed `result.stagePath`
 * from a worker message to `fs.rmSync` without checking it. The throw left
 * the listener as an uncaught exception and pi exited. The review-graph host
 * had the same reads.
 *
 * Documented fallback, per message:
 * - malformed (not an object, or no numeric `id` and `generation`): dropped,
 *   and counted once per worker and session in the degradation ledger as
 *   `persist-worker-message-contained`, subject `<host> persist worker:
 *   rejected`. The worker stays enabled.
 * - error-shaped (a routable result with `error` set, or a field of the wrong
 *   type): the host's existing error path, the main-thread write.
 * - foreign (another protocol's object, or a result for an id the host does
 *   not track): dropped or ignored; the in-flight request still completes
 *   through the worker.
 * - a throw below the listener: counted as `<host> persist worker: threw`.
 *
 * How messages arrive. The real worker script runs and its real results reach
 * the host's own listener; tests/clients/worker-message-kit.ts rewrites a
 * result at that boundary, or delivers a message the real worker never
 * produces through `worker.emit("message", …)` on the Worker the host made,
 * which is the dispatch a thread message takes. The kit records a listener
 * throw where pi would exit.
 *
 * The stage-directory (EISDIR) probe from #4402's comment is the snapshot
 * case `survives a failed reap of an error result's stage and still falls
 * back` in tests/clients/project-snapshot-worker-result-stagepath.test.ts
 * (#4406 round 2); the review-graph superseded branch's twin is below.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	resetProjectSnapshotPersistWorkerForTests,
	saveProjectSnapshot,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
	_resetProjectSnapshotParseCacheForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getReviewGraphWorkerFallbackReasonForTests,
	resetReviewGraphPersistWorkerForTests,
	reviewGraphCachePath,
	terminateReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { waitFor } from "./interleaving-kit.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";
import { observeWorker } from "./worker-message-kit.js";

const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/snapshot-persist/released-4.3.0",
);
const releasedBodyJson = fs.readFileSync(
	path.join(CORPUS, "snapshot.json"),
	"utf-8",
);

function releasedSnapshot(): ProjectSnapshot {
	return JSON.parse(releasedBodyJson) as ProjectSnapshot;
}

/** Messages the real worker never sends: none can be routed to a request. */
const MALFORMED: readonly unknown[] = [
	null,
	undefined,
	"persist done",
	42,
	[],
	{ id: "1", generation: 0 },
];

/** A message whose first field read throws: a stand-in for any throw below the listener. */
function throwingMessage(): object {
	return Object.defineProperty({}, "id", {
		enumerable: true,
		get() {
			throw new Error("getter boom");
		},
	});
}

/** Per-subject count of `persist-worker-message-contained` this session. */
function containedCount(subject: string): number {
	const entry = getDegradationSummary()
		.find((group) => group.kind === "persist-worker-message-contained")
		?.latestReasons.find((reason) => reason.subject === subject);
	return Number(/\(count: (\d+)\)$/.exec(entry?.reason ?? "")?.[1] ?? 0);
}

async function expectStagesGone(paths: readonly string[]): Promise<void> {
	await waitFor(
		() => paths.filter((stagePath) => fs.existsSync(stagePath)),
		(left) => left.length === 0,
		{ timeoutMs: 5_000 },
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("project-snapshot host message boundary (#4402, recurrence #4400)", () => {
	const envs: Array<() => void> = [];

	function projectDir(): string {
		const env = setupTestEnvironment("snapshot-message-boundary-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		envs.push(() => {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		});
		return path.join(env.tmpDir, "project");
	}

	async function settle(cwd: string): Promise<void> {
		await waitFor(
			() => getProjectSnapshotPersistStateForTests(cwd),
			(state) => !state.active && !state.queued,
			{ timeoutMs: 15_000 },
		);
	}

	function writtenBody(cwd: string): string {
		return gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(
			"utf-8",
		);
	}

	beforeEach(() => {
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		resetProjectSnapshotPersistWorkerForTests();
		_resetProjectSnapshotParseCacheForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await waitForProjectSnapshotPersistsForTests();
		await terminateProjectSnapshotPersistWorkerForTests();
		resetProjectSnapshotPersistWorkerForTests();
		_resetProjectSnapshotParseCacheForTests();
		delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
		// Newest first: each cleanup restores the data dir the one before it set.
		for (const cleanup of envs.splice(0).reverse()) cleanup();
	});

	it("drops and counts a malformed message, and the worker keeps persisting", async () => {
		const cwd = projectDir();
		const observed = observeWorker();
		const first = releasedSnapshot();
		saveProjectSnapshot(cwd, first);
		await settle(cwd);
		const [worker] = observed.workers;
		expect(worker).toBeInstanceOf(Worker);

		for (const value of MALFORMED) worker.emit("message", value);

		expect(observed.thrown).toEqual([]);
		expect(containedCount("project-snapshot persist worker: rejected")).toBe(
			MALFORMED.length,
		);
		saveProjectSnapshot(cwd, { ...first, seq: first.seq + 1 });
		await settle(cwd);
		expect(getProjectSnapshotPersistErrorForTests()).toBeUndefined();
		expect(getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites).toBe(
			2,
		);
	});

	it("falls back to the main-thread write for an error-shaped result", async () => {
		for (const error of ["worker gave up", { code: "EIO" }]) {
			const cwd = projectDir();
			resetProjectSnapshotPersistWorkerForTests();
			const observed = observeWorker({
				transformResult: (message) => ({
					id: message.id,
					generation: message.generation,
					error,
				}),
			});
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);

			expect(observed.thrown).toEqual([]);
			expect(getProjectSnapshotPersistErrorForTests()).toBe(
				typeof error === "string" ? error : "malformed worker result: error",
			);
			expect(writtenBody(cwd)).toBe(releasedBodyJson);
			await expectStagesGone(observed.sentStagePaths);
			vi.restoreAllMocks();
			await terminateProjectSnapshotPersistWorkerForTests();
		}
	});

	it("ignores a foreign message while a real request completes through the worker", async () => {
		const cwd = projectDir();
		process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "200";
		const observed = observeWorker();
		saveProjectSnapshot(cwd, releasedSnapshot());
		await waitFor(
			() => observed.workers.length,
			(count) => count === 1,
			{ timeoutMs: 5_000 },
		);
		const [worker] = observed.workers;

		// Another protocol's object, and a result for an id nobody sent.
		worker.emit("message", { type: "progress", done: 1 });
		worker.emit("message", { id: 1_000_000_000, generation: 0 });
		await settle(cwd);

		expect(observed.thrown).toEqual([]);
		expect(containedCount("project-snapshot persist worker: rejected")).toBe(1);
		expect(getProjectSnapshotPersistErrorForTests()).toBeUndefined();
		expect(getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites).toBe(
			1,
		);
		expect(writtenBody(cwd)).toBe(releasedBodyJson);
	});

	it("contains and counts a throw below the listener", async () => {
		const cwd = projectDir();
		const observed = observeWorker();
		saveProjectSnapshot(cwd, releasedSnapshot());
		await settle(cwd);

		observed.workers[0].emit("message", throwingMessage());

		expect(observed.thrown).toEqual([]);
		expect(containedCount("project-snapshot persist worker: threw")).toBe(1);
	});
});

describe("review-graph host message boundary (#4402, recurrence #4400)", () => {
	const SOURCES: Record<string, string> = {
		"src/a.ts": "export const alpha = 1;\n",
		"src/b.ts": "import { alpha } from './a';\nexport const beta = alpha;\n",
	};
	const roots: string[] = [];

	function makeRoot(): string {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-graph-message-"),
		);
		roots.push(root);
		for (const [relative, content] of Object.entries(SOURCES)) {
			const file = path.join(root, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
		}
		return root;
	}

	beforeEach(() => {
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		resetReviewGraphPersistWorkerForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();
		await terminateReviewGraphPersistWorkerForTests();
		resetReviewGraphPersistWorkerForTests();
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		delete process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS;
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		for (const root of roots.splice(0)) removeTempDirSync(root);
	});

	it("drops and counts a malformed message, and the worker keeps persisting", async () => {
		const root = makeRoot();
		const observed = observeWorker();
		await buildOrUpdateGraph(root, [], new FactStore());
		await waitForReviewGraphPersistsForTests();
		const [worker] = observed.workers;
		expect(worker).toBeInstanceOf(Worker);

		for (const value of MALFORMED) worker.emit("message", value);

		expect(observed.thrown).toEqual([]);
		expect(containedCount("review-graph persist worker: rejected")).toBe(
			MALFORMED.length,
		);
		const seenBefore = observed.seen.length;
		fs.writeFileSync(path.join(root, "src/c.ts"), "export const gamma = 3;\n");
		await buildOrUpdateGraph(
			root,
			[path.join(root, "src/c.ts")],
			new FactStore(),
		);
		await waitForReviewGraphPersistsForTests();
		// The second persist went through the same worker, not the fallback.
		expect(observed.seen.length).toBeGreaterThan(seenBefore);
		expect(getReviewGraphWorkerFallbackReasonForTests()).toBeUndefined();
	});

	it("falls back to the main-thread write for an error-shaped result", async () => {
		for (const error of ["worker gave up", { code: "EIO" }]) {
			const root = makeRoot();
			resetReviewGraphPersistWorkerForTests();
			const observed = observeWorker({
				transformResult: (message) => ({
					id: message.id,
					generation: message.generation,
					error,
				}),
			});
			await buildOrUpdateGraph(root, [], new FactStore());
			await waitForReviewGraphPersistsForTests();

			expect(observed.thrown).toEqual([]);
			expect(getReviewGraphWorkerFallbackReasonForTests()).toBe(
				typeof error === "string" ? error : "malformed worker result: error",
			);
			expect(fs.existsSync(reviewGraphCachePath(root))).toBe(true);
			await expectStagesGone(observed.sentStagePaths);
			vi.restoreAllMocks();
			await terminateReviewGraphPersistWorkerForTests();
		}
	});

	it("ignores a foreign message while a real request completes through the worker", async () => {
		const root = makeRoot();
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "200";
		const observed = observeWorker();
		await buildOrUpdateGraph(root, [], new FactStore());
		await waitFor(
			() => observed.workers.length,
			(count) => count === 1,
			{ timeoutMs: 5_000 },
		);
		const [worker] = observed.workers;

		worker.emit("message", { type: "progress", done: 1 });
		worker.emit("message", { id: 1_000_000_000, generation: 0 });
		await waitForReviewGraphPersistsForTests();

		expect(observed.thrown).toEqual([]);
		expect(containedCount("review-graph persist worker: rejected")).toBe(1);
		expect(getReviewGraphWorkerFallbackReasonForTests()).toBeUndefined();
		expect(fs.existsSync(reviewGraphCachePath(root))).toBe(true);
	});

	it("contains and counts a throw below the listener", async () => {
		const root = makeRoot();
		const observed = observeWorker();
		await buildOrUpdateGraph(root, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		observed.workers[0].emit("message", throwingMessage());

		expect(observed.thrown).toEqual([]);
		expect(containedCount("review-graph persist worker: threw")).toBe(1);
	});

	// #4402 comment: the superseded branch's reapStageFile had no test, so a
	// bare fs.rmSync there kept every case green. A stage path that is a
	// non-empty directory makes the reap fail for real (EISDIR, the stand-in
	// for a Windows EBUSY/EPERM).
	it("reaps a superseded generation's stage it cannot remove without a contained throw", async () => {
		const root = makeRoot();
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "150";
		let blocked: string | undefined;
		const observed = observeWorker({
			beforeRequest: (request) => {
				if (blocked !== undefined || request.stagePath === undefined) return;
				blocked = request.stagePath;
				fs.mkdirSync(blocked, { recursive: true });
				fs.writeFileSync(path.join(blocked, "blocker"), "x");
			},
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		// A second build schedules a newer generation while the first is in flight.
		fs.writeFileSync(path.join(root, "src/c.ts"), "export const gamma = 3;\n");
		await buildOrUpdateGraph(
			root,
			[path.join(root, "src/c.ts")],
			new FactStore(),
		);
		await waitFor(
			() => observed.seen.length,
			(count) => count >= 2,
			{ timeoutMs: 15_000 },
		);
		await waitForReviewGraphPersistsForTests();

		expect(observed.thrown).toEqual([]);
		// The helper logged the failed reap and the superseded record ran; the
		// listener's last-resort catch did not have to.
		expect(containedCount("review-graph persist worker: threw")).toBe(0);
		expect(blocked).toBeDefined();
		expect(fs.existsSync(path.join(blocked as string, "blocker"))).toBe(true);
		expect(fs.existsSync(reviewGraphCachePath(root))).toBe(true);
	});
});

describe("persist worker request boundary (#4402)", () => {
	const WORKER_SCRIPT = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../clients/review-graph/persist-worker.js",
	);
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});

	it("answers a malformed request with an error result and keeps serving", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-worker-req-"));
		dirs.push(dir);
		const worker = new Worker(WORKER_SCRIPT);
		const replies: unknown[] = [];
		const failures: unknown[] = [];
		worker.on("message", (reply: unknown) => replies.push(reply));
		worker.on("error", (err) => failures.push(err));
		worker.on("exit", (code) => failures.push(`exit ${code}`));
		try {
			const stagePath = path.join(dir, "review-graph.json.gz.stage-1-0");
			worker.postMessage(null);
			worker.postMessage({ id: 7, generation: 1 });
			worker.postMessage({
				id: 8,
				generation: 1,
				stagePath,
				data: { nodes: [] },
				cwd: dir,
				elements: 0,
			});
			// A worker that dies on the first request never answers the rest.
			await waitFor(
				() => ({ replies: replies.length, failures: failures.length }),
				(state) => state.replies >= 3 || state.failures > 0,
				{ timeoutMs: 4_000 },
			);

			expect(failures).toEqual([]);
			expect(replies).toEqual(
				expect.arrayContaining([
					{
						error: "malformed persist request: not a routable object (null)",
					},
					{
						id: 7,
						generation: 1,
						error: "malformed persist request: no stage path",
					},
					expect.objectContaining({ id: 8, generation: 1, stagePath }),
				]),
			);
			expect(
				replies.find((reply) => (reply as { id?: number }).id === 8),
			).not.toHaveProperty("error");
			expect(fs.existsSync(stagePath)).toBe(true);
		} finally {
			await worker.terminate();
		}
	});
});
