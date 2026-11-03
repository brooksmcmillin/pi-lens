/**
 * Slice 6 of #4632: the dynamic-tooling cases on the REAL host.
 *
 * Moved here from the `#dynamic-tooling` block of `tests/index-wiring.test.ts`,
 * which drove the hand-built pi double (`tests/support/pi-mock.ts`). Every case
 * below starts a real pi `AgentSession` over the BUILT extension
 * (`tests/support/pi-session.ts`, tier 2): pi loads `index.js` with its own
 * loader, executes the real `pi_lens_activate_tools` tool, and runs its own
 * session replacements (`new` / `resume` / `fork` / `reload`). A case therefore
 * reads what the host itself holds (`AgentSession.extensionRunner.getActiveTools()`),
 * what the model was actually sent, or a record the loaded copy wrote.
 *
 * PROBE (2026-10-21, `@earendil-works/pi-coding-agent` 1.3.0), quoted in the PR
 * body: pi exposes the loadout two ways to an extension.
 *  - `ExtensionAPI.getActiveTools()` / `setActiveTools()` (the equivalent of
 *    `toolsAdded`/`toolsRemoved`; neither name is a field of an
 *    `ExtensionAPI` event type).
 *  - The request transcript. pi's agent loop writes the tool delta into a
 *    SYSTEM message (`toolsAdded` / `toolsRemoved`) before each request, and
 *    `context_with_system` handlers are handed that transcript for the request
 *    they answer. The semantics are pinned by the tier-2 helper case
 *    "pins the tool-loadout declaration pi builds for a request"
 *    (`tests/support/pi-session.test.ts`) before this file reads them.
 *
 * WHAT STAYS ON THE DOUBLE, with the probe that keeps it there (PR body has the
 * transcripts):
 *  - "falls back to all tools statically active on a host without dynamic-tooling
 *    support". CLASS: `unproducible-payload` — pi 1.3.0 always exposes both
 *    methods, so no host this tier can start lacks the API. The double's
 *    `supportsActiveTools: false` is the only seam that reaches the branch.
 *  - "clears remembered posture for the new conversation's current session file".
 *    CLASS: `unproducible-payload` — `AgentSessionRuntime.newSession()` always
 *    mints a fresh session file (`agent-session-runtime.js:147-165`), so the
 *    double's shutdown that names the CURRENT file as its successor
 *    (`targetSessionFile` equal to the departing `sessionFile`) is a payload pi
 *    never produces. The observable half (a new conversation forgets the
 *    previous activations) is here as "forgets the previous conversation's
 *    activations on a new session".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	replayToolNames,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const READY = fauxAssistantMessage(fauxText("ready"));
const ACTIVATION_TOOL = "pi_lens_activate_tools";
const ACTIVATED_TOOL = "ast_grep_search";
const NOT_ACTIVATED_TOOL = "ast_grep_replace";
const LAZY_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"lsp_navigation",
	"lens_diagnostic_mark",
];
const ALWAYS_ACTIVE_TOOLS = [
	"lens_diagnostics",
	"symbol_search",
	"project_report",
	"module_report",
	"read_symbol",
	"read_enclosing",
];

/** The project directory for one case: a fresh cwd UNDER this file's one fixture. */
function projectRoot(...segments: string[]): string {
	return path.join(fixture.root, ...segments, "proj");
}

/** The active set pi itself holds for a session. */
function activeTools(handle: PiSession): string[] {
	return handle.session.extensionRunner.getActiveTools();
}

/** The sidecar the loaded copy persists per conversation (pi's session id). */
function sidecarPath(cwd: string, sessionId: string): string {
	return path.join(getProjectDataDir(cwd), "sessions", `${sessionId}.json`);
}

/** Wait, bounded, for the loaded copy's turn-end write. */
async function sidecarWritten(cwd: string, sessionId: string): Promise<void> {
	const target = sidecarPath(cwd, sessionId);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !fs.existsSync(target))
		await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fs.existsSync(target), target).toBe(true);
}

/** Start a session and activate the situational search tool through pi's own tool loop. */
async function startActivated(segments: string[]): Promise<PiSession> {
	const handle = await startPiSession({
		root: fixture.root,
		cwd: projectRoot(...segments),
		responses: [
			fauxAssistantMessage([
				fauxText("activating"),
				fauxToolCall(ACTIVATION_TOOL, { tools: [ACTIVATED_TOOL] }),
			]),
			READY,
		],
	});
	await handle.prompt("activate the search tool");
	// The turn that ran the loader is also the turn that ends and persists.
	return handle;
}

/**
 * The `metadata` of the loaded copy's `phase` rows that `match` accepts, in
 * write order. ONE reader for this file's rows: every case below asserts a
 * record the loaded copy wrote, never a value this file supplied.
 */
async function latencyMetadata(
	handle: PiSession,
	phase: string,
	match: (metadata: Record<string, unknown>) => boolean = () => true,
): Promise<Array<Record<string, unknown>>> {
	return (await handle.latencyRows()).rows.flatMap((row) => {
		const metadata = row.metadata as Record<string, unknown> | undefined;
		if (row.phase !== phase) return [];
		if (typeof metadata !== "object" || metadata === null) return [];
		return match(metadata) ? [metadata] : [];
	});
}

/** `tool_set_mutation` rows the loaded copy wrote, optionally by reason. */
async function toolSetRows(
	handle: PiSession,
	reason?: string,
): Promise<number> {
	return (
		await latencyMetadata(
			handle,
			"tool_set_mutation",
			(metadata) => reason === undefined || metadata.reason === reason,
		)
	).length;
}

describe("dynamic tooling on the real host (#4632 slice 6)", () => {
	it("registers the 5 situational tools inactive and everything else active on a dynamic-tooling host", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectRoot("startup"),
			responses: [READY],
		});
		const active = new Set(activeTools(handle));
		for (const tool of LAZY_TOOLS) {
			expect(active.has(tool), `should start inactive: ${tool}`).toBe(false);
		}
		for (const tool of ALWAYS_ACTIVE_TOOLS) {
			expect(active.has(tool), `should start active: ${tool}`).toBe(true);
		}
		expect(active.has(ACTIVATION_TOOL)).toBe(true);

		// The model-visible half: the request declares exactly the set the host
		// holds, so an inactive tool is not callable by name on this turn.
		await handle.prompt("hello");
		expect(new Set(replayToolNames(handle.requests[0]))).toEqual(active);
		expect(handle.errors).toEqual([]);
	});

	it.each(["fork", "reload"])(
		"restores the parent's tool posture on %s session_start",
		async (reason) => {
			const handle = await startActivated(["posture", reason]);
			const parentPosture = [...activeTools(handle)].sort();
			expect(activeTools(handle)).toContain(ACTIVATED_TOOL);
			expect(activeTools(handle)).not.toContain(NOT_ACTIVATED_TOOL);
			const rowsBefore = await toolSetRows(handle, "session_rebuild_restore");

			let rebuilt: PiSession;
			if (reason === "fork") {
				// pi's own fork: a new conversation branched at the leaf.
				const leaf = handle.session.sessionManager.getLeafId() ?? "";
				rebuilt = await handle.restart(
					{ reason: "fork", entryId: leaf, position: "at" },
					[READY],
				);
				expect(rebuilt.session.sessionManager.getSessionId()).not.toBe(
					handle.session.sessionManager.getSessionId(),
				);
			} else {
				// pi's own reload: the same AgentSession, factories re-run in place.
				const runnerBefore = handle.session.extensionRunner;
				rebuilt = await handle.restart({ reason: "reload" }, [READY]);
				expect(rebuilt).toBe(handle);
				expect(rebuilt.session.extensionRunner).not.toBe(runnerBefore);
			}

			// Character-for-character the parent's set: the advertised tool list
			// still matches the cached prompt prefix AND the activation survived.
			expect([...activeTools(rebuilt)].sort()).toEqual(parentPosture);
			expect(activeTools(rebuilt)).toContain(ACTIVATED_TOOL);
			expect(activeTools(rebuilt)).not.toContain(NOT_ACTIVATED_TOOL);
			const rowsAfter = await toolSetRows(rebuilt, "session_rebuild_restore");
			if (reason === "reload") {
				// The reloaded copy shrank the all-active set itself.
				expect(rowsAfter).toBe(rowsBefore + 1);
			} else {
				// pi restored the loadout from the branched transcript before
				// `session_start`. An EMPTY activation memory would make the plan
				// shrink the activated tool away (and record it); the posture above
				// is the witness that the memory matched the parent.
				//
				// Recurrence prevented (#4741): pi 1.4 restores the recorded loadout
				// PLUS every extension tool the branch never mentioned, and a lazy
				// tool the model never activated is never mentioned. So pi <=1.3
				// hands the plan a correct set (no mutation), while pi 1.4 activates
				// the other lazy tools and the plan removes exactly those, once,
				// before the first request. Pinning "no mutation" reds on 1.4;
				// pinning only the posture would let a plan that rewrites more than
				// the host's extras (or adds a tool) pass.
				const rewrites = (
					await latencyMetadata(
						rebuilt,
						"tool_set_mutation",
						(metadata) => metadata.reason === "session_rebuild_restore",
					)
				)
					.slice(rowsBefore)
					.map((metadata) => [metadata.addedCount, metadata.removedCount]);
				expect([[], [[0, LAZY_TOOLS.length - 1]]]).toContainEqual(rewrites);
			}
			expect(rebuilt.errors).toEqual([]);
		},
		60_000,
	);

	it("restores activation after a factory re-run for the same session file", async () => {
		const handle = await startActivated(["factory-rebuild"]);
		const sessionFile = handle.sessionFile();
		const sessionId = handle.session.sessionManager.getSessionId();
		// A real turn end persisted this conversation's own sidecar.
		await sidecarWritten(handle.cwd, sessionId);

		const runnerBefore = handle.session.extensionRunner;
		const reloaded = await handle.restart({ reason: "reload" }, [READY]);

		// pi kept the session and the file; the loaded copy is a new activation.
		expect(reloaded).toBe(handle);
		expect(reloaded.sessionFile()).toBe(sessionFile);
		expect(reloaded.session.extensionRunner).not.toBe(runnerBefore);
		expect(activeTools(reloaded)).toContain(ACTIVATED_TOOL);
		expect(activeTools(reloaded)).not.toContain(NOT_ACTIVATED_TOOL);
		// The sidecar is the record that outlived the activation.
		expect(fs.existsSync(sidecarPath(reloaded.cwd, sessionId))).toBe(true);
	});

	it("inherits activation from the parent session file on a fork", async () => {
		const handle = await startActivated(["fork-inherit", "parent"]);
		const parentFile = handle.sessionFile();
		const parentId = handle.session.sessionManager.getSessionId();
		const leaf = handle.session.sessionManager.getLeafId() ?? "";

		const forked = await handle.restart(
			{ reason: "fork", entryId: leaf, position: "at" },
			[READY],
		);

		// pi minted a new conversation file, and the parent's sidecar is still the
		// record under which its activations were persisted.
		expect(forked.sessionFile()).not.toBe(parentFile);
		expect(fs.existsSync(sidecarPath(forked.cwd, parentId))).toBe(true);
		expect(activeTools(forked)).toContain(ACTIVATED_TOOL);
		expect(activeTools(forked)).not.toContain(NOT_ACTIVATED_TOOL);
	});

	it("keeps the departing conversation's posture when /new changes session file", async () => {
		const handle = await startActivated(["new-retain"]);
		const departingFile = handle.sessionFile();
		expect(departingFile).toBeTruthy();

		// pi's /new: a fresh conversation file.
		const replacement = await handle.restart({ reason: "new" }, [READY]);
		expect(replacement.sessionFile()).not.toBe(departingFile);

		// Switching back to the departing conversation restores its posture.
		const back = await replacement.restart(
			{ reason: "resume", sessionFile: departingFile ?? "" },
			[READY],
		);
		expect(back.sessionFile()).toBe(departingFile);
		expect(activeTools(back)).toContain(ACTIVATED_TOOL);
		expect(activeTools(back)).not.toContain(NOT_ACTIVATED_TOOL);
	});

	it("does not restore activation for a different session file on resume", async () => {
		// A conversation that never activated a situational tool.
		const other = await startPiSession({
			root: fixture.root,
			cwd: projectRoot("resume-other", "b"),
			responses: [READY],
		});
		await other.prompt("hello");
		const otherFile = other.sessionFile();
		expect(otherFile).toBeTruthy();
		await other.dispose();

		const handle = await startActivated(["resume-other", "a"]);
		expect(activeTools(handle)).toContain(ACTIVATED_TOOL);

		const resumed = await handle.restart(
			{ reason: "resume", sessionFile: otherFile ?? "" },
			[READY],
		);
		expect(resumed.sessionFile()).toBe(otherFile);
		expect(activeTools(resumed)).not.toContain(ACTIVATED_TOOL);
		expect(activeTools(resumed)).toContain("lens_diagnostics");
	});

	it("forgets the previous conversation's activations on a new session", async () => {
		const handle = await startActivated(["new-forget"]);
		expect(activeTools(handle)).toContain(ACTIVATED_TOOL);

		const next = await handle.restart({ reason: "new" }, [READY]);

		expect(activeTools(next)).not.toContain(ACTIVATED_TOOL);
		expect(activeTools(next)).toContain("lens_diagnostics");
		// The decision the `new` start recorded for the activation memory: the
		// policy RESETS it. `reset` and `adopt` land the same cells here (a new
		// conversation has no hand-off source and no payload), so this row is the
		// only witness that the policy still says reset (#4707 F3).
		const startRow = (
			await latencyMetadata(
				next,
				"session_store_action",
				(metadata) =>
					metadata.store === "lazy-tool-memory" && metadata.reason === "new",
			)
		).at(-1);
		expect(startRow).toMatchObject({
			store: "lazy-tool-memory",
			action: "reset",
			reason: "new",
			source: "none",
			payloadPresent: false,
		});

		// The new conversation's first request declares the bare baseline.
		await next.prompt("hello");
		expect(replayToolNames(next.requests[0])).not.toContain(ACTIVATED_TOOL);
	});

	it("retains remembered posture across a quit shutdown", async () => {
		const handle = await startActivated(["quit"]);
		const sessionFile = handle.sessionFile();
		const sessionId = handle.session.sessionManager.getSessionId();
		await sidecarWritten(handle.cwd, sessionId);
		expect(activeTools(handle)).toContain(ACTIVATED_TOOL);

		// `resume()` emits the quit shutdown (pi's reason for a process leaving)
		// and reopens the SAME conversation file in a new session.
		const resumed = await handle.resume([READY]);

		expect(resumed.sessionFile()).toBe(sessionFile);
		expect(activeTools(resumed)).toContain(ACTIVATED_TOOL);
		expect(activeTools(resumed)).not.toContain(NOT_ACTIVATED_TOOL);
	});

	it("keeps every tool statically active when lazy tooling is disabled", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectRoot("static-tools"),
			flags: new Map<string, boolean | string>([["no-lazy-tools", true]]),
			responses: [READY, READY],
		});

		for (const tool of LAZY_TOOLS) {
			expect(activeTools(handle), tool).toContain(tool);
		}
		await handle.prompt("hello");
		expect(replayToolNames(handle.requests[0])).toContain(ACTIVATED_TOOL);

		// A rebuild does not shrink it either: under the opt-out pi-lens never
		// touches the set, on any reason.
		const reloaded = await handle.restart({ reason: "reload" }, [READY]);
		for (const tool of LAZY_TOOLS) {
			expect(activeTools(reloaded), tool).toContain(tool);
		}
	});
});
