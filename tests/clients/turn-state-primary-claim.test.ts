/**
 * #4751: the primary's turn_start claim of the turn-state envelope
 * (`CacheManager.claimPrimaryTurnState`), through the real store.
 *
 * The writer (`addModifiedRange`) reads a session's role from the envelope's
 * persisted owner: a pi owner of this process with another id makes the
 * writer a secondary. The claim keeps that premise true for the live primary.
 * It admits two forms (an in-process predecessor's envelope, whose files it
 * keeps unless the owner is past the stale bound, and an envelope with no
 * owner and no files) and refuses every other, so the cells below pin the
 * admitted forms by what the primary's next write does, and two refused forms
 * by the envelope they leave untouched. The newSession path end to end
 * is `tests/index-4751-newsession-turn-end-scope.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-4751-claim-");
});

afterEach(() => {
	env.cleanup();
});

function writeTurnStateFile(cwd: string, state: unknown): void {
	const dir = getProjectDataDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "turn-state.json"),
		JSON.stringify(state, null, 2),
	);
}

function source(name: string): string {
	const file = path.join(env.tmpDir, "src", name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export const a = 1;\n");
	return file;
}

const RANGE = { start: 1, end: 1 };

describe("#4751 the primary's claim of the turn-state envelope", () => {
	it("hands an in-process predecessor's worklist to the successor, whose next write joins it", () => {
		// RECURRENCE GUARDED: #4751 row "P1 left work": without the claim the
		// successor's write went to a partition its turn end never reads.
		const cache = new CacheManager(false);
		cache.addModifiedRange(source("left.ts"), RANGE, false, env.tmpDir, "p1");

		expect(cache.claimPrimaryTurnState(env.tmpDir, "p2")).toEqual({
			from: "p1",
			arm: "predecessor",
			filesKept: 1,
		});
		cache.addModifiedRange(source("mine.ts"), RANGE, false, env.tmpDir, "p2");

		// The primary's turn end reads the envelope (no session id).
		const state = cache.readTurnState(env.tmpDir);
		expect(state.owner?.id).toBe("p2");
		expect(Object.keys(state.files).sort()).toEqual([
			"src/left.ts",
			"src/mine.ts",
		]);
		expect(state.sessions?.p2).toBeUndefined();
	});

	it("takes an empty ownerless worklist, so a no-turn secondary's leave cannot strand the primary's next write", () => {
		// RECURRENCE GUARDED: the same shape as #4751 from another writer. A
		// secondary that leaves before any turn (no reserved partition) clears
		// an ownerless envelope as its own and stamps its id; the primary's
		// next write then read as a secondary's.
		const cache = new CacheManager(false);
		expect(cache.claimPrimaryTurnState(env.tmpDir, "p")).toEqual({
			from: undefined,
			arm: "empty",
			filesKept: 0,
		});
		cache.clearTurnState(env.tmpDir, { kind: "pi", id: "s" }, "s");
		cache.addModifiedRange(source("mine.ts"), RANGE, false, env.tmpDir, "p");

		const state = cache.readTurnState(env.tmpDir);
		expect(state.owner?.id).toBe("p");
		expect(Object.keys(state.files)).toEqual(["src/mine.ts"]);
	});

	it("evicts an in-process predecessor's worklist older than the stale bound, and the successor's next write joins its own envelope", () => {
		// RECURRENCE GUARDED: #2504's shape through the claim (review r1 F1 on
		// #4753). Claiming a same-pid owner of any age replayed a worklist
		// master evicts as stale, so its paths read as "modified this turn".
		// Skipping the claim instead strands the successor's write, #4751 again.
		const lastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		writeTurnStateFile(env.tmpDir, {
			files: {
				"src/old.ts": {
					modifiedRanges: [RANGE],
					importsChanged: false,
					lastEdit: lastSeen,
				},
			},
			turnCycles: 2,
			maxCycles: 3,
			lastUpdated: lastSeen,
			sessionId: "p1",
			owner: { kind: "pi", id: "p1", pid: process.pid, lastSeen },
		});
		const cache = new CacheManager(false);

		expect(cache.claimPrimaryTurnState(env.tmpDir, "p2")).toEqual({
			from: "p1",
			arm: "evicted",
			filesKept: 0,
			filesDropped: 1,
		});
		cache.addModifiedRange(source("mine.ts"), RANGE, false, env.tmpDir, "p2");

		const state = cache.readTurnState(env.tmpDir);
		expect(state.owner?.id).toBe("p2");
		expect(Object.keys(state.files)).toEqual(["src/mine.ts"]);
		expect(state.turnCycles).toBe(0);
		expect(state.sessions?.p2).toBeUndefined();
	});

	it("claims an idle in-process predecessor's empty worklist past the stale bound, so a /new after a long pause keeps its first write", () => {
		// RECURRENCE GUARDED: #4751 after a pause. The predecessor's turn end
		// left an empty envelope stamped with its id; an age check that skipped
		// the claim filed the successor's first write under a partition.
		const lastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		writeTurnStateFile(env.tmpDir, {
			files: {},
			turnCycles: 0,
			maxCycles: 3,
			lastUpdated: lastSeen,
			sessionId: "p1",
			owner: { kind: "pi", id: "p1", pid: process.pid, lastSeen },
		});
		const cache = new CacheManager(false);

		expect(cache.claimPrimaryTurnState(env.tmpDir, "p2")).toEqual({
			from: "p1",
			arm: "evicted",
			filesKept: 0,
			filesDropped: 0,
		});
		cache.addModifiedRange(source("mine.ts"), RANGE, false, env.tmpDir, "p2");

		const state = cache.readTurnState(env.tmpDir);
		expect(state.owner?.id).toBe("p2");
		expect(Object.keys(state.files)).toEqual(["src/mine.ts"]);
		expect(state.sessions?.p2).toBeUndefined();
	});

	it("refuses a worklist that a live session of another process holds", () => {
		// RECURRENCE GUARDED: I2. Claiming by owner id alone would take another
		// process's live worklist and its files.
		const other = {
			files: {
				"src/theirs.ts": {
					modifiedRanges: [RANGE],
					importsChanged: false,
					lastEdit: new Date().toISOString(),
				},
			},
			turnCycles: 0,
			maxCycles: 3,
			lastUpdated: new Date().toISOString(),
			sessionId: "other-process-session",
			owner: {
				kind: "pi",
				id: "other-process-session",
				// The parent process is alive for the whole run.
				pid: process.ppid,
				lastSeen: new Date().toISOString(),
			},
		};
		writeTurnStateFile(env.tmpDir, other);
		const cache = new CacheManager(false);

		expect(cache.claimPrimaryTurnState(env.tmpDir, "p")).toBeUndefined();
		const state = cache.readTurnState(env.tmpDir);
		expect(state.owner?.id).toBe("other-process-session");
		expect(Object.keys(state.files)).toEqual(["src/theirs.ts"]);
	});

	it("refuses an ownerless worklist that holds files, leaving it to the #2504 eviction", () => {
		// RECURRENCE GUARDED: #2504. A stamp would make a leftover worklist
		// the primary's own, so its turn end would replay historical paths.
		const lastEdit = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		writeTurnStateFile(env.tmpDir, {
			files: {
				"src/old.ts": {
					modifiedRanges: [RANGE],
					importsChanged: false,
					lastEdit,
				},
			},
			turnCycles: 0,
			maxCycles: 3,
			lastUpdated: lastEdit,
		});
		const cache = new CacheManager(false);

		expect(cache.claimPrimaryTurnState(env.tmpDir, "p")).toBeUndefined();
		expect(cache.readTurnState(env.tmpDir).owner).toBeUndefined();
		expect(
			cache.getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "p",
				sessionStartedAt: Date.now(),
			}),
		).toBe("available");
	});
});
