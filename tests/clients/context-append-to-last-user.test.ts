/**
 * Tests for #3693: Appending context injection to active user prompt to preserve KV cache
 * for local models (llama.cpp / Qwen) and prefix-caching providers.
 *
 * TWO TIERS (#4632). The first and the fourth case run through a REAL pi
 * session (`tests/support/pi-session.ts`, tier 2): the extension is the built
 * `index.js` loaded by pi's own loader, and the observable is the message the
 * SCRIPTED MODEL received, after pi's own request processing. Every other case
 * here asserts pi-lens's own return-value shaping for transcripts a scripted
 * provider cannot produce — an image block list, an empty array, a custom
 * `{ weird: true }` content object, an empty transcript — so those stay on the
 * pi double, which is the cheaper and only possible driver for them. Each of
 * those direct-handler cells now carries the host's real system head
 * (`makeContextWithSystemEvent`), so its index positions are the shape pi
 * actually sends (#4631 round 6, R6-1); the empty-transcript cell is the one
 * exception, because the branch it reaches is unreachable from a host.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { _resetProcessSingletonsForTests } from "../../clients/process-singletons.js";
import {
	makeContextWithSystemEvent,
	makeSystemHead,
} from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "../support/pi-session.js";

const TIMEOUT_MS = 30_000;

/** The delimiter every injected block is prefixed with. */
const INJECTION_DELIMITER = "[pi-lens automated context — not a user request]";

const fixture = piSessionFixture();
// No per-case handle list: the helper registers every session it creates and
// disposes the live ones in its own `afterEach`, so a case that fails before
// `dispose()` cannot leak one (#4664 M2).
const sessionCwd = (name: string) => path.join(fixture.root, name, "proj");

let tmpDir: string;

beforeEach(() => {
	_resetProcessSingletonsForTests();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3693-append-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadContextHandler() {
	vi.resetModules();
	const { default: registerExtension } = await import("../../index.js");
	const mock = createPiMock();
	registerExtension(mock.asExtensionAPI() as any);
	// #4631: pi 0.87+ delivers the full transcript to `context_with_system` and
	// strips system messages from `context`, so the injector is that hook. Its
	// event carries the transcript the placement rule reads.
	const context = mock.handlers.get("context_with_system")?.[0];
	expect(context).toBeTypeOf("function");
	return { context: context!, mock };
}

describe("context injection appends to last user message (#3693)", () => {
	it(
		"appends the injected block to the prompt the model actually receives, on a real pi turn",
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("string-prompt"),
				responses: [fauxAssistantMessage(fauxText("ready"))],
			});

			await handle.prompt("Optimize performance");

			// What the model received on the turn, as pi built it: the host's
			// own system head, then ONE user message carrying the prompt and the
			// injected block — appended, not added as its own message.
			const transcript = handle.requests[0];
			expect(transcript[0]).toMatchObject({ role: "system" });
			expect(transcript).toHaveLength(2);
			const blocks = transcript[1].content as Array<{
				type: string;
				text: string;
			}>;
			expect(blocks[0]).toEqual({
				type: "text",
				text: "Optimize performance",
			});
			expect(blocks[1].type).toBe("text");
			// The delimiter opens the block, exactly as the unit-level cases
			// above require; the body is pi-lens's own session-start guidance.
			expect(blocks[1].text.startsWith(INJECTION_DELIMITER)).toBe(true);
			expect(blocks[1].text).toContain("pi-lens active");
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty string user prompt without creating leading newline",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Guidance text" },
				tmpDir,
			);

			const emptyPrompt = { role: "user", content: "" };
			const existing = [emptyPrompt];
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent(existing, head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-2" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			// #4631 round 6 (R6-1): the host's request leads with the system head,
			// which the handler must hand back untouched — the user prompt and the
			// injected block follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			const last = result.messages[1];
			expect(last.role).toBe("user");
			expect(typeof last.content).toBe("string");
			expect((last.content as string).startsWith("\n")).toBe(false);
			expect(last.content).toBe(
				"[pi-lens automated context — not a user request]\n\nGuidance text",
			);
			expect(last).not.toBe(emptyPrompt);
			expect(emptyPrompt.content).toBe("");
		},
		TIMEOUT_MS,
	);

	it(
		"handles array content with text and image blocks, preserving existing blocks, order, and immutability",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Follow safety guidelines." },
				tmpDir,
			);

			const imagePart = {
				type: "image",
				data: "base64_data",
				mimeType: "image/png",
			};
			const textPart = { type: "text", text: "Analyze this image" };
			const originalArray = [imagePart, textPart];
			const originalUser = { role: "user", content: originalArray };
			const originalUserSnapshot = JSON.stringify(originalUser);
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent([originalUser], head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-3" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			// #4631 round 6 (R6-1): the host's request leads with the system head,
			// which the handler must hand back untouched — the user prompt and the
			// injected block follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			const last = result.messages[1];
			expect(last.role).toBe("user");
			expect(Array.isArray(last.content)).toBe(true);

			const contentBlocks = last.content as Array<{
				type: string;
				[key: string]: unknown;
			}>;
			expect(contentBlocks).toHaveLength(3);
			expect(contentBlocks[0]).toEqual(imagePart);
			expect(contentBlocks[1]).toEqual(textPart);
			expect(contentBlocks[2]).toEqual({
				type: "text",
				text: "[pi-lens automated context — not a user request]\n\nFollow safety guidelines.",
			});

			// Immutability: original object and array must remain untouched
			expect(last).not.toBe(originalUser);
			expect(contentBlocks).not.toBe(originalArray);
			expect(originalArray).toHaveLength(2);
			expect(JSON.stringify(originalUser)).toBe(originalUserSnapshot);
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty array content without creating leading blank blocks",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Rule check." },
				tmpDir,
			);

			const emptyArray: unknown[] = [];
			const originalUser = { role: "user", content: emptyArray };
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent([originalUser], head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-4" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			// #4631 round 6 (R6-1): the host's request leads with the system head,
			// which the handler must hand back untouched — the user prompt and the
			// injected block follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			const last = result.messages[1];
			expect(Array.isArray(last.content)).toBe(true);
			const contentBlocks = last.content as Array<{
				type: string;
				text?: string;
			}>;
			expect(contentBlocks).toHaveLength(1);
			expect(contentBlocks[0]).toEqual({
				type: "text",
				text: "[pi-lens automated context — not a user request]\n\nRule check.",
			});
			expect(emptyArray).toHaveLength(0);
			expect(last).not.toBe(originalUser);
		},
		TIMEOUT_MS,
	);

	it(
		"appends after a trailing tool result on a real pi turn instead of into it",
		async () => {
			// The cache the request hook consumes is staged while pi assembles
			// the FIRST request, so it is present for the request that follows
			// the tool call — the transcript that ends in a tool result.
			const MID_RUN = "MIDRUN-GUIDANCE";
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("tool-result-adjacency"),
				responses: [
					() => {
						new CacheManager(false).writeCache(
							"session-start-guidance",
							{ content: MID_RUN },
							sessionCwd("tool-result-adjacency"),
						);
						return fauxAssistantMessage([
							fauxText("checking"),
							fauxToolCall("lens_diagnostics", { paths: [] }),
						]);
					},
					fauxAssistantMessage(fauxText("done")),
				],
			});

			await handle.prompt("keep working");

			// pi's own transcript: system head, the prompt, the assistant's call,
			// the tool result — then the injection as a NEW user message.
			const second = handle.requests[1];
			expect(second.map((message) => message.role)).toEqual([
				"system",
				"user",
				"assistant",
				"toolResult",
				"user",
			]);

			// Nothing was appended inside the tool result: it still carries the
			// tool's own answer only.
			const toolResultText = JSON.stringify(second[3]);
			expect(toolResultText).not.toContain(MID_RUN);
			expect(toolResultText).toContain("No issues in the current turn delta.");

			// The injection is the trailing message, prefixed with the delimiter.
			expect(second[4].content).toBe(`${INJECTION_DELIMITER}\n\n${MID_RUN}`);
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"falls back to prepend semantics for an empty transcript",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Empty transcript check." },
				tmpDir,
			);

			// #4631 round 6 (R6-1): this cell stays HEADLESS on purpose. The branch
			// it reaches (`existingMessages.length === 0`) is unreachable from a
			// host, which always leads the transcript with the system head; giving
			// it a head would delete the branch's only coverage.
			const result = (await context(
				{ messages: [] },
				makeCtx({ cwd: tmpDir, sessionId: "sess-6" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[0].content).toContain("Empty transcript check.");
		},
		TIMEOUT_MS,
	);

	it(
		"routes a non-string non-array prompt down the append-after path preserving content uncoerced",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Uncoerced test guidance." },
				tmpDir,
			);

			const customContent = { weird: true };
			const customUser = { role: "user", content: customContent };
			const existing = [{ role: "assistant", content: "Ready." }, customUser];
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent(existing, head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-7" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			// Appends AFTER the transcript as a new message, leaving customContent untouched
			expect(result.messages).toHaveLength(4);
			// #4631 round 6 (R6-1): the host's head leads the transcript; the
			// prior turns and the appended message follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			expect(result.messages[1]).toEqual({
				role: "assistant",
				content: "Ready.",
			});
			expect(result.messages[2]).toBe(customUser);
			expect(result.messages[2].content).toBe(customContent);
			expect(result.messages[3].role).toBe("user");
			expect(result.messages[3].content).toContain("Uncoerced test guidance.");
		},
		TIMEOUT_MS,
	);
});
