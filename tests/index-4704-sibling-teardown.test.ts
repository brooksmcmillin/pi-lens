/**
 * #4704 witness: the shared session teardown belongs to the LAST live session
 * in the PROCESS, not to the last live session of one extension activation.
 *
 * pi 1.3.0 runs the pi-lens factory once per session load
 * (`dist/core/extensions/loader.js` caches the factory, `initializeExtension`
 * calls it per load), so an in-process subagent is its own activation
 * (`docs/subagent-compat.md` contracts 2a and 3). Each `startPiSession` below
 * is that shape: a real `AgentSession` and its own activation. On the pre-fix
 * tree the primary's leave found its own activation empty and ran the shared
 * teardown: it removed the pid's whole registry entry (the live sibling's
 * root with it), released the primary registration and reset the LSP service
 * under the sibling, which kept running turns on nothing.
 *
 * The fix splits two facts with two owners. The primary REGISTRATION is per
 * primary: the primary's own leave releases it, whatever else is live, so a
 * successor in another root (`/resume`) is admitted, not declined behind a
 * dead registration (review F1 on #4708). The shared INFRA (the pid's
 * registry entry, the LSP fleet) is per process: only the last live leave in
 * the process tears it down, and a full start keeps the fleet while another
 * session in the process still drives it.
 *
 * Every observable is pi-lens's own process-wide state, read from this side
 * of the jiti copy because each lives in a process singleton or on disk: the
 * pid's `instances.json` roots, the primary registration
 * (`getActiveSessionId`), the owned LSP service object
 * (`peekOwnedLspService`), and the `session_teardown_last_member` row the
 * teardown leaves when it runs for a session classified secondary.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_settleRegistryMutationsForTests,
	getInstanceRoots,
	readInstanceRegistry,
} from "../clients/instance-registry.js";
import { peekOwnedLspService } from "../clients/lsp/service-singleton.js";
import { normalizeFilePath } from "../clients/path-utils.js";
import {
	_trackedLiveSessionListCountForTests,
	getActivePrimaryRoot,
	getActiveSessionId,
} from "../clients/session-lifecycle.js";
import { type SessionScope, scopeOfSession } from "../clients/session-scope.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

// This side's registry read resolves `PI_LENS_HOME` per call. Pin it to the
// home the copy writes (`startPiSession` pins the same path), so no read here
// reaches the worker's home, even one made before a case's first start.
let previousHome: string | undefined;
beforeEach(() => {
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(fixture.root, "home");
});
afterEach(() => {
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
});

/** The record the shared teardown leaves when it runs for a secondary. */
const LAST_MEMBER_PHASE = "session_teardown_last_member";

/** The roots this pid's registry entry holds, after the queued writes land. */
async function rootsForThisPid(): Promise<string[]> {
	await _settleRegistryMutationsForTests();
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

/** A primary and a live sibling, each its own activation, in two roots. */
async function primaryAndSibling(caseName: string): Promise<{
	primary: PiSession;
	sibling: PiSession;
	primaryRoot: string;
	siblingRoot: string;
}> {
	const primary = await startPiSession({
		root: fixture.root,
		cwd: path.join(fixture.root, caseName, "primary"),
		responses: [fauxAssistantMessage(fauxText("primary ok"))],
	});
	const sibling = await startPiSession({
		root: fixture.root,
		cwd: path.join(fixture.root, caseName, "sibling"),
		responses: [fauxAssistantMessage(fauxText("sibling ok"))],
	});
	// The registry stores roots through `normalizeFilePath`, so compare in
	// that form (a native path differs from it on Windows).
	return {
		primary,
		sibling,
		primaryRoot: normalizeFilePath(primary.cwd),
		siblingRoot: normalizeFilePath(sibling.cwd),
	};
}

/** One latency row as the copy writes it; only the fields read here. */
interface LatencyRow {
	phase?: string;
	metadata?: { sessionId?: string; kind?: string };
}

/**
 * The rows the copy wrote AFTER a mark. The file shares one home, so
 * `latency.log` also holds earlier cases' rows, in whatever order the run
 * shuffled them (review F2 on #4708: an unscoped read failed seeds 1 and 3).
 */
interface RowMark {
	rowsSince(): Promise<LatencyRow[]>;
}
async function markRows(session: PiSession): Promise<RowMark> {
	const before = (await session.latencyRows()).rows.length;
	return {
		async rowsSince() {
			const { rows } = await session.latencyRows();
			return (rows as LatencyRow[]).slice(before);
		},
	};
}

/** The teardown-for-a-secondary rows the copy wrote for these sessions. */
async function lastMemberRows(
	mark: RowMark,
	...sessions: PiSession[]
): Promise<unknown[]> {
	const ids = new Set(
		sessions.map((handle) => handle.session.sessionManager.getSessionId()),
	);
	return (await mark.rowsSince())
		.filter((row) => row.phase === LAST_MEMBER_PHASE)
		.map((row) => row.metadata)
		.filter((metadata) => ids.has(metadata?.sessionId ?? ""));
}

/** The ledger rows that name a live session dropped with no shutdown. */
async function disposedMemberRows(mark: RowMark): Promise<unknown[]> {
	return (await mark.rowsSince())
		.filter((row) => row.phase === "degradation_ledger")
		.map((row) => row.metadata)
		.filter((metadata) => metadata?.kind === "session-member-disposed");
}

/** The turns pi-lens skipped for `session` as a concurrent secondary. */
async function secondarySkipRows(
	mark: RowMark,
	session: PiSession,
): Promise<unknown[]> {
	const id = session.session.sessionManager.getSessionId();
	return (await mark.rowsSince()).filter(
		(row) =>
			row.phase === "agent_end_concurrent_secondary_skip" &&
			row.metadata?.sessionId === id,
	);
}

describe("#4704 a primary and a sibling on separate activations", () => {
	it("releases the primary registration but keeps the sibling's root and the LSP service when the primary leaves first", async () => {
		const { primary, sibling, primaryRoot, siblingRoot } =
			await primaryAndSibling("primary-first");
		const primaryId = primary.session.sessionManager.getSessionId();
		expect(getActiveSessionId()).toBe(primaryId);
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([primaryRoot, siblingRoot]),
		);
		const service = peekOwnedLspService();
		expect(service).toBeDefined();

		await primary.dispose();

		// The sibling is live, so the shared infra stays: its root and the LSP
		// service object it drives (a reset would have replaced it with
		// nothing). The registration was the departed primary's own, so it
		// goes with it (review F1 on #4708: a held one declined a successor).
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([primaryRoot, siblingRoot]),
		);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBe(service);

		await sibling.prompt("still here");
		expect(sibling.errors).toEqual([]);
		expect(sibling.requests).toHaveLength(1);
		expect(peekOwnedLspService()).toBe(service);
	}, 60_000);

	it("releases the entry, the registration and the LSP service once the sibling leaves last", async () => {
		const { primary, sibling } = await primaryAndSibling("sibling-last");
		const mark = await markRows(primary);
		const siblingId = sibling.session.sessionManager.getSessionId();
		await primary.dispose();
		expect(await lastMemberRows(mark, sibling)).toEqual([]);

		await sibling.dispose();

		// The last live session's leave runs the one shared teardown, on behalf
		// of a session classified secondary: no leak once both are gone.
		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// Neither activation's member list outlives its last member.
		expect(_trackedLiveSessionListCountForTests()).toBe(0);
		expect(await lastMemberRows(mark, sibling)).toEqual([
			expect.objectContaining({
				sessionId: siblingId,
				classification: "secondary",
			}),
		]);
	}, 60_000);

	it("releases only the sibling's own root when the sibling leaves first", async () => {
		const { primary, sibling, primaryRoot, siblingRoot } =
			await primaryAndSibling("sibling-first");
		const mark = await markRows(primary);
		const primaryId = primary.session.sessionManager.getSessionId();
		const service = peekOwnedLspService();

		await sibling.dispose();

		const afterSibling = await rootsForThisPid();
		expect(afterSibling).toContain(primaryRoot);
		expect(afterSibling).not.toContain(siblingRoot);
		expect(getActiveSessionId()).toBe(primaryId);
		expect(peekOwnedLspService()).toBe(service);

		await primary.dispose();

		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// The primary ran its own teardown: no row for a secondary's.
		expect(await lastMemberRows(mark, primary, sibling)).toEqual([]);
		// Both left through a shutdown, so neither counts as disposed.
		expect(await disposedMemberRows(mark)).toEqual([]);
	}, 60_000);

	it("counts each sibling pi disposed without a shutdown, and none of them as live", async () => {
		// pi's `AgentSession.dispose()` invalidates the session's extension
		// contexts and emits no `session_shutdown`; a subagent runner that
		// disposes its session that way never reaches pi-lens's leave. Such a
		// sibling must not hold the shared infra past its primary.
		const { primary, sibling } = await primaryAndSibling("disposed-sibling");
		const second = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "disposed-sibling", "second"),
			responses: [fauxAssistantMessage(fauxText("second ok"))],
		});
		const mark = await markRows(primary);
		sibling.session.dispose();
		second.session.dispose();

		await primary.dispose();

		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// The disposed siblings' lists (and the contexts they pin) are dropped,
		// not kept for the life of the process. Each drop is counted: the
		// durable rows are the ledger's power-of-two milestones of the exact
		// tally (review F4 on #4708: five drops recorded one row, count 1).
		expect(_trackedLiveSessionListCountForTests()).toBe(0);
		expect(await disposedMemberRows(mark)).toEqual([
			expect.objectContaining({ subject: "no-shutdown", count: 1 }),
			expect.objectContaining({ subject: "no-shutdown", count: 2 }),
		]);
	}, 60_000);

	it("ends the scope of each subagent pi disposed without a shutdown at the next session start", async () => {
		// #4965 verify V1: the session-id lookup is a process-wide index, and
		// pi's `AgentSession.dispose()` runs no `session_shutdown`, so nothing
		// gave a disposed subagent's key back: every one kept its scope and its
		// cells (the turn's `memory-turn-end` among them) for the life of the
		// process, where #2442 had capped them at 32 sessions.
		const primary = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "disposed-scope", "primary"),
			responses: [fauxAssistantMessage(fauxText("primary ok"))],
		});
		const primaryId = primary.session.sessionManager.getSessionId();
		const subagents: Array<{ id: string; scope: SessionScope | undefined }> =
			[];
		for (const name of ["sub-1", "sub-2", "sub-3"]) {
			const sub = await startPiSession({
				root: fixture.root,
				cwd: path.join(fixture.root, "disposed-scope", name),
				responses: [fauxAssistantMessage(fauxText(`${name} ok`))],
			});
			await sub.prompt("work");
			const id = sub.session.sessionManager.getSessionId();
			subagents.push({ id, scope: scopeOfSession(id) });
			sub.session.dispose();
		}

		const next = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "disposed-scope", "next"),
			responses: [fauxAssistantMessage(fauxText("next ok"))],
		});

		expect(
			subagents.map(({ id, scope }) => ({
				bound: scopeOfSession(id) !== undefined,
				retiredBy: scope?.retiredBy(),
			})),
		).toEqual(subagents.map(() => ({ bound: false, retiredBy: "disposed" })));
		expect(scopeOfSession(primaryId)?.isLive()).toBe(true);
		await next.dispose();
		await primary.dispose();
		expect(scopeOfSession(primaryId)).toBeUndefined();
	}, 90_000);

	it("admits a /resume into another root as primary while the sibling is live", async () => {
		// Review F1 on #4708: a primary that left while a sibling lived kept
		// its registration, so root identity (#2129) declined the user's own
		// resumed session as `secondary-root` for its whole life, and every
		// turn's end-of-turn work was skipped.
		const earlier = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "resume-other-root", "resumed"),
			responses: [fauxAssistantMessage(fauxText("earlier ok"))],
		});
		await earlier.prompt("hello");
		const resumedFile = earlier.sessionFile();
		expect(resumedFile).toBeDefined();
		const resumedRoot = normalizeFilePath(earlier.cwd);
		await earlier.dispose();
		const { primary, sibling, siblingRoot } =
			await primaryAndSibling("resume-other-root");
		const service = peekOwnedLspService();
		expect(service).toBeDefined();
		const mark = await markRows(primary);

		const resumed = await primary.restart(
			{ reason: "resume", sessionFile: resumedFile! },
			[fauxAssistantMessage(fauxText("resumed ok"))],
		);

		expect(normalizeFilePath(resumed.cwd)).toBe(resumedRoot);
		expect(getActiveSessionId()).toBe(
			resumed.session.sessionManager.getSessionId(),
		);
		expect(getActivePrimaryRoot()).toBe(resumedRoot);
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([resumedRoot, siblingRoot]),
		);
		// The resumed session's full start keeps the fleet the sibling drives.
		expect(peekOwnedLspService()).toBe(service);
		await resumed.prompt("after resume");
		expect(resumed.errors).toEqual([]);
		expect(await secondarySkipRows(mark, resumed)).toEqual([]);

		await sibling.dispose();
		expect(getActiveSessionId()).toBe(
			resumed.session.sessionManager.getSessionId(),
		);
		await resumed.dispose();
		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
	}, 60_000);

	it("admits a start in another root once the primary left and pi disposed the sibling", async () => {
		const { primary, sibling, siblingRoot } = await primaryAndSibling(
			"after-disposed-sibling",
		);
		await primary.dispose();
		sibling.session.dispose();

		const next = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "after-disposed-sibling", "next"),
			responses: [fauxAssistantMessage(fauxText("next ok"))],
		});

		expect(getActiveSessionId()).toBe(
			next.session.sessionManager.getSessionId(),
		);
		expect(getActivePrimaryRoot()).toBe(normalizeFilePath(next.cwd));
		await next.dispose();
		// The disposed sibling never left, so the last live leave took its
		// root with the rest of the pid's entry.
		expect(await rootsForThisPid()).not.toContain(siblingRoot);
		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
	}, 60_000);

	it("releases a registration whose holder pi disposed without a shutdown at the sibling's last leave", async () => {
		const { primary, sibling } = await primaryAndSibling("disposed-holder");
		const primaryId = primary.session.sessionManager.getSessionId();
		primary.session.dispose();
		expect(getActiveSessionId()).toBe(primaryId);

		await sibling.dispose();

		// The holder can no longer leave, so the last live leave releases what
		// it held: a later start must not probe a registration nobody owns.
		expect(getActiveSessionId()).toBeUndefined();
		expect(await rootsForThisPid()).toEqual([]);
		expect(peekOwnedLspService()).toBeUndefined();
	}, 60_000);
});
