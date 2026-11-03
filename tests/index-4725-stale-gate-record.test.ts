/**
 * #4725: a `turn-end-findings` record that an earlier session left behind, or
 * that is older than the cache's freshness window, must not refuse every
 * `--lens-guard` commit for good.
 *
 * The defect: the gate answers a record it cannot judge as `unknown`, and
 * `unknown` blocks. Every writer that could have retired the record read it
 * through `readCache`, which hides a record past its freshness window
 * (`clients/cache-manager.ts`), so a clean write latched `cache_stale`
 * (`syncGitGuardRecord`) and the turn end's clean-up never saw the record
 * (`clients/runtime-turn.ts`). The refusal then told the model to "start a
 * fresh session", and a fresh session reads the same record.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary, and each next session made by pi's own
 * `newSession` (`PiSession.restart`). The record is seeded on disk the way an
 * earlier pi-lens session leaves it, after the first session started and
 * before its first prompt: `session_start` never reads it (only the gate, the
 * turn end and the write path do), so the order is the one a new session
 * meets. Its meta timestamp is set a day back, the age the #4712 verify r5
 * probe used.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	RAN_MARKER,
	type Received,
	commitAttempt,
	endTurn,
	openGuardedSession,
	readTarget,
	seed,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiSession,
	piSessionFixture,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const DAY_MS = 86_400_000;
/**
 * Each cell opens up to two real pi sessions, and a cold first run took 5.1 s
 * against Vitest's 5 s default (#4733 r1 F8); the other two-session tier-2
 * files (`tests/index-4632-s5-session-identity.test.ts`) budget 60 s a cell.
 */
const TWO_SESSION_TIMEOUT_MS = 60_000;
/** The id an earlier pi session wrote the record under: never this one's. */
const EARLIER_SESSION = "an-earlier-pi-session";

function recordFile(proj: string): string {
	return path.join(getProjectDataDir(proj), "cache", "turn-end-findings.json");
}

/** Write `data` as the record and move its timestamp back by `ageMs`. */
function seedRecord(proj: string, data: unknown, ageMs = DAY_MS): void {
	new CacheManager(false).writeCache("turn-end-findings", data, proj);
	const metaPath = path.join(
		getProjectDataDir(proj),
		"cache",
		"turn-end-findings.meta.json",
	);
	fs.writeFileSync(
		metaPath,
		JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString() }),
	);
}

/**
 * A record that carries a blocker in `target`, as `syncGitGuardRecord` writes
 * one (`<path>: <summary>` with the rendered body indented under it), under
 * an earlier session's id. The bytes it describes are on disk, so the blocker
 * is live.
 */
function liveBlockerRecord(target: string): Record<string, unknown> {
	return {
		content: `${target}: 🔴 STOP — 1 issue(s) must be fixed:\n  L3: Debugger statement`,
		blockerContent: `${target}: 🔴 STOP — 1 issue(s) must be fixed:\n  L3: Debugger statement`,
		blockingFiles: [target],
		hasBlockers: true,
		affectedFiles: [target],
		sessionId: EARLIER_SESSION,
		projectSeqStart: 0,
		projectSeqEnd: 1,
		fileSeqByPath: {},
		fileContentHashes: {},
		consumed: true,
	};
}

function commitThenEnd(): PiFauxReply[] {
	return [step(commitAttempt(), "committing"), endTurn("done")];
}

function lastBash(requests: readonly (readonly unknown[])[]): Received {
	const results = toolResults(
		(requests.at(-1) ?? []) as Parameters<typeof toolResults>[0],
		"bash",
	);
	return results.at(-1) ?? { text: "(no bash result)", isError: false };
}

/**
 * The `record_retired` rows the loaded copy wrote for `proj`, as
 * `{ by, basis }` (one row per retired record, `clients/git-guard.ts`).
 */
async function retiredRows(
	handle: PiSession,
	proj: string,
): Promise<Array<{ by: unknown; basis: unknown }>> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return read.rows.flatMap((row) => {
		const typed = row as {
			phase?: string;
			filePath?: string;
			metadata?: { by?: unknown; basis?: unknown };
		};
		return typed.phase === "record_retired" && typed.filePath === proj
			? [{ by: typed.metadata?.by, basis: typed.metadata?.basis }]
			: [];
	});
}

function expectRan(verdict: Received): void {
	expect(verdict.text).not.toContain(GATE_BLOCK);
	expect(verdict.text).toContain(RAN_MARKER);
}

describe("#4725: a record an earlier session left does not refuse every later commit", () => {
	it(
		"retires a day-old record that claims no blocker at the first session's clean turn, and the next session commits",
		async () => {
			// RECURRENCE GUARDED: #4725 (the #4712 verify r5 probe): the record
			// outlived both sessions and both commits answered `cache_stale`.
			const { proj } = seed(fixture.root, "no-blocker", CLEAN_FILE);
			const first = await openGuardedSession(fixture.root, proj, [
				step(writeTarget(path.join(proj, "src", "clean.ts"), CLEAN_FILE)),
				endTurn("turn 1 done"),
			]);
			// The record the probe seeded: an explicit no-blocker claim, a day old.
			seedRecord(proj, { content: "old", hasBlockers: false });
			await first.prompt("write a clean file");
			expect(fs.existsSync(recordFile(proj))).toBe(false);
			// The clean write retired it, and said so once.
			expect(await retiredRows(first, proj)).toEqual([
				{ by: "write", basis: "no_blocker" },
			]);

			const second = await first.restart({ reason: "new" }, commitThenEnd());
			await second.prompt("commit it");
			expectRan(lastBash(second.requests));
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"lets the first commit of a session through when the only record is a day-old no-blocker claim",
		async () => {
			// RECURRENCE GUARDED: #4725: the gate answered `cache_stale` for a record
			// that says it carries nothing, before any write or turn end could retire it.
			const { proj } = seed(fixture.root, "commit-first", CLEAN_FILE);
			const handle = await openGuardedSession(
				fixture.root,
				proj,
				commitThenEnd(),
			);
			seedRecord(proj, { content: "old", hasBlockers: false });
			await handle.prompt("commit it");
			expectRan(lastBash(handle.requests));
			// The turn wrote no file, so its own end retired the record.
			expect(fs.existsSync(recordFile(proj))).toBe(false);
			expect(await retiredRows(handle, proj)).toEqual([
				{ by: "turn_end", basis: "no_blocker" },
			]);
			expect(handle.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"still refuses a day-old record whose blocker is live, after a clean turn elsewhere, and names the file to fix",
		async () => {
			// The control (#4725 brief): the fix must not become "an old record
			// stops counting". The blocker's bytes are still on disk and nothing in
			// either session re-checked them.
			const { proj, target } = seed(
				fixture.root,
				"live-blocker",
				BLOCKING_FILE,
			);
			const first = await openGuardedSession(fixture.root, proj, [
				step(writeTarget(path.join(proj, "src", "other.ts"), CLEAN_FILE)),
				endTurn("turn 1 done"),
			]);
			seedRecord(proj, liveBlockerRecord(target));
			await first.prompt("write another file");
			expect(fs.existsSync(recordFile(proj))).toBe(true);

			const second = await first.restart({ reason: "new" }, commitThenEnd());
			await second.prompt("commit it");
			const verdict = lastBash(second.requests);
			expect(verdict.text).toContain(GATE_BLOCK);
			expect(verdict.text).not.toContain(RAN_MARKER);
			expect(verdict.isError).toBe(true);
			// The refusal names the file and an action that clears it (the next
			// case performs that action), never "start a fresh session".
			expect(verdict.text).toContain(path.join("src", "target.ts"));
			expect(verdict.text).toContain("write each file again");
			expect(verdict.text).not.toContain("fresh session");
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"clears a day-old live-blocker record once the session fixes the file it names, and the next session commits",
		async () => {
			// RECURRENCE GUARDED: #4725: the action the refusal names must clear the
			// record. On master a clean write of the named file latched
			// `session_mismatch`/`cache_stale`, and the record refused every commit
			// in every later session.
			const { proj, target } = seed(fixture.root, "fix-it", BLOCKING_FILE);
			const first = await openGuardedSession(fixture.root, proj, [
				step(readTarget(target), "reading"),
				step(writeTarget(target, CLEAN_FILE), "fixing"),
				endTurn("turn 1 done"),
			]);
			seedRecord(proj, liveBlockerRecord(target));
			await first.prompt("fix the blocker");
			expect(fs.existsSync(recordFile(proj))).toBe(false);
			expect(await retiredRows(first, proj)).toEqual([
				{ by: "write", basis: "rechecked" },
			]);

			const second = await first.restart({ reason: "new" }, commitThenEnd());
			await second.prompt("commit it");
			expectRan(lastBash(second.requests));
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"clears a day-old record the --lens-guard-off writer left at the first clean turn end, and the next turn commits",
		async () => {
			// RECURRENCE GUARDED: #4733 r1 F3. The `--lens-guard`-off writer's
			// record makes no claim; past the delivery window nothing consumed it,
			// a clean write latched `cache_stale`, the turn end kept it, and every
			// guarded commit in every session was refused.
			const { proj } = seed(fixture.root, "guard-off", CLEAN_FILE);
			const handle = await openGuardedSession(fixture.root, proj, [
				step(writeTarget(path.join(proj, "src", "clean.ts"), CLEAN_FILE)),
				endTurn("turn 1 done"),
				...commitThenEnd(),
			]);
			seedRecord(
				proj,
				JSON.parse(
					fs.readFileSync(
						path.join(
							import.meta.dirname,
							"fixtures/git-guard-records/4.4.4-guard-off-turn-end-findings.json",
						),
						"utf-8",
					),
				),
			);
			await handle.prompt("write a clean file");
			expect(fs.existsSync(recordFile(proj))).toBe(false);
			expect(await retiredRows(handle, proj)).toEqual([
				{ by: "turn_end", basis: "no_claim" },
			]);

			await handle.prompt("commit it");
			expectRan(lastBash(handle.requests));
			expect(handle.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);
});
