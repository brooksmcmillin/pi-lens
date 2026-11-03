/**
 * #4943 R1: a bridged write is drained by the session that made it.
 *
 * The defect: the mutation bridge queued every deferred autofix/format record
 * under the coordinator's id (`clients/mutation-bridge.ts`, the deferral), and
 * a concurrent secondary skipped the `agent_settled` drain outright (#791). An
 * in-process subagent's bridged write (a tool pi-lens has never met, replayed
 * through the observed net) was therefore owned by the PRIMARY and formatted by
 * the primary's next settle, as the primary's work; the subagent's own settle
 * drained nothing. Maintainer decision on #4943 (option b): the record names
 * its real owner, and each secondary drains its own records.
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary, and a tool registered through pi's own
 * `customTools` option. The second session starts while the first is live, so
 * `session_start` classifies it a concurrent secondary (#4704).
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	CLEAN_FILE,
	endTurn,
	readTarget,
	step,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

function project(name: string): string {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
	return proj;
}

/**
 * A tool another extension might register: it names the file it rewrites in a
 * `path` field, so pi-lens cannot classify it but arms the observed net on that
 * path, and the settle replays the write through the mutation bridge.
 */
function noteTool(): ToolDefinition {
	return {
		name: "stamp_note",
		label: "Stamp note",
		description: "Stamp a note into a file.",
		parameters: Type.Object({ path: Type.String(), note: Type.String() }),
		async execute(_toolCallId, params) {
			const { path: target, note } = params as { path: string; note: string };
			fs.writeFileSync(target, note);
			return {
				content: [{ type: "text", text: `stamped ${target}` }],
				details: undefined,
			};
		},
	};
}

interface DrainRecord {
	filePath?: string;
	ownerSessionId?: string;
}

interface LatencyRow {
	phase?: string;
	metadata?: {
		currentSessionId?: string;
		sessionId?: string;
		records?: DrainRecord[];
	};
}

/** Each drain that claimed `file`: the session it ran in and the owner it read. */
async function drainsOf(
	handle: PiSession,
	file: string,
): Promise<
	Array<{ drainedBy: string | undefined; owner: string | undefined }>
> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	const key = fs.realpathSync.native(file);
	return (read.rows as LatencyRow[])
		.filter((row) => row.phase === "agent_end_deferred_format_start")
		.flatMap((row) =>
			(row.metadata?.records ?? [])
				.filter((record) => record.filePath === key)
				.map((record) => ({
					drainedBy: row.metadata?.currentSessionId,
					owner: record.ownerSessionId,
				})),
		);
}

/**
 * The settles pi-lens ran as a concurrent secondary's, by session id, among
 * this case's own sessions (the file's cases share one latency log).
 */
async function secondarySettles(
	handle: PiSession,
	sessions: readonly PiSession[],
): Promise<string[]> {
	const ids = new Set(
		sessions.map((session) => session.session.sessionManager.getSessionId()),
	);
	const read = await handle.latencyRows();
	return (read.rows as LatencyRow[])
		.filter((row) => row.phase === "agent_end_concurrent_secondary_skip")
		.flatMap((row) =>
			row.metadata?.sessionId !== undefined && ids.has(row.metadata.sessionId)
				? [row.metadata.sessionId]
				: [],
		);
}

describe("#4943 R1: a bridged write is drained by the session that made it", () => {
	it(
		"queues a subagent's bridged and native writes under the subagent and drains them in the subagent's own settle, never the primary's",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4943 R1 (the #4973 probe). The subagent's
			// bridged `note.ts` was queued under the primary's id, the subagent's
			// settle skipped the drain, and the primary's next settle formatted it
			// as its own (`agent_end_deferred_format_start` named the primary as
			// both drainer and owner). Its native `native.ts` was queued under the
			// subagent, so no live session drained it: only the primary's
			// 10-minute stale claim would.
			const proj = project("subagent");
			const target = path.join(proj, "src", "note.ts");
			const native = path.join(proj, "src", "native.ts");
			fs.writeFileSync(target, "export const note = 0;\n");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [endTurn("primary idle"), endTurn("primary again")],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				customTools: [noteTool()],
				// Autoformat on, so the native write queues a deferred format.
				flags: new Map([["no-autoformat", false]]),
				responses: [
					step(
						fauxToolCall("stamp_note", {
							path: target,
							note: "export const note = 1;\n",
						}),
					),
					step(
						fauxToolCall("write", {
							path: native,
							content: "export const native = 1;\n",
						}),
					),
					endTurn("secondary idle"),
				],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const secondaryId = secondary.session.sessionManager.getSessionId();
			expect(secondaryId).not.toBe(primaryId);

			await primary.prompt("idle");
			await secondary.prompt("stamp the note");
			// The primary settles AFTER the subagent's write: before the fix this
			// settle claimed the subagent's record as its own.
			await primary.prompt("again");

			// The tool really wrote through pi's loop.
			expect(fs.readFileSync(target, "utf8")).toBe("export const note = 1;\n");
			// The secondary's settle ran as a secondary's (the classification the
			// drain branches on), and no other session's settle did.
			expect(await secondarySettles(primary, [primary, secondary])).toEqual([
				secondaryId,
			]);
			// The bridged write's change-log receipt names its writer.
			const changes = readNdjsonRows<{ filePath?: string; sessionId?: string }>(
				path.join(getProjectDataDir(proj), "change-log.jsonl"),
			);
			expect(changes.skipped).toBe(0);
			expect(
				changes.rows
					.filter(
						(row) =>
							row.filePath !== undefined &&
							path.resolve(row.filePath) === path.resolve(target),
					)
					.map((row) => row.sessionId),
			).toEqual([secondaryId]);
			// One drain took each record: the subagent's own, as its owner.
			expect(await drainsOf(primary, target)).toEqual([
				{ drainedBy: secondaryId, owner: secondaryId },
			]);
			expect(await drainsOf(primary, native)).toEqual([
				{ drainedBy: secondaryId, owner: secondaryId },
			]);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"drains what a subagent's settled sweep found in the subagent's own settle",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4943 R1, the settled-sweep producer. The sweep
			// runs right before the settling session's drain so a change no tool
			// call explains is formatted in the same settle; its replay named no
			// session, so a subagent's find was queued under the primary and waited
			// for the primary's next settle.
			const proj = project("sweep");
			const target = path.join(proj, "src", "generated.ts");
			fs.writeFileSync(target, "export const generated = 0;\n");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [endTurn("primary idle"), endTurn("primary again")],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				responses: [
					step(readTarget(target), "reading"),
					// A writer outside every tool call (a watcher, a generator in the
					// background) changes the file the subagent read before its run
					// ends; no tool_call arms an observation for it, so only the
					// settled sweep can see it.
					() => {
						fs.writeFileSync(target, "export const generated = 1;\n");
						return endTurn("secondary idle") as Record<string, unknown>;
					},
				],
			});
			const secondaryId = secondary.session.sessionManager.getSessionId();

			await primary.prompt("idle");
			await secondary.prompt("regenerate");
			await primary.prompt("again");

			expect(fs.readFileSync(target, "utf8")).toBe(
				"export const generated = 1;\n",
			);
			expect(await drainsOf(primary, target)).toEqual([
				{ drainedBy: secondaryId, owner: secondaryId },
			]);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"queues nothing for a second primary in another root, so neither settle drains its writes",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: the two-primaries row of the #4943 R1 state table
			// (pi-web hosts every project's session in one process). The second
			// root's start is declined (`secondary-root`), its files are outside the
			// coordinator's root, so neither its native write nor its bridged write
			// queues a deferred record, and its settle runs the owned-only claim
			// over nothing. A change that lets that root queue records (the #4242
			// peer redesign) turns this red and must revisit the row: whose settle
			// drains them, and whether its turn end delivers.
			const primaryProj = project("two-roots-a");
			const otherProj = project("two-roots-b");
			const bridged = path.join(otherProj, "src", "note.ts");
			const native = path.join(otherProj, "src", "native.ts");
			fs.writeFileSync(bridged, "export const note = 0;\n");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: primaryProj,
				responses: [endTurn("primary idle"), endTurn("primary again")],
			});
			const other = await startPiSession({
				root: fixture.root,
				cwd: otherProj,
				customTools: [noteTool()],
				// Autoformat on: a native write in a session root queues a deferred
				// format, so the cell below would see one if this root were one.
				flags: new Map([["no-autoformat", false]]),
				responses: [
					step(
						fauxToolCall("stamp_note", {
							path: bridged,
							note: "export const note = 1;\n",
						}),
					),
					step(
						fauxToolCall("write", {
							path: native,
							content: "export const native = 1;\n",
						}),
					),
					endTurn("other idle"),
				],
			});
			const otherId = other.session.sessionManager.getSessionId();

			await primary.prompt("idle");
			await other.prompt("stamp and write");
			await primary.prompt("again");

			expect(fs.readFileSync(bridged, "utf8")).toBe("export const note = 1;\n");
			expect(fs.readFileSync(native, "utf8")).toBe(
				"export const native = 1;\n",
			);
			// The second root's settle ran as a secondary's.
			expect(await secondarySettles(primary, [primary, other])).toEqual([
				otherId,
			]);
			expect(await drainsOf(primary, bridged)).toEqual([]);
			expect(await drainsOf(primary, native)).toEqual([]);
			expect(primary.errors).toEqual([]);
			expect(other.errors).toEqual([]);
			await other.dispose();
			await primary.dispose();
		},
	);
});
