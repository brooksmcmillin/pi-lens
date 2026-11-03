/**
 * #4723 r4 (CodeRabbit on `index.ts` `tool_call`): a lazy-tool memory write
 * belongs to the session that made the call, not to the session that started
 * last on the activation.
 *
 * Recurrence prevented: both writers (`tool_call` on a situational tool and
 * `pi_lens_activate_tools`' `onActivated`) passed the activation-wide `scope`,
 * which every `session_start` reassigns. With two live sessions on ONE
 * activation, A's calls after B's start went into B's memory: A's sidecar lost
 * them, and B kept two tools across its own model switch that only A asked for.
 *
 * TIER 2 (`tests/support/pi-session.ts`), with one deliberate step outside the
 * helper. pi's own entry points never put two live sessions on one activation:
 * every session build runs a fresh load, so a second `startPiSession` is a
 * second activation (#4704). The only shape that shares one is an embedder
 * building a second `AgentSession` from the first one's `ResourceLoader`
 * (`createAgentSessionFromServices` takes it as given, and `_buildRuntime` hands
 * `resourceLoader.getExtensions()` to the new runner). B below is built that
 * way, from pi's real API, and the case first proves the two runners hold the
 * same loaded extension. B is not a helper handle, so this file shuts it down
 * itself.
 *
 * Observables, both written by the loaded copy: A's per-session sidecar
 * (`persistScope` at A's turn end), and the tool set pi holds for B after B's
 * own model switch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	hostModule,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import { withGlobalConfig } from "./support/global-config.js";

const fixture = piSessionFixture();

const READY = fauxAssistantMessage(fauxText("ready"));
const CALLED = "ast_grep_search";
const ACTIVATED = "lsp_navigation";
/** A model without the fact: under `tools.lazy: "auto"` every tool is active. */
const COLLAPSING: Readonly<Record<string, unknown>> = {};

/** The parts of pi's `AgentSession` this file drives for the embedder's B. */
interface EmbeddedSession {
	readonly model: { id: string } & Record<string, unknown>;
	readonly modelRuntime: unknown;
	readonly settingsManager: unknown;
	readonly resourceLoader: { getExtensions(): { extensions: unknown[] } };
	readonly sessionManager: { getSessionId(): string };
	readonly extensionRunner: {
		getActiveTools(): string[];
		emit(event: Record<string, unknown>): Promise<unknown>;
	};
	bindExtensions(bindings: {
		onError: (error: unknown) => void;
	}): Promise<void>;
	setModel(model: Record<string, unknown>): Promise<void>;
	dispose(): void;
}

/** The sidecar the loaded copy persists per conversation (pi's session id). */
function sidecarPath(cwd: string, sessionId: string): string {
	return path.join(getProjectDataDir(cwd), "sessions", `${sessionId}.json`);
}

/** Wait, bounded, for the loaded copy's turn-end write, then read it. */
async function sidecarStores(
	cwd: string,
	sessionId: string,
): Promise<Record<string, unknown>> {
	const target = sidecarPath(cwd, sessionId);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !fs.existsSync(target))
		await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fs.existsSync(target), target).toBe(true);
	return (
		JSON.parse(fs.readFileSync(target, "utf8")) as {
			stores: Record<string, unknown>;
		}
	).stores;
}

describe("#4723 r4 lazy-tool memory follows the calling session", () => {
	it("A's direct call and activation after B's start land in A's memory, not B's", async () => {
		await withGlobalConfig(
			path.join(fixture.root, "global", "auto.json"),
			{ tools: { lazy: "auto" } },
			async () => {
				let b: EmbeddedSession | undefined;
				try {
					const a = await startPiSession({
						root: fixture.root,
						cwd: path.join(fixture.root, "a", "proj"),
						modelCompat: COLLAPSING,
						// One assistant message calls both writers, so every turn-end write
						// of A's sidecar comes after both.
						responses: [
							fauxAssistantMessage([
								fauxText("searching and activating"),
								fauxToolCall(CALLED, {
									pattern: "foo($X)",
									lang: "typescript",
								}),
								fauxToolCall("pi_lens_activate_tools", { tools: [ACTIVATED] }),
							]),
							READY,
						],
					});
					const aSession = a.session as unknown as EmbeddedSession;

					// B: an embedder's second session over A's loaded extensions, started
					// LAST, in another root, so the activation admits it as a concurrent
					// secondary and its start reassigns the activation-wide scope.
					const bCwd = path.join(fixture.root, "b", "proj");
					fs.mkdirSync(path.join(bCwd, ".git"), { recursive: true });
					const host = hostModule();
					const created = await host.createAgentSessionFromServices({
						services: {
							cwd: bCwd,
							agentDir: path.join(fixture.root, "agent"),
							modelRuntime: aSession.modelRuntime,
							settingsManager: aSession.settingsManager,
							resourceLoader: aSession.resourceLoader,
						},
						sessionManager: host.SessionManager.inMemory(bCwd),
						model: aSession.model,
					} as unknown as Parameters<
						typeof host.createAgentSessionFromServices
					>[0]);
					b = created.session as unknown as EmbeddedSession;
					const bErrors: unknown[] = [];
					await b.bindExtensions({ onError: (error) => bErrors.push(error) });
					// The premise: ONE activation serves both sessions.
					expect(b.resourceLoader.getExtensions().extensions[0]).toBe(
						aSession.resourceLoader.getExtensions().extensions[0],
					);
					expect(b.sessionManager.getSessionId()).not.toBe(
						aSession.sessionManager.getSessionId(),
					);

					await a.prompt("search for foo calls and activate navigation");
					const results = new Set(
						(a.requests.at(-1) ?? [])
							.filter((message) => message.role === "toolResult")
							.map((message) => (message as { toolName?: string }).toolName),
					);
					expect([...results]).toEqual([CALLED, "pi_lens_activate_tools"]);

					// A's memory holds both: its turn-end sidecar is A's own scope.
					const aStores = await sidecarStores(
						a.cwd,
						aSession.sessionManager.getSessionId(),
					);
					expect(aStores["lazy-tool-memory"]).toEqual([CALLED, ACTIVATED]);

					// B never asked for either, so its own switch to a lazy model hides
					// both (pi routes this activation's tool-set writes to B, the session
					// built last, which is the session whose memory the plan reads).
					await b.setModel({
						...aSession.model,
						id: "faux-2",
						compat: { supportsMidConvoSystemMessages: true },
					});
					const bActive = b.extensionRunner.getActiveTools();
					expect(bActive).not.toContain(CALLED);
					expect(bActive).not.toContain(ACTIVATED);
					expect(bActive).toContain("lens_diagnostics");
					expect(a.errors).toEqual([]);
					expect(bErrors).toEqual([]);
				} finally {
					if (b) {
						await b.extensionRunner.emit({
							type: "session_shutdown",
							reason: "quit",
						});
						b.dispose();
					}
				}
			},
		);
	});
});
