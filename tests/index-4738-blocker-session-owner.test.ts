/**
 * #4738: the `turn-end-findings` record holds every session's blocker
 * sections, each with its owner, and a session's own new evidence replaces
 * only its own sections.
 *
 * The defect: the record was one slot with one owner. A second session's
 * blocker write (`syncGitGuardRecord`'s entries branch at `tool_result`, then
 * the turn-end composer) replaced the first session's blocker sections with
 * its own, without re-checking the files they name. Once the second session
 * fixed its own blocker, its record emptied and `git commit` under
 * `--lens-guard` ran with the first session's blocker never re-checked.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary, and the second session made by pi's own
 * `newSession` (`PiSession.restart({ reason: "new" })`, a new session id).
 * The first session's blocker is raised by the first session's own write of
 * a file whose bundled rule blocks; no record is seeded.
 *
 * The writers this drives, each red when its carry is cut (PR mutation
 * table): the second session's blocking write (`syncGitGuardRecord`, entries
 * branch), its fix (the same function, no entries), and its fix turn's
 * turn-end composer write. The composer's repeated-findings rewrite and its
 * read of a day-old record are not reached here: no turn of the second
 * session repeats its findings or meets a day-old record. (Before #4751 none
 * of its turns composed anything: its writes went to a partition its turn end
 * never read.) They are pinned with the real `handleTurnEnd` in
 * `tests/clients/turn-end-cap-consumed-state.test.ts`.
 *
 * Lane: ubuntu Unit tests.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	RAN_MARKER,
	type Received,
	commitAttempt,
	endTurn,
	openGuardedSession,
	raise,
	seed,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { type PiSession, piSessionFixture } from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

function lastBash(handle: PiSession): Received {
	const results = toolResults(
		(handle.requests.at(-1) ?? []) as Parameters<typeof toolResults>[0],
		"bash",
	);
	return results.at(-1) ?? { text: "(no bash result)", isError: false };
}

/**
 * Session A raises a blocker in `src/target.ts` and ends its turn; session B
 * (pi's `newSession`) raises its own blocker in `src/other.ts`, fixes it, and
 * commits.
 */
async function secondSessionFixesOnlyItsOwn(
	name: string,
): Promise<{ verdict: Received; second: PiSession }> {
	const { proj, target } = seed(fixture.root, name, BLOCKING_FILE);
	const other = path.join(proj, "src", "other.ts");
	const first = await openGuardedSession(fixture.root, proj, raise(target));
	await first.prompt("raise the blocker");

	const second = await first.restart({ reason: "new" }, [
		step(writeTarget(other, BLOCKING_FILE), "raising mine"),
		endTurn("raised"),
		step(writeTarget(other, CLEAN_FILE), "fixing mine"),
		endTurn("fixed"),
		step(commitAttempt(), "committing"),
		endTurn("done"),
	]);
	await second.prompt("raise my own blocker");
	await second.prompt("fix my own blocker");
	await second.prompt("commit it");
	return { verdict: lastBash(second), second };
}

describe("#4738: a second session's blocker write keeps the first session's blocker", () => {
	it(
		"refuses the commit on the first session's blocker after the second session fixes only its own",
		async () => {
			// RECURRENCE GUARDED: #4738 (PR #4733's p2 residual). The second
			// session's own blocker write replaced the first session's section, so
			// fixing its own blocker emptied the record and the commit ran.
			const { verdict, second } = await secondSessionFixesOnlyItsOwn("fresh");
			expect(verdict.text).toContain(GATE_BLOCK);
			expect(verdict.text).not.toContain(RAN_MARKER);
			expect(verdict.isError).toBe(true);
			// The refusal names the first session's file, the one nothing re-checked.
			expect(verdict.text).toContain(path.join("src", "target.ts"));
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);
});
