/**
 * #4687 item 7: `tools.lazy` = true | "auto" | false, default true, on the REAL
 * host (`tests/support/pi-session.ts`, tier 2).
 *
 * The default keeps the situational tools lazy on every model (the user's
 * 2026-10-21 decision: about 1 activation per 3,329 requests, against a
 * break-even near 1 per 1,000). `"auto"` is opt-in, so every per-model case
 * below starts under a global config that sets it: it leaves the tools lazy
 * only when the session's model has pi-ai's
 * `compat.supportsMidConvoSystemMessages === true`. On any other model pi-ai
 * folds every system message into one head (`collapseSystemMessages`), so the
 * tool delta an activation appends rewrites the whole cached prefix; such a
 * model gets every tool from the start and never activates lazily. The posture
 * is decided at session_start and on a model switch only, and a switch never
 * hides a tool the conversation activated or called (#4723 F3).
 *
 * Recurrence each case names: a per-model default that flips the tool set
 * within one model (a prefix rewrite per flip), or one that leaves a
 * collapsing model lazy (#4631's ~175k written tokens per injecting turn had
 * the same mechanism).
 *
 * Every case reads what the host holds (`getActiveTools`), what the provider
 * was sent (the request transcript and pi-ai's own collapse of it), or a row
 * the loaded copy wrote; never a value this file supplied.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piAiModule,
	piSessionFixture,
	replayToolNames,
	startPiSession,
	type PiProviderRequest,
	type PiSession,
} from "./support/pi-session.js";
import { withGlobalConfig } from "./support/global-config.js";

const fixture = piSessionFixture();

const READY = fauxAssistantMessage(fauxText("ready"));
const ACTIVATE = "pi_lens_activate_tools";
const LAZY_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"lsp_navigation",
	"lens_diagnostic_mark",
];
/** A model without the fact: pi-ai collapses its system messages. */
const COLLAPSING: Readonly<Record<string, unknown>> = {};
/** A model that keeps mid-list system messages. */
const MID_CONVO: Readonly<Record<string, unknown>> = {
	supportsMidConvoSystemMessages: true,
};

interface TranscriptReplay {
	collapseSystemMessages(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
	normalizeContext(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
}
/** pi-ai's own transcript replay, from the host's install (see pi-session.ts). */
const piAi = piAiModule() as unknown as TranscriptReplay;

/** The head a collapsing model receives for `request`. */
function collapsedHead(request: PiProviderRequest): string {
	return JSON.stringify(
		piAi.collapseSystemMessages(
			piAi.normalizeContext({ messages: [...request] }),
		).messages[0],
	);
}

function projectRoot(...segments: string[]): string {
	return path.join(fixture.root, ...segments, "proj");
}

function activeTools(handle: PiSession): string[] {
	return handle.session.extensionRunner.getActiveTools();
}

function activation(tools: string[]): Record<string, unknown> {
	return fauxAssistantMessage([
		fauxText("activating"),
		fauxToolCall(ACTIVATE, { tools }),
	]);
}

/** The loaded copy's rows of one phase, in write order. */
async function phaseRows(
	handle: PiSession,
	phase: string,
): Promise<Array<Record<string, unknown>>> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return read.rows.flatMap((row) =>
		row.phase === phase &&
		typeof row.metadata === "object" &&
		row.metadata !== null
			? [row.metadata as Record<string, unknown>]
			: [],
	);
}

/** {@link withGlobalConfig} with `tools.lazy: "auto"` and `extra` beside it. */
function withAuto(
	slug: string,
	body: () => Promise<void>,
	extra: Record<string, unknown> = {},
): Promise<void> {
	return withGlobalConfig(
		path.join(fixture.root, "global", `auto-${slug}`, "config.json"),
		{ tools: { lazy: "auto", ...extra } },
		body,
	);
}

/**
 * How many `phase` rows the shared sink holds before a case starts its own
 * session. The helper's `afterEach` disposed (and so drained) every earlier
 * case's session, so the file is settled when this runs.
 */
function rowsBefore(phase: string): number {
	const file = path.join(fixture.root, "home", "latency.log");
	if (!fs.existsSync(file)) return 0;
	return readNdjsonRows(file).rows.filter((row) => row.phase === phase).length;
}

/**
 * The `tool_set_decision` / `tool_set_mutation` rows this handle's session
 * wrote. The latency sink is shared by every case in the file, so a case
 * reads only the rows written after its own `before` count.
 */
async function rowsSince(
	handle: PiSession,
	phase: string,
	before: number,
): Promise<Array<Record<string, unknown>>> {
	return (await phaseRows(handle, phase)).slice(before);
}

describe("tools.lazy decides the lazy posture per model (#4687 item 7)", () => {
	it("the default keeps the situational tools lazy on a collapsing model", async () => {
		// Recurrence: #4723 r1 shipped "auto" as the default, so every session
		// on a model without the fact (and every driver that names no model)
		// started eager; the user kept master's lazy default.
		const decisionsBefore = rowsBefore("tool_set_decision");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectRoot("default-collapse"),
			modelCompat: COLLAPSING,
			responses: [READY],
		});
		for (const tool of LAZY_TOOLS)
			expect(activeTools(handle), tool).not.toContain(tool);
		await handle.prompt("first question");
		for (const tool of LAZY_TOOLS)
			expect(replayToolNames(handle.requests[0] ?? []), tool).not.toContain(
				tool,
			);
		expect(
			await rowsSince(handle, "tool_set_decision", decisionsBefore),
		).toEqual([
			{
				trigger: "session_start",
				mode: "on",
				lazy: true,
				supportsMidConvoSystemMessages: false,
			},
		]);
	});

	it("auto on a collapsing model: every tool is active from the start and an activation leaves both heads byte-identical", async () => {
		const decisionsBefore = rowsBefore("tool_set_decision");
		await withAuto("collapse", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("collapse"),
				modelCompat: COLLAPSING,
				responses: [READY, activation(["ast_grep_search"]), READY, READY],
			});
			for (const tool of LAZY_TOOLS)
				expect(activeTools(handle), tool).toContain(tool);

			await handle.prompt("first question");
			await handle.prompt("activate the search tool");
			await handle.prompt("third question");
			const [first, , afterActivation] = handle.requests;
			if (!first || !afterActivation)
				throw new Error("three requests expected");

			// The first request declares every lazy tool; nothing is added later.
			for (const tool of LAZY_TOOLS)
				expect(replayToolNames(first), tool).toContain(tool);
			expect(replayToolNames(afterActivation)).toEqual(replayToolNames(first));
			// The property a collapsing provider caches on: neither the raw head
			// nor pi-ai's collapsed head moves across the activation request.
			expect(JSON.stringify(afterActivation[0])).toBe(JSON.stringify(first[0]));
			expect(collapsedHead(afterActivation)).toBe(collapsedHead(first));

			const decisions = await rowsSince(
				handle,
				"tool_set_decision",
				decisionsBefore,
			);
			expect(decisions).toEqual([
				{
					trigger: "session_start",
					mode: "auto",
					lazy: false,
					supportsMidConvoSystemMessages: false,
				},
			]);
			expect(handle.errors).toEqual([]);
		});
	});

	it("auto on a mid-conversation model: the situational tools start inactive and an activation adds one", async () => {
		const decisionsBefore = rowsBefore("tool_set_decision");
		await withAuto("mid-convo", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("mid-convo"),
				modelCompat: MID_CONVO,
				responses: [activation(["ast_grep_search"]), READY, READY],
			});
			for (const tool of LAZY_TOOLS)
				expect(activeTools(handle), tool).not.toContain(tool);

			await handle.prompt("activate the search tool");
			await handle.prompt("second question");
			expect(replayToolNames(handle.requests[0] ?? [])).not.toContain(
				"ast_grep_search",
			);
			expect(replayToolNames(handle.requests.at(-1) ?? [])).toContain(
				"ast_grep_search",
			);
			expect(
				await rowsSince(handle, "tool_set_decision", decisionsBefore),
			).toEqual([
				{
					trigger: "session_start",
					mode: "auto",
					lazy: true,
					supportsMidConvoSystemMessages: true,
				},
			]);
		});
	});

	it("auto: a switch to a collapsing model activates every lazy tool once, and the next same-model turn changes nothing", async () => {
		const mutationsBefore = rowsBefore("tool_set_mutation");
		await withAuto("switch-to-collapse", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("switch-to-collapse"),
				modelCompat: MID_CONVO,
				responses: [READY, READY, READY],
			});
			await handle.prompt("first question");
			expect(replayToolNames(handle.requests[0] ?? [])).not.toContain(
				"lsp_navigation",
			);

			await handle.switchModel(COLLAPSING);
			for (const tool of LAZY_TOOLS)
				expect(activeTools(handle), tool).toContain(tool);
			await handle.prompt("second question");
			await handle.prompt("third question");
			const [, afterSwitch, sameModel] = handle.requests;
			if (!afterSwitch || !sameModel)
				throw new Error("three requests expected");
			for (const tool of LAZY_TOOLS)
				expect(replayToolNames(afterSwitch), tool).toContain(tool);
			// Within the new model the set never flips: no delta, same head.
			expect(replayToolNames(sameModel)).toEqual(replayToolNames(afterSwitch));
			expect(collapsedHead(sameModel)).toBe(collapsedHead(afterSwitch));

			const mutations = (
				await rowsSince(handle, "tool_set_mutation", mutationsBefore)
			).map((row) => [row.reason, row.addedCount, row.removedCount]);
			expect(mutations).toEqual([
				["fresh_session_lazy_deactivation", 0, LAZY_TOOLS.length],
				["model_switch", LAZY_TOOLS.length, 0],
			]);
		});
	});

	it("auto: a switch to a mid-conversation model deactivates only the lazy tools the conversation never asked for", async () => {
		await withAuto("switch-to-mid", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("switch-to-mid"),
				modelCompat: COLLAPSING,
				// Asked for while every tool was already active: still remembered.
				responses: [activation(["lsp_navigation"]), READY, READY],
			});
			await handle.prompt("activate navigation");
			for (const tool of LAZY_TOOLS)
				expect(activeTools(handle), tool).toContain(tool);

			await handle.switchModel(MID_CONVO);

			const active = activeTools(handle);
			expect(active).toContain("lsp_navigation");
			for (const tool of LAZY_TOOLS.filter((name) => name !== "lsp_navigation"))
				expect(active, tool).not.toContain(tool);
			expect(active).toContain("lens_diagnostics");
		});
	});

	it("auto: a switch to a mid-conversation model keeps a situational tool the model called directly", async () => {
		// #4723 F3 (state-table row 7). Recurrence: on a collapsing model every
		// tool is active, so the model calls ast_grep_search without asking the
		// loader; the switch then planned baseline + loader memory only and
		// hid a tool the conversation was using.
		await withAuto("switch-keeps-called", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("switch-keeps-called"),
				modelCompat: COLLAPSING,
				responses: [
					fauxAssistantMessage([
						fauxText("searching"),
						fauxToolCall("ast_grep_search", {
							pattern: "foo($X)",
							lang: "typescript",
						}),
					]),
					READY,
				],
			});
			await handle.prompt("search for foo calls");
			const called = (handle.requests[1] ?? []).find(
				(message) => message.role === "toolResult",
			) as { toolName?: string } | undefined;
			expect(called?.toolName).toBe("ast_grep_search");

			await handle.switchModel(MID_CONVO);

			const active = activeTools(handle);
			expect(active).toContain("ast_grep_search");
			for (const tool of LAZY_TOOLS.filter(
				(name) => name !== "ast_grep_search",
			))
				expect(active, tool).not.toContain(tool);
		});
	});

	it("tools.lazy=true keeps the lazy posture on a collapsing model", async () => {
		const decisionsBefore = rowsBefore("tool_set_decision");
		await withGlobalConfig(
			path.join(fixture.root, "global", "lazy-true", "config.json"),
			{ tools: { lazy: true } },
			async () => {
				const handle = await startPiSession({
					root: fixture.root,
					cwd: projectRoot("lazy-true"),
					modelCompat: COLLAPSING,
					responses: [READY],
				});
				for (const tool of LAZY_TOOLS)
					expect(activeTools(handle), tool).not.toContain(tool);
				expect(
					await rowsSince(handle, "tool_set_decision", decisionsBefore),
				).toEqual([
					{
						trigger: "session_start",
						mode: "on",
						lazy: true,
						supportsMidConvoSystemMessages: false,
					},
				]);
			},
		);
	});

	it("--no-lazy-tools keeps every tool active on a mid-conversation model, across a model switch", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectRoot("no-lazy-flag"),
			modelCompat: MID_CONVO,
			flags: new Map<string, boolean | string>([["no-lazy-tools", true]]),
			responses: [READY],
		});
		for (const tool of LAZY_TOOLS)
			expect(activeTools(handle), tool).toContain(tool);
		await handle.switchModel(MID_CONVO);
		for (const tool of LAZY_TOOLS)
			expect(activeTools(handle), tool).toContain(tool);
		const decisions = (await phaseRows(handle, "tool_set_decision")).slice(-2);
		expect(decisions.map((row) => [row.trigger, row.mode, row.lazy])).toEqual([
			["session_start", "off", false],
			["model_select", "off", false],
		]);
	});

	// The enabled filter runs first (`resolveLensToolEnabled`, the same resolver
	// for the global file, a project `.pi-lens.json` read from the launch cwd,
	// and `--no-tool`); `tools.lazy` then applies only to what survived it.
	it.each([
		["a collapsing", COLLAPSING, "collapse"],
		["a mid-conversation", MID_CONVO, "mid"],
	] as const)(
		"auto on %s model: a disabled situational tool stays absent and its activation is refused",
		async (_label, modelCompat, slug) => {
			await withAuto(
				`disabled-${slug}`,
				async () => {
					const handle = await startPiSession({
						root: fixture.root,
						cwd: projectRoot("disabled", slug),
						modelCompat,
						responses: [activation(["lsp_navigation"]), READY, READY],
					});
					const registered = handle.session.extensionRunner
						.getAllRegisteredTools()
						.map((tool) => tool.definition.name);
					expect(registered).not.toContain("lsp_navigation");

					await handle.prompt("activate navigation");
					await handle.prompt("second question");
					expect(activeTools(handle)).not.toContain("lsp_navigation");
					expect(replayToolNames(handle.requests.at(-1) ?? [])).not.toContain(
						"lsp_navigation",
					);
					// pi refused the call against the loader's enabled-only enum.
					const refusal = (handle.requests[1] ?? []).find(
						(message) => message.role === "toolResult",
					) as { isError?: boolean } | undefined;
					expect(refusal?.isError).toBe(true);
					// The other situational tools follow the model's posture.
					const lazy = modelCompat === MID_CONVO;
					for (const tool of LAZY_TOOLS.filter(
						(name) => name !== "lsp_navigation",
					))
						expect(activeTools(handle).includes(tool), tool).toBe(!lazy);
				},
				{ lsp_navigation: { enabled: false } },
			);
		},
	);

	it("auto on a collapsing model: a reload keeps every tool active and writes no tool-set change", async () => {
		const mutationsBefore = rowsBefore("tool_set_mutation");
		await withAuto("reload-collapse", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectRoot("reload-collapse"),
				modelCompat: COLLAPSING,
				responses: [activation(["ast_grep_search"]), READY],
			});
			await handle.prompt("activate the search tool");
			const reloaded = await handle.restart({ reason: "reload" }, [READY]);
			for (const tool of LAZY_TOOLS)
				expect(activeTools(reloaded), tool).toContain(tool);
			expect(
				await rowsSince(reloaded, "tool_set_mutation", mutationsBefore),
			).toEqual([]);
		});
	});
});
