/**
 * #4943 R1: the project's one turn-end delivery slot answers to the session
 * that staged it.
 *
 * The defect: a turn end stages its message in the per-project
 * `turn-end-findings` record, and the `context` hook of the NEXT request
 * consumes it (`consumeTurnEndFindings`, `clients/runtime-context.ts`). Two
 * sessions in one pi process (an in-process subagent, #473) share that slot,
 * and the hook took whatever was staged, whoever staged it: the primary's
 * next request received the subagent's blocker, marked it consumed, and the
 * subagent's own next request received nothing.
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary. The second session starts while the
 * first is live, so `session_start` classifies it a concurrent secondary
 * (#4704). A session's LAST turn end (the reply with no tool call) stages its
 * blocker for the session's next request, which only the next prompt makes,
 * so the other session's request runs in between.
 *
 * The sibling slot, `test-runner-findings`, is addressed the same way: the
 * runner's delivery is made eligible for the session whose turn end ran it,
 * and the request hook must read it as that session (#4961 review F1).
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	_resetMcpSessionContext,
	_resetTurnEndChain,
	acknowledgeTurnEnd,
	runTurnEnd,
	runTurnEndForIpc,
} from "../clients/mcp/session.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import {
	_resetTestRunnerDeliveryForTests,
	deliverTestRunnerFindings,
	stageTestRunnerDelivery,
} from "../clients/test-runner-delivery.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GUARDED_FLAGS,
	endTurn,
	step,
	textBlocks,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiSession,
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

/** The heading the turn end gives a blocker its own turn wrote. */
const UNRESOLVED = "Unresolved from this turn";
const MINE = path.join("src", "mine.ts");
const THEIRS = path.join("src", "theirs.ts");

function project(name: string): string {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
	return proj;
}

/** The `user`-role text of the requests from index `from` on. */
function userTextsFrom(handle: PiSession, from: number): string {
	return handle.requests
		.slice(from)
		.flatMap((request) =>
			request
				.filter((message) => message.role === "user")
				.flatMap((message) => textBlocks(message)),
		)
		.join("\n");
}

/**
 * The `degradation_ledger` rows the copy wrote when a request left the slot's
 * message for `subject`, the session it is addressed to (#4961 review F4).
 */
async function addressedElsewhereRows(
	handle: PiSession,
	subject: string,
): Promise<unknown[]> {
	const { rows, skipped } = await handle.latencyRows();
	expect(skipped).toBe(0);
	return (
		rows as Array<{
			phase?: string;
			metadata?: { kind?: string; subject?: string };
		}>
	).filter(
		(row) =>
			row.phase === "degradation_ledger" &&
			row.metadata?.kind === "turn-end-delivery-addressed-elsewhere" &&
			row.metadata?.subject === subject,
	);
}

/** The default flag set: `GUARDED_FLAGS` with the commit gate off. */
const UNGUARDED_FLAGS = GUARDED_FLAGS.filter(([name]) => name !== "lens-guard");

/**
 * The primary and a subagent in `proj`. The subagent writes a blocking
 * `src/theirs.ts`; while its next reply is pending the primary runs a whole
 * prompt that writes a blocking `src/mine.ts`, as two concurrent sessions
 * do. The primary's turn end lands between the subagent's two, so the
 * subagent's last turn end is not a repeat of its first: it stages its
 * blocker for the subagent's NEXT request, which only its next prompt makes.
 */
async function stageSubagentBlocker(
	proj: string,
	flags: ReadonlyArray<[string, boolean]>,
	primaryReplies: readonly PiFauxReply[],
	secondaryReplies: readonly PiFauxReply[],
): Promise<{ primary: PiSession; secondary: PiSession }> {
	const mine = path.join(proj, "src", "mine.ts");
	const theirs = path.join(proj, "src", "theirs.ts");
	const primary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: new Map(flags),
		responses: [
			step(writeTarget(mine, BLOCKING_FILE), "writing"),
			endTurn("primary wrote"),
			...primaryReplies,
		],
	});
	const secondary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: new Map(flags),
		responses: [
			step(writeTarget(theirs, BLOCKING_FILE), "writing"),
			async () => {
				await primary.prompt("write mine");
				return fauxAssistantMessage(fauxText("secondary wrote"));
			},
			...secondaryReplies,
		],
	});
	await secondary.prompt("write theirs");
	// The primary's own blocker reached the primary.
	expect(userTextsFrom(primary, 0)).toContain(`${UNRESOLVED} — ${MINE}`);
	return { primary, secondary };
}

describe("#4943 R1: a staged turn-end message reaches only the session that staged it", () => {
	for (const [mode, flags] of [
		["--lens-guard", GUARDED_FLAGS],
		["default flags", UNGUARDED_FLAGS],
	] as const) {
		it(
			`keeps a subagent's staged blocker from the primary's request and hands it to the subagent's (${mode})`,
			{ timeout: TWO_SESSION_TIMEOUT_MS },
			async () => {
				// RECURRENCE GUARDED: #4943 R1 (the #4953 review F1). The primary's
				// request consumed the subagent's staged blocker from the shared
				// per-project slot, and the subagent's next request got nothing.
				const { primary, secondary } = await stageSubagentBlocker(
					project(mode === "--lens-guard" ? "guarded" : "default"),
					flags,
					[endTurn("primary looks again"), endTurn("primary looks once more")],
					[endTurn("secondary reads its own")],
				);
				const primaryBefore = primary.requests.length;
				await primary.prompt("anything new?");
				await primary.prompt("and now?");
				expect(userTextsFrom(primary, primaryBefore)).not.toContain(
					"theirs.ts",
				);
				// RECURRENCE GUARDED: #4961 review F4. The primary's requests
				// skipped the subagent's message and left no record, so a skip
				// read the same as an empty slot. One row per addressee, not one
				// per skipping request: both prompts above skip it.
				expect(
					await addressedElsewhereRows(
						primary,
						secondary.session.sessionManager.getSessionId(),
					),
				).toHaveLength(1);

				const secondaryBefore = secondary.requests.length;
				await secondary.prompt("anything new?");
				const secondaryNext = userTextsFrom(secondary, secondaryBefore);
				expect(secondaryNext).toContain(`${UNRESOLVED} — ${THEIRS}`);
				expect(secondaryNext).not.toContain("mine.ts");

				expect(primary.errors).toEqual([]);
				expect(secondary.errors).toEqual([]);
				await secondary.dispose();
				await primary.dispose();
			},
		);
	}

	it(
		"keeps a subagent's staged blocker from the MCP host's Stop pass and lens_turn_end, and hands it to the subagent",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4943 R2 (the #4961 remainder). The MCP host
			// read the project's slot with no reader identity, so a Stop pass in
			// the same project rendered a pi session's staged blocker to the MCP
			// client as a historical finding, its acknowledge consumed it, and
			// the pi session's next request got nothing. The MCP server here is
			// this test process's own copy, beside the pi sessions' loaded one:
			// the two share only the project cache, as two processes do.
			const proj = project("mcp");
			const { primary, secondary } = await stageSubagentBlocker(
				proj,
				GUARDED_FLAGS,
				[],
				[endTurn("secondary reads its own")],
			);
			const record = path.join(
				getProjectDataDir(proj),
				"cache",
				"turn-end-findings.json",
			);
			const staged = fs.readFileSync(record, "utf8");
			expect(JSON.parse(staged)).toMatchObject({
				consumed: false,
				deliverTo: secondary.session.sessionManager.getSessionId(),
			});
			_resetMcpSessionContext();
			_resetTurnEndChain();
			try {
				const stop = await runTurnEndForIpc(proj);
				expect(stop.outcome.turnEnd ?? "").not.toContain("theirs.ts");
				if (stop.deliveryId !== undefined)
					expect(acknowledgeTurnEnd(proj, stop.deliveryId)).toBe(true);
				const tool = await runTurnEnd(proj);
				expect(tool.turnEnd ?? "").not.toContain("theirs.ts");
				expect(fs.readFileSync(record, "utf8")).toBe(staged);
			} finally {
				_resetTurnEndChain();
				_resetMcpSessionContext();
			}

			const secondaryBefore = secondary.requests.length;
			await secondary.prompt("anything new?");
			expect(userTextsFrom(secondary, secondaryBefore)).toContain(
				`${UNRESOLVED} — ${THEIRS}`,
			);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"hands the subagent its blocker when the primary's turn end writes over the staged one first",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// In flight: the subagent's blocker is staged, then the primary's next
			// turn end composes its own message over the one slot before the
			// subagent asks. The subagent's next request finds the primary's
			// message and leaves it; its turn end composes its blocker again
			// (the last turn end was the primary's, so it is no repeat), and its
			// request after that receives it. The primary never does.
			const proj = project("overwrite");
			const { primary, secondary } = await stageSubagentBlocker(
				proj,
				GUARDED_FLAGS,
				[
					step(
						writeTarget(path.join(proj, "src", "mine2.ts"), BLOCKING_FILE),
						"writing again",
					),
					endTurn("primary wrote again"),
				],
				[endTurn("secondary looks"), endTurn("secondary looks again")],
			);
			const primaryBefore = primary.requests.length;
			await primary.prompt("write mine2");
			expect(userTextsFrom(primary, primaryBefore)).toContain(
				`${UNRESOLVED} — ${path.join("src", "mine2.ts")}`,
			);
			expect(userTextsFrom(primary, 0)).not.toContain("theirs.ts");

			const secondaryBefore = secondary.requests.length;
			await secondary.prompt("anything new?");
			await secondary.prompt("and again?");
			const secondaryNext = userTextsFrom(secondary, secondaryBefore);
			expect(secondaryNext).toContain(`${UNRESOLVED} — ${THEIRS}`);
			expect(secondaryNext).not.toContain("mine");

			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"keeps the subagent's staged blocker for the subagent across the primary's /new",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// In flight: the subagent's blocker is staged, then the primary is
			// replaced (pi's newSession: a session_shutdown and a new
			// session_start in the process). The new primary's first request is
			// not the subagent's, and the subagent's next request still is.
			const { primary, secondary } = await stageSubagentBlocker(
				project("replaced"),
				GUARDED_FLAGS,
				[],
				[endTurn("secondary reads its own")],
			);
			const successor = await primary.restart({ reason: "new" }, [
				endTurn("fresh start"),
			]);
			await successor.prompt("hello");
			expect(userTextsFrom(successor, 0)).not.toContain("theirs.ts");

			const secondaryBefore = secondary.requests.length;
			await secondary.prompt("anything new?");
			expect(userTextsFrom(secondary, secondaryBefore)).toContain(
				`${UNRESOLVED} — ${THEIRS}`,
			);

			expect(successor.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await successor.dispose();
		},
	);

	it(
		"hands a subagent the test-runner findings its own turn end made eligible, not the primary",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4961 review F1. The request hook read the
			// sibling `test-runner-findings` slot as `runtime.telemetrySessionId`,
			// which a concurrent secondary never pins, so the subagent's own
			// eligible delivery read as another session's and reached no one.
			const proj = project("test-runner");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [endTurn("primary looks")],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [endTurn("secondary reads its own")],
			});
			const secondaryId = secondary.session.sessionManager.getSessionId();
			// The subagent's turn end ran the suite and its idle boundary made
			// the result eligible: the runner's record, then the real
			// staging and eligibility writers, keyed to the subagent's session.
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			const failure = "FAIL src/theirs.test.ts > adds";
			cacheManager.writeCache(
				"test-runner-findings",
				{ content: failure, testRunGeneration: 3 },
				proj,
			);
			stageTestRunnerDelivery({
				cwd: proj,
				sessionId: secondaryId,
				generation: 3,
				targetCount: 1,
				hasFindings: true,
			});
			deliverTestRunnerFindings({
				ctx: { cwd: proj, isIdle: () => true },
				cacheManager,
				runtime,
				sessionId: secondaryId,
			});
			_resetTestRunnerDeliveryForTests();
			expect(
				cacheManager.readCache<{ deliveryEligible?: { sessionId?: string } }>(
					"test-runner-findings",
					proj,
				)?.data?.deliveryEligible?.sessionId,
			).toBe(secondaryId);

			await primary.prompt("anything new?");
			expect(userTextsFrom(primary, 0)).not.toContain(failure);

			await secondary.prompt("anything new?");
			expect(userTextsFrom(secondary, 0)).toContain(failure);

			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);
});
