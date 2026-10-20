/**
 * Shared builder for the session-start payload pi-lens's tests fire through
 * `PiMock.emit(eventName, payload, ctx)` — #1681 acceptance criterion 3.
 *
 * The builder's field set is derived from the pinned host contract (see
 * `host-event-shape-scan.ts`'s doc comment for the file:line citations into
 * `packages/coding-agent/src/core/extensions/types.ts`), so a call site that
 * only ever goes through these cannot drift into a host-unfaithful shape.
 * These are optional, not mandatory: existing tests may keep constructing a
 * payload literal by hand (the scan in `host-event-shape-scan.ts` still
 * catches a drift either way), but a suite should prefer this over a
 * hand-rolled literal.
 *
 * `sessionId`/`provider`/`model` are deliberately not parameters here — the
 * host never puts them on this event. A test that needs one
 * passes it to `makeCtx({ sessionId, model })` (`tests/support/pi-mock.ts`)
 * instead, which is where the host actually carries it.
 */

export interface SessionStartEventFixture {
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

/** `SessionStartEvent` — `types.ts:561-568`. Defaults to a fresh "startup". */
export function makeSessionStartEvent(
	overrides: Partial<SessionStartEventFixture> = {},
): SessionStartEventFixture {
	const event: SessionStartEventFixture = {
		reason: overrides.reason ?? "startup",
	};
	if (overrides.previousSessionFile !== undefined) {
		event.previousSessionFile = overrides.previousSessionFile;
	}
	return event;
}

/**
 * The leading SYSTEM message pi 1.3.0 hands the `context_with_system` phase.
 *
 * #4631 round 5 (F2): the host ALWAYS leads this transcript with it —
 * `ExtensionRunner.emitContext` emits `{ type: "context_with_system", messages:
 * currentMessages }` where `currentMessages[0]` is the system message, and
 * reports `Handler removed the leading system message` when a handler's return
 * loses it (`dist/core/extensions/runner.js`, the 0.87+ two-phase emit). The
 * head is not `{ role, content }`: `content` is EMPTY, the prompt lives in
 * `sections`, and the initial tool table in `toolsAdded`.
 *
 * A double that omits it makes `messages[0]` a USER message, which is a shape
 * the host never sends. That made `observeCachePrefix` hash a user message in
 * every witness (production records `firstMessageRole: "system"`), and left the
 * head-loss regression invisible: dropping the head kept every delivery
 * assertion green, because nothing asserted the head survived.
 */
export function makeSystemHead(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: "system",
		content: "",
		sections: {
			preamble: "You are an expert coding assistant operating inside pi.",
			tools:
				"<tools>\n- read: Read file contents\n- bash: Execute bash commands\n</tools>",
			rules:
				"<rules>\n- Use bash for file operations like ls, rg, find\n</rules>",
			cwd: "<cwd>\n/proj\n</cwd>",
		},
		timestamp: 1792479807686,
		toolsAdded: [{ name: "read" }, { name: "bash" }],
		...overrides,
	};
}

/**
 * A `context_with_system` event carrying the conversation behind the hosted
 * system head — the shape pi 1.3.0 emits, so a case that injects here asserts
 * against the transcript production sees.
 *
 * `head: null` builds the headless event some cases need on purpose: the
 * extension's empty-transcript prepend fallback (`existingMessages.length === 0`)
 * is unreachable from any host, so its two cells keep the shape that reaches it.
 */
export function makeContextWithSystemEvent(
	conversation: ReadonlyArray<Record<string, unknown>> = [],
	head: Record<string, unknown> | null = makeSystemHead(),
): {
	type: "context_with_system";
	messages: Array<Record<string, unknown>>;
} {
	return {
		type: "context_with_system",
		messages: [...(head ? [head] : []), ...conversation],
	};
}
