/**
 * #4631, at tier 2 (#4632): the prompt-cache prefix is what the PROVIDER
 * receives, across turns.
 *
 * pi 0.87+ hands a `context` handler the conversation with every system message
 * filtered out; when that handler returns a changed list, pi rebuilds one
 * merged system head from every system message (`restoreSystemMessages`). The
 * head bytes then differ from the one the provider cached, so every injecting
 * turn missed the prompt cache. A bare handler-return test cannot see this: the
 * defect is the host's post-processing of the return, observed on the next
 * request. So this file runs a real `AgentSession` (pi's own services and
 * session, pi-ai's `fauxProvider`) and asserts the messages pi actually sent.
 *
 * LIFECYCLE (the #4664 merge order, not a signature swap). This file began as
 * #4632's slice-0 pilot and now runs on the merged tier-2 helper:
 *
 * - ONE file-scoped fixture root from `piSessionFixture()`, not a root per case
 *   (`beforeEach`). `startPiSession` refuses a second root, measured: a
 *   session under a second root writes into the FIRST root's home and nothing
 *   into its own (#4664 F4). A case that needs its own project directory passes
 *   a `cwd` under the fixture root instead.
 * - NO in-process `extensionFactories`. pi loads `index.js` through its own
 *   loader with `moduleCache: false`, so the extension under test is the same
 *   BUILT twin an install runs, and it holds its own copies of `clients/*`.
 *   Neither the factory this file used to pass nor
 *   `_resetSessionLifecycleForTests()` reaches that copy; disposal is the
 *   helper's (`dispose()` emits `session_shutdown` into the loaded copy, then
 *   drains).
 * - Guidance is staged through the cache the delivery reads, not through a
 *   `stageGuidance` helper method: `CacheManager(false).writeCache(
 *   "session-start-guidance", …)` under the session's own cwd. That is the
 *   same row `clients/runtime-session.ts` writes at the end of a start, so the
 *   injecting turn is caused by delivery alone and never by a start's timing.
 *
 * The expected head comes from pi-ai's own replay (`getCurrentSystemMessage`,
 * `collapseSystemMessages`), never a hand-rolled merge.
 */
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	fauxAssistantMessage,
	fauxToolCall,
	piAiModule,
	piSessionFixture,
	startPiSession,
} from "../support/pi-session.js";

/**
 * The transcript replay this file adds to the helper's pi-ai handle. The helper
 * declares only the four `faux*` entry points it asserts exist (#4664 F1), and
 * no `@earendil-works/pi-ai` import SPECIFIER may exist in this tree: that
 * package ships inside the host's own install, so a static specifier would pin
 * a second copy. This file therefore reuses the handle `piAiModule()` loads
 * from the host and declares the three transcript entry points it reads. The
 * package entry re-exports them (`@earendil-works/pi-ai` `dist/index.js` →
 * `./utils/transcript.ts`), so they are the same module instance pi itself
 * calls. Read `piAiModule()`'s own failure mode first: a host without them
 * makes `getCurrentSystemMessage` undefined here rather than silently passing.
 */
interface TranscriptReplay {
	getCurrentSystemMessage(messages: readonly { role: string }[]): unknown;
	normalizeContext(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
	collapseSystemMessages(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
}

const piAi = piAiModule() as unknown as TranscriptReplay;

const fixture = piSessionFixture();
// No per-case root, no per-case handle list: the helper owns both. It disposes
// a live session in its own `afterEach` (#4664 M2), and its `afterAll` removes
// the root after the drain.

/**
 * Stage one `session-start-guidance` payload for the next request to inject,
 * under the session's own cwd — the key `consumeSessionStartGuidance`
 * (`clients/runtime-context.ts`) reads it back by.
 */
function stageGuidance(cwd: string, text: string): void {
	new CacheManager(false).writeCache(
		"session-start-guidance",
		{ content: text },
		cwd,
	);
}

describe("#4631 the injecting turn keeps the prompt-cache head pi sent before it", () => {
	it("keeps the system head byte-identical on an injecting turn", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: `${fixture.root}/prefix-plain/proj`,
			// A QUICK start writes no `session-start-guidance` (the row is written at
			// the END of a full start), so the first request is a genuinely quiet
			// turn. Left at the "full" default, request 1 would already carry the
			// guidance advisory and the cells would compare injecting turn to
			// injecting turn, losing the contrast their names claim.
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("third answer"),
			],
		});
		const { requests } = handle;

		await handle.prompt("first question");
		const before = requests.at(-1);
		if (!before) throw new Error("the plain turn sent no request");
		// The precondition both cells rely on: the baseline turn is QUIET. A start
		// that wrote guidance would red here instead of quietly weakening the
		// contrast (the pin the "quick" mode above buys).
		expect(JSON.stringify(before)).not.toContain("pi-lens automated context");

		stageGuidance(
			handle.cwd,
			"NARROW-DIFF-GUIDANCE: change only the line under test",
		);
		await handle.prompt("second question");
		const injecting = requests.at(-1);
		expect(injecting).toBeDefined();
		const sent = injecting as NonNullable<typeof injecting>;

		await handle.prompt("third question");
		const after = requests.at(-1);
		if (!after) throw new Error("the follow-up turn sent no request");

		// The transcript's own head is the only system message: the injection
		// never makes the host rebuild one.
		expect(sent.filter((message) => message.role === "system")).toHaveLength(1);
		// pi's own replay of this transcript is the head the provider received.
		expect(sent[0]).toEqual(piAi.getCurrentSystemMessage(sent));
		// Nothing is mid-list, so pi's collapse is a no-op for this request.
		expect(
			piAi.collapseSystemMessages(
				piAi.normalizeContext({ messages: [...sent] }),
			).messages,
		).toEqual(sent);
		// The cached prefix survives BYTE for byte: the provider hashes the
		// serialized message, so key order and values both count. The previous
		// turn's head, and the following turn's, are the same bytes.
		expect(JSON.stringify(sent[0])).toBe(JSON.stringify(before[0]));
		expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
		// The payload still lands, on the last user message.
		expect(JSON.stringify(sent.at(-1))).toContain("NARROW-DIFF-GUIDANCE");
	});

	it("appends the activation's tool delta and injects without touching the head", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: `${fixture.root}/prefix-delta/proj`,
			// Quick, for the same reason as the cell above.
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage(
					fauxToolCall("pi_lens_activate_tools", {
						tools: ["ast_grep_search"],
					}),
				),
				fauxAssistantMessage("activation answer"),
				fauxAssistantMessage("third answer"),
			],
		});
		const { requests } = handle;

		await handle.prompt("first question");
		const plain = requests.at(-1);
		if (!plain) throw new Error("the plain turn sent no request");
		expect(JSON.stringify(plain)).not.toContain("pi-lens automated context");

		// pi appends one system message announcing the tool delta before the
		// request that follows the activation, which is the mid-list shape
		// `restoreSystemMessages` used to fold into the head. The tool call runs
		// in the LOADED copy's registry: this file passes no factory of its own.
		await handle.prompt("activate the search tool");
		const requestBeforeActivation = requests.at(-2);
		const activated = requests.at(-1);
		if (!requestBeforeActivation || !activated)
			throw new Error("the activation turn did not send both requests");
		const delta = activated.at(-1);
		expect(delta?.role).toBe("system");
		if (delta?.role !== "system")
			throw new Error("the activation turn appended no system delta");
		expect(
			(delta as { toolsAdded?: Array<{ name: string }> }).toolsAdded?.map(
				(tool) => tool.name,
			),
		).toContain("ast_grep_search");
		// The delta is only appended: the earlier request prefix and the head
		// are byte-identical.
		expect(activated.slice(0, requestBeforeActivation.length)).toEqual(
			requestBeforeActivation,
		);
		expect(JSON.stringify(activated[0])).toBe(JSON.stringify(plain[0]));

		stageGuidance(handle.cwd, "ACTIVATION-GUIDANCE: keep the delta mid-list");
		await handle.prompt("third question");
		const injecting = requests.at(-1);
		if (!injecting) throw new Error("the injecting turn sent no request");

		// Injecting with the delta present keeps the whole earlier transcript,
		// delta included, as the unchanged prefix, byte for byte.
		expect(injecting.slice(0, activated.length)).toEqual(activated);
		expect(JSON.stringify(injecting.slice(0, activated.length))).toBe(
			JSON.stringify(activated),
		);
		expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(plain[0]));
		expect(injecting[activated.length - 1]).toEqual(delta);
		expect(JSON.stringify(injecting.at(-1))).toContain("ACTIVATION-GUIDANCE");

		// THE MEASURED BOUNDARY (#4631 round 5, F4). `fauxProvider` maps
		// `context.messages` straight into the prompt, so the byte identity above
		// is the TRANSCRIPT the host hands the extension — not the payload a
		// provider that collapses system messages sends. pi-ai's real adapters run
		// `collapseSystemMessages` first, and that replayed head DOES re-render
		// when the tool table changes; that is pi's design, not pi-lens's. So the
		// property to hold at BOTH boundaries is narrower and is asserted here:
		// appending a delta rewrites the head, and INJECTING rewrites nothing.
		const collapsedHead = (messages: readonly unknown[]) =>
			JSON.stringify(
				piAi.collapseSystemMessages(
					piAi.normalizeContext({ messages: [...messages] }),
				).messages[0],
			);
		expect(collapsedHead(activated)).not.toBe(collapsedHead(plain));
		expect(collapsedHead(injecting)).toBe(collapsedHead(activated));
	});
});
