/**
 * #2129 wiring. `tests/clients/session-start-total-classification.test.ts`
 * proves `handleSessionStart` logs `deps.sessionStartClassification`/
 * `sessionStartSameRoot` alongside `session_start_total`'s `mode` field. It
 * cannot prove index.ts's `session_start` handler actually SUPPLIES those
 * deps from `decideSessionStart`'s own decision — drop the two fields from
 * the call site and that unit test still passes. This file drives the real
 * handler through the pi mock, so a call site that stops threading the
 * decision through reds here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import { removeTempDirSync } from "./clients/test-utils.js";

/** Make an already-emitted ctx read as invalidated, the way the SDK does
 *  after a session replacement. */
function invalidate(ctx: unknown): void {
	Object.defineProperty(ctx as object, "isIdle", {
		configurable: true,
		get() {
			throw new Error(STALE_CTX_MESSAGE);
		},
	});
}

type SessionStartTotalRecord = {
	phase: "session_start_total";
	metadata: {
		mode: string;
		classification?: string;
		sameRoot: boolean | "unknown";
	};
};

/**
 * The `session_start_total` rows in a latency log. The default is this test
 * graph's own log; the tier-2 case reads the log the LOADED copy wrote under
 * the home `tests/support/pi-session.ts` pinned (its loggers bind their path at
 * their own module load, so this graph's binding names a different file).
 */
//
// The tier-2 case reads the LOADED copy's log, whose path this graph's
// `getLatencyLogPath()` does not name (the copy's loggers bind their own path
// at ITS module load). `flushAllNdjsonWriters` drains the process-global
// writer map both graphs registered into, so it settles the copy's rows before
// the read (#4381 shape: a sink read drains first).
async function sessionStartTotalsAt(
	filePath: string,
): Promise<SessionStartTotalRecord[]> {
	await flushAllNdjsonWriters();
	return sessionStartTotals(filePath);
}
function sessionStartTotals(
	filePath: string = getLatencyLogPath(),
): SessionStartTotalRecord[] {
	const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.phase === "session_start_total")
		.map((entry) => {
			const metadata = entry.metadata;
			if (!metadata || typeof metadata !== "object") {
				throw new Error("session_start_total metadata is missing");
			}
			const typed = metadata as Record<string, unknown>;
			if (
				typed.sameRoot !== true &&
				typed.sameRoot !== false &&
				typed.sameRoot !== "unknown"
			) {
				throw new Error("session_start_total sameRoot is not explicit");
			}
			return {
				phase: "session_start_total",
				metadata,
			} as SessionStartTotalRecord;
		});
}

const fixture = piSessionFixture();

describe("index session_start wiring — classification logged with mode (#2129)", () => {
	let hostRoot: string;
	let previousStartupMode: string | undefined;
	let previousTestMode: string | undefined;

	beforeEach(async () => {
		_resetSessionLifecycleForTests();
		previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		await flushLatencyLog();
		hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-host-root-"));
	});

	afterEach(async () => {
		await flushLatencyLog();
		_resetSessionLifecycleForTests();
		if (previousStartupMode === undefined) {
			delete process.env.PI_LENS_STARTUP_MODE;
		} else {
			process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		}
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		removeTempDirSync(hostRoot);
	});

	it("a fresh primary start's session_start_total carries classification=primary", async () => {
		// Tier 2 (#4632): a REAL pi session at this fixture's root, so the
		// `session_start` the row describes is the host's own start with pi's
		// own ctx and session manager, not a hand-built event. The row is read
		// from the home the loaded copy pinned, after `dispose()` emitted
		// `session_shutdown` and pi awaited the copy's writer drain.
		//
		// The shape is QUICK: the mode a real process's FIRST `session_start`
		// takes (the cold-start heuristic in `clients/runtime-session.ts`), so
		// the row asserts `mode: "quick"` exactly as the double-based version of
		// this case did. The helper opts the quick mode's warmup timer out (its
		// persist has no test-side drain); the START shape is what this case
		// pins (#4664 F3).
		const cwd = path.join(fixture.root, "primary", "proj");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("ready"))],
			startupMode: "quick",
		});
		await handle.prompt("hello");
		await handle.dispose();
		expect(handle.errors).toEqual([]);

		const totals = await sessionStartTotalsAt(
			path.join(process.env.PI_LENS_HOME ?? "", "latency.log"),
		);
		expect(totals).toHaveLength(1);
		expect(totals[0].metadata).toMatchObject({
			mode: "quick",
			classification: "primary",
			sameRoot: "unknown",
		});
	}, 30_000);

	it("a same-root sequential replacement carries classification + sameRoot:true", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		const first = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), first);
		invalidate(first);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: hostRoot, sessionId: "host-session-2" }),
		);
		await flushLatencyLog();

		const totals = sessionStartTotals();
		expect(totals).toHaveLength(2);
		expect(totals[1].metadata).toMatchObject({
			mode: "quick",
			classification: "sequential-replacement",
			sameRoot: true,
		});
	}, 30_000);

	it("an accepted replacement in a different root carries sameRoot:false", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		const first = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), first);
		const replacementRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-replacement-root-"),
		);
		try {
			(first as { cwd: string }).cwd = replacementRoot;
			await pi.emit(
				"session_start",
				makeSessionStartEvent({ reason: "resume" }),
				first,
			);
			await flushLatencyLog();

			const totals = sessionStartTotals();
			expect(totals).toHaveLength(2);
			expect(totals[1].metadata).toMatchObject({
				classification: "sequential-replacement",
				sameRoot: false,
			});
		} finally {
			removeTempDirSync(replacementRoot);
		}
	}, 30_000);

	it("a declined temp-root start never reaches session_start_total", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();
		const tempWorktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pi-agent-worktree-"),
		);
		try {
			const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
			await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
			invalidate(hostCtx);
			await pi.emit(
				"session_start",
				makeSessionStartEvent(),
				makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
			);
			await flushLatencyLog();

			// Only the host's own start reached the full body; the declined
			// temp-root start returned before handleSessionStart ever ran.
			expect(sessionStartTotals()).toHaveLength(1);
		} finally {
			removeTempDirSync(tempWorktree);
		}
	}, 30_000);
});
