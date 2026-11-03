// flake-shape: in-process-mock — the lsp_aux_wait_outcome and lsp_rules_refreshed rows are outside the getRecentLoggedPhases ring (LAST_PHASE_EXCLUDED) and test mode skips the file sink, so a passed-through logLatency spy is the only reader of the per-touch published counts and held-publish counter (#4763)
/**
 * #4763 — the publish handler's hold on opengrep's EMPTY publish that precedes
 * `semgrep/rulesRefreshed`.
 *
 * The recurrence these cases prevent: opengrep with `--config auto` scans a
 * just-opened document before its rules load ("Rules not loaded yet, not
 * scanning anything"), publishes `[]` for it, and republishes the real result
 * after the notification. The handler cached, stamped and emitted that `[]`
 * like any answer, so the touch ended as `answered` and the findings arrived
 * after the wait: 0 of 86 opengrep aux waits in the field carried findings.
 *
 * The end-to-end proof through the real `lsp_diagnostics` handler and a real
 * stdio wire is `tests/tools/lsp-diagnostics-opengrep-pre-rules-4763.test.ts`.
 * This file drives the production notification handler
 * (`setupIncomingHandlers`) and the production open path (`handleNotifyOpen`)
 * directly, because the ordering and counting cells need arrival orders the
 * wire cannot schedule deterministically. The recorded orders come from
 * `tests/fixtures/opengrep-lsp-trace/auxiliary-first-publish.json`, measured
 * against the real binaries, so the replay is not a double built from the
 * issue's description (AGENTS.md shape 16).
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

import {
	handleNotifyOpen,
	MAX_TRACKED_SERVER_MESSAGES,
	publicationCountsForPath,
	setupIncomingHandlers,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../../clients/lsp/wait-policy/strategies.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.py";
const KEY = normalizeMapKey(FILE);
const OPENGREP_DEBOUNCE_MS = 250;

const FINDING: LSPDiagnostic = {
	severity: 1,
	message: "Found 'subprocess' function 'call' with 'shell=True'.",
	range: { start: { line: 4, character: 31 }, end: { line: 4, character: 35 } },
};

interface TraceEvent {
	atMs: number;
	publishedCount?: number;
	notification?: string;
	logMessage?: string;
}
interface TraceRun {
	id: string;
	server: string;
	steps: Array<{ label: string; events: TraceEvent[] }>;
}
const trace = JSON.parse(
	fs.readFileSync(
		path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../fixtures/opengrep-lsp-trace/auxiliary-first-publish.json",
		),
		"utf8",
	),
) as { runs: TraceRun[] };
const run = (id: string): TraceRun => {
	const found = trace.runs.find((entry) => entry.id === id);
	if (!found) throw new Error(`no recorded run ${id}`);
	return found;
};
const coldEvents = (id: string): TraceEvent[] => run(id).steps[0]!.events;

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

function armHandler(
	serverId: string,
	role?: "auxiliary" | "language",
): {
	state: LSPClientState;
	publish: Publish;
	rulesRefreshed: () => void;
	showMessage: (type: number, message: string) => void;
	emitted: string[];
} {
	const state = createMockState({
		serverId,
		diagnosticEmitter: new EventEmitter(),
		...(role !== undefined && { serverRole: role }),
	});
	const emitted: string[] = [];
	state.diagnosticEmitter.on("diagnostics", (changed: string) =>
		emitted.push(changed),
	);
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, (params?: unknown) => void]>;
	const publish = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1];
	const refreshed = calls.find(
		(call) => call[0] === "semgrep/rulesRefreshed",
	)?.[1];
	const message = calls.find((call) => call[0] === "window/showMessage")?.[1];
	expect(publish).toBeDefined();
	expect(refreshed).toBeDefined();
	expect(message).toBeDefined();
	return {
		state,
		publish: publish as Publish,
		rulesRefreshed: () => refreshed?.(undefined),
		showMessage: (type, text) => message?.({ type, message: text }),
		emitted,
	};
}

const uri = (file: string) => pathToFileURL(file).href;
const findings = (count: number): LSPDiagnostic[] =>
	Array.from({ length: count }, () => FINDING);

describe("#4763 opengrep's empty publish before semgrep/rulesRefreshed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is marked on opengrep and on no other server (the measured population)", () => {
		// Recurrence: a marker copied onto a server whose first publish IS its
		// answer would hold that answer for a notification it never sends. The
		// recorded first publishes of the other auxiliaries carry their findings
		// (ast-grep 3/3 at +30..35 ms after its rules reloaded, zizmor 3/3 at +3 ms,
		// typos 3/3 at +0..1 ms), so none of them is marked.
		const marked = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(([, strategy]) => strategy.emptyUntilRulesRefreshed === true)
			.map(([serverId]) => serverId);
		expect(marked).toEqual(["opengrep"]);
		for (const id of ["ast-grep-cold", "zizmor-cold", "typos-cold"]) {
			const first = coldEvents(id).find(
				(event) => event.publishedCount !== undefined,
			);
			expect(first?.publishedCount, `${id} first publish`).toBeGreaterThan(0);
		}
	});

	it.each([
		"auto-cold-1",
		"auto-cold-2",
		"auto-cold-3",
		"auto-cold-1.32-1",
		"auto-cold-1.32-2",
		"auto-clean",
		"local-1",
		"local-race",
	])(
		"%s: replays the recorded order, holding only what precedes the notification",
		(id) => {
			const { state, publish, rulesRefreshed, emitted } =
				armHandler("opengrep");
			const events = coldEvents(id);
			let refreshed = false;
			let lastPublishCount = 0;
			for (const event of events) {
				if (event.notification === "semgrep/rulesRefreshed") {
					rulesRefreshed();
					refreshed = true;
				} else if (event.publishedCount !== undefined) {
					publish({
						uri: uri(FILE),
						diagnostics: findings(event.publishedCount),
					});
					lastPublishCount = event.publishedCount;
				}
				vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
				if (!refreshed && event.publishedCount === 0) {
					// An empty publish before the notification: not cached, no stamp,
					// no emit, so it can neither end a wait nor read as "answered".
					expect(state.pushDiagnostics.has(KEY)).toBe(false);
					expect(state.diagnosticsVersionsByPath.get(KEY)).toBeUndefined();
					expect(emitted).toEqual([]);
				}
			}
			// What opengrep said last is what the cache holds, and it was emitted.
			expect(state.pushDiagnostics.get(KEY)).toHaveLength(lastPublishCount);
			expect(emitted.length).toBeGreaterThan(0);
		},
	);

	it("does not hold when the rules loaded first: an empty publish is then a clean answer", () => {
		const { state, publish, rulesRefreshed, emitted } = armHandler("opengrep");
		rulesRefreshed();
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(emitted).toEqual([KEY]);
	});

	it("never holds a non-empty publish: it is a scan result", () => {
		const { state, publish, emitted } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
		expect(emitted).toEqual([KEY]);
	});

	it("does not swallow an empty publish that clears a stored finding", () => {
		// The #3310 hold's own guard, kept: a clear is an answer in any order.
		const { state, publish, emitted } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(emitted).toEqual([KEY, KEY]);
	});

	it.each(["ast-grep", "typos", "zizmor"])(
		"%s: an empty publish is an answer on its first publish",
		(serverId) => {
			// Recurrence: the hold broadened to every auxiliary would turn each clean
			// file into a wait to the budget. Versioned, as the recorded runs are
			// (version 0 on the first open); a version-less typos `[]` is its
			// close-publish and is dropped for another reason (#3548).
			const { state, publish, emitted } = armHandler(serverId);
			publish({ uri: uri(FILE), diagnostics: [], version: 0 });
			vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

			expect(state.pushDiagnostics.get(KEY)).toEqual([]);
			expect(emitted).toEqual([KEY]);
		},
	);

	it("a respawned client is a new state and holds again", () => {
		const first = armHandler("opengrep");
		first.rulesRefreshed();
		const second = armHandler("opengrep");
		second.publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(first.state.rulesGeneration).toBe(1);
		expect(second.state.rulesGeneration ?? 0).toBe(0);
		expect(second.state.pushDiagnostics.has(KEY)).toBe(false);
	});

	it("PAIR-REOPEN: two opens before the rules load keep #3482's backlog balanced through the notification", async () => {
		// Opengrep re-scans only on a fresh open, so a second touch inside the
		// rule-load window closes and reopens the document (`reopenOnResync`) and
		// each open gets its own pre-rules `[]`. A held publish must still count
		// as answering its send, or the backlog keeps one send for good and the
		// late-auxiliary drain waits for a publication that never comes.
		const { state, publish, rulesRefreshed } = armHandler("opengrep");
		const counts = () => publicationCountsForPath(state, KEY);

		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 1, published: 1 });
		await handleNotifyOpen(state, FILE, "b", "python", false, true);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.has(KEY)).toBe(false);

		// The notification takes one back, the one republish for the open
		// document restores it: balanced, and the findings are cached.
		rulesRefreshed();
		expect(counts()).toEqual({ sent: 2, published: 1 });
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
	});

	it("PAIR-SAVE: a save inside the rule-load window expects its own rescan publication and stays balanced", async () => {
		// `rescansOnSave`: didSave makes opengrep scan again, an answer to no send,
		// so the path expects one more publication. Before the rules load that
		// scan publishes `[]` too, and it is held and counted like the open's.
		const { state, publish, rulesRefreshed } = armHandler("opengrep");
		state.saveOptions = { includeText: false };
		const counts = () => publicationCountsForPath(state, KEY);

		await handleNotifyOpen(state, FILE, "a", "python", false, true, true);
		expect(counts()).toEqual({ sent: 2, published: 0 });
		publish({ uri: uri(FILE), diagnostics: [] });
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.has(KEY)).toBe(false);

		rulesRefreshed();
		expect(counts()).toEqual({ sent: 2, published: 1 });
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
	});

	it("reports the held publishes once, on the lsp_rules_refreshed row", () => {
		// Bounded observability: one row per refresh, carrying how many empty
		// publishes the hold dropped. A hold that never releases (rules never load)
		// is visible as `silent` aux outcomes with `publishedCount: 0`, not here.
		const { publish, rulesRefreshed } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [] });
		publish({ uri: uri("/project/b.py"), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		rulesRefreshed();

		const rows = logLatency.mock.calls
			.map(([row]) => row as { phase?: string; metadata?: unknown })
			.filter((row) => row.phase === "lsp_rules_refreshed");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			serverId: "opengrep",
			heldEmptyPublishes: 2,
		});
	});

	it("a second refresh reports only the publishes held since the first row", () => {
		// Recurrence (#4770 review F2): the counter was never reset, so every
		// later `lsp_rules_refreshed` row re-reported the session total as if the
		// hold had dropped that many publishes again.
		const { publish, rulesRefreshed } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		rulesRefreshed();
		rulesRefreshed();

		const held = logLatency.mock.calls
			.map(
				([row]) =>
					row as { phase?: string; metadata?: { heldEmptyPublishes?: number } },
			)
			.filter((row) => row.phase === "lsp_rules_refreshed")
			.map((row) => row.metadata?.heldEmptyPublishes);
		expect(held).toEqual([1, 0]);
	});
});

/**
 * #4764 x #4763: one auxiliary's publish acceptance under both rules. The
 * table is the contract the PR body states; each cell drives the production
 * publish handler and reads what was stored, emitted and counted.
 *
 *   state \ publish   empty                  clearing empty         non-empty
 *   A rules not loaded  held, counted          stored, emitted        stored, emitted
 *   B rules loaded      stored, emitted        stored, emitted        stored, emitted
 *   C config failed     refused, counted       refused, counted,      stored, emitted
 *                                              the finding stays
 *
 * Recurrence: the two rules were written apart (#4763 holds the pre-rules
 * empty; #4764 refuses the empty after a config failure) and meet on the same
 * accept/refuse decision in `setupIncomingHandlers`; a cell that drifts either
 * stores a false clean or swallows a real answer.
 */
describe("#4764 x #4763 an auxiliary's publish acceptance table", () => {
	const FATAL =
		"Fatal error: Failed to download config from https://semgrep.dev/c/p/default: Unix_error: Connection refused connect";
	type Arm = ReturnType<typeof armHandler>;
	const states: Record<string, (arm: Arm) => void> = {
		A: () => {},
		B: (arm) => arm.rulesRefreshed(),
		C: (arm) => arm.showMessage(1, FATAL),
	};
	const settle = () => vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * [state, kind, stored diagnostics (undefined = absent), emitted, published].
	 * A "clearing empty" answers a NEW send after the stored finding (a fix
	 * landing). A "same-send empty" lands in the finding's own phase, one rules
	 * generation and one send, so #4786 refuses it in every state: opengrep's
	 * open-documents scan clears files it did not target that way.
	 */
	const cells: Array<[string, string, number | undefined, number, number]> = [
		["A", "empty", undefined, 0, 1],
		["A", "clearing empty", 0, 2, 2],
		["A", "same-send empty", 1, 1, 2],
		["A", "non-empty", 1, 1, 1],
		["B", "empty", 0, 1, 1],
		["B", "clearing empty", 0, 2, 2],
		["B", "same-send empty", 1, 1, 2],
		["B", "non-empty", 1, 1, 1],
		["C", "empty", undefined, 0, 1],
		["C", "clearing empty", 1, 1, 2],
		["C", "same-send empty", 1, 1, 2],
		["C", "non-empty", 1, 1, 1],
	];

	it.each(cells)(
		"state %s, %s publish: stored=%s emitted=%s counted=%s",
		(stateName, kind, stored, emittedCount, published) => {
			const arm = armHandler("opengrep", "auxiliary");
			const { state, publish, emitted } = arm;
			// Sends the path expects, so the cap on counted publications is not hit.
			state.documentVersions.set(KEY, 9);
			if (kind === "clearing empty" || kind === "same-send empty") {
				// The finding is stored under the state the cell starts in (a
				// pre-failure or pre-refresh scan), then the state is entered.
				if (stateName === "B") states.B(arm);
				publish({ uri: uri(FILE), diagnostics: [FINDING] });
				settle();
				if (stateName === "C") states.C(arm);
				// The next send of the path, as a resync records it.
				if (kind === "clearing empty") state.documentVersions.set(KEY, 10);
			} else {
				states[stateName](arm);
			}
			publish({
				uri: uri(FILE),
				diagnostics: kind === "non-empty" ? [FINDING] : [],
			});
			settle();

			expect(state.pushDiagnostics.get(KEY)?.length).toBe(stored);
			expect(emitted).toHaveLength(emittedCount);
			expect(publicationCountsForPath(state, KEY).published).toBe(published);
		},
	);

	it("a failure that lands after a held empty keeps the next empty refused and counted", () => {
		// Offline order measured on opengrep 1.30.0: `[]`, then the fatal
		// message, then `[]` again. Neither empty may be stored; both answer a
		// send, so the backlog stays balanced.
		const arm = armHandler("opengrep", "auxiliary");
		arm.state.documentVersions.set(KEY, 9);
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		arm.showMessage(1, FATAL);
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		settle();

		expect(arm.state.pushDiagnostics.has(KEY)).toBe(false);
		expect(arm.emitted).toEqual([]);
		expect(publicationCountsForPath(arm.state, KEY).published).toBe(2);
	});

	it("a failure inside the debounce window of a post-refresh empty is refused at store time", () => {
		// The receipt-time gate saw no failure yet; the store-time gate decides
		// against the state known when the timer fires, so neither arrival order
		// stores an empty from a server whose config then failed.
		const arm = armHandler("opengrep", "auxiliary");
		arm.state.documentVersions.set(KEY, 9);
		arm.rulesRefreshed();
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		arm.showMessage(1, FATAL);
		settle();

		expect(arm.state.pushDiagnostics.has(KEY)).toBe(false);
		expect(arm.emitted).toEqual([]);
		expect(publicationCountsForPath(arm.state, KEY).published).toBe(1);
	});

	it("a rules refresh after a failure clears it: the server says its rules loaded", () => {
		// Recurrence: a sticky failure flag would refuse every empty publish of a
		// server whose rules did load, turning each clean file into a permanent
		// unconfirmed one. `semgrep/rulesRefreshed` is sent only after the rules
		// loaded (opengrep `refresh_rules` sends it after `cache_session`).
		const arm = armHandler("opengrep", "auxiliary");
		arm.showMessage(1, FATAL);
		arm.rulesRefreshed();
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		settle();

		expect(arm.state.configLoadFailure).toBeUndefined();
		expect(arm.state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(arm.emitted).toEqual([KEY]);
	});

	it("a language-role server is never gated by the failure", () => {
		// A server without the #4763 marker, so only the #4764 gate is in play.
		const arm = armHandler("fake-language", "language");
		arm.state.documentVersions.set(KEY, 9);
		arm.showMessage(1, FATAL);
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		settle();

		expect(arm.state.pushDiagnostics.get(KEY)).toEqual([]);
	});
});

/**
 * #4764 review round 1: a config failure that lands AFTER answers were stored
 * or while one sits in its debounce. Each row drives the production handler:
 * the stored state is built by real publishes, then the error message lands,
 * then the timers run.
 *
 * Recurrences these rows name:
 * - language rows: the retraction ran for every role, so a language server's
 *   stored clean answers were deleted by a message that never gates it
 *   (Greptile P1, "Language answers disappear").
 * - "pending non-empty": the retraction cancelled the debounce timer of a
 *   newer finding, which was then lost (Greptile P1 / CodeRabbit).
 * - "pending empty": a retraction that skipped paths with a pending answer
 *   would leave the stored rule-less empty in place, because the pending empty
 *   is refused at store time and never replaces it.
 */
describe("#4764 a late config failure versus stored and pending answers", () => {
	const FATAL =
		"Fatal error: Failed to download config from https://semgrep.dev/c/p/default: Unix_error: Connection refused connect";
	const settle = () => vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** [role, pending publish when the failure lands, stored length after (undefined = absent), counted] */
	const rows: Array<
		[
			"auxiliary" | "language",
			"none" | "empty" | "non-empty",
			number | undefined,
			number,
		]
	> = [
		["auxiliary", "none", undefined, 1],
		["auxiliary", "non-empty", 1, 2],
		["auxiliary", "empty", undefined, 2],
		["language", "none", 0, 1],
		["language", "non-empty", 1, 2],
	];

	it.each(rows)(
		"%s server, stored empty, pending %s: stored=%s counted=%s",
		(role, pending, stored, published) => {
			const arm = armHandler(
				role === "auxiliary" ? "opengrep" : "fake-language",
				role,
			);
			arm.state.documentVersions.set(KEY, 9);
			// Rules loaded, so the auxiliary's empty is a stored answer (#4763
			// holds it otherwise).
			if (role === "auxiliary") arm.rulesRefreshed();
			arm.publish({ uri: uri(FILE), diagnostics: [] });
			settle();
			expect(arm.state.pushDiagnostics.get(KEY)).toEqual([]);
			if (pending !== "none") {
				arm.publish({
					uri: uri(FILE),
					diagnostics: pending === "non-empty" ? [FINDING] : [],
				});
			}
			arm.showMessage(1, FATAL);
			settle();

			expect(arm.state.pushDiagnostics.get(KEY)?.length).toBe(stored);
			expect(publicationCountsForPath(arm.state, KEY).published).toBe(
				published,
			);
		},
	);

	it("refresh and error cycles keep the message map within its reserved slot", () => {
		// Recurrence (Greptile P2, "Recovery bypasses the message cap"): the
		// first-failure admission keyed on the failure state, which a refresh
		// clears, so each refresh/error cycle added one more distinct text past
		// the cap and one more detailed record.
		const arm = armHandler("opengrep", "auxiliary");
		for (let cycle = 0; cycle < 12; cycle += 1) {
			arm.showMessage(1, `${FATAL} (attempt ${cycle})`);
			arm.rulesRefreshed();
		}

		expect(arm.state.serverMessages?.size).toBe(
			MAX_TRACKED_SERVER_MESSAGES + 1,
		);
	});

	it("a distinct failure past the cap after a refresh still refuses the next empty", () => {
		// Recurrence: a cap fix that latched the admission once per session would
		// leave the state unset for a later distinct failure text, and that
		// server's empties would read clean again. The state is not a record, so
		// the cap never decides it.
		const arm = armHandler("opengrep", "auxiliary");
		arm.state.documentVersions.set(KEY, 9);
		for (let index = 0; index < MAX_TRACKED_SERVER_MESSAGES; index += 1) {
			arm.showMessage(3, `indexing folder ${index}`);
		}
		arm.showMessage(1, FATAL);
		arm.rulesRefreshed();
		arm.showMessage(1, `${FATAL} (retry)`);
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		settle();

		expect(arm.state.configLoadFailure?.message).toContain("(retry)");
		expect(arm.state.pushDiagnostics.has(KEY)).toBe(false);
	});

	it("an informational message carrying the fatal text does not gate", () => {
		// Acceptance item 1 says an ERROR-level message: a log or info line that
		// quotes the same words (a server echoing an earlier attempt) must not
		// blind a scanner whose rules loaded.
		const arm = armHandler("opengrep", "auxiliary");
		arm.state.documentVersions.set(KEY, 9);
		arm.rulesRefreshed();
		arm.showMessage(3, FATAL);
		arm.publish({ uri: uri(FILE), diagnostics: [] });
		settle();

		expect(arm.state.configLoadFailure).toBeUndefined();
		expect(arm.state.pushDiagnostics.get(KEY)).toEqual([]);
	});
});
