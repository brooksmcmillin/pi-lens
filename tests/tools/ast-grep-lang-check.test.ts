/**
 * #4687: the three ast-grep schemas carry `lang` as a plain string, not the
 * 24-id enum (about 240 bytes per tool per request). pi's argument validation
 * therefore no longer refuses an unknown id, and MCP never did, so the tool's
 * own execute-time check is the only gate between a mistyped id and the CLI.
 *
 * Recurrence: a schema trim that drops an enum and lets the unknown value reach
 * the child process, where it surfaces as an opaque CLI error (or a silent
 * zero-match result) instead of a refusal that names the valid ids.
 *
 * The client double stands in for the ast-grep child process (the process
 * boundary); each case asserts the CLI-facing call never happened.
 */
import { describe, expect, it, vi } from "vitest";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
};

function cliDouble() {
	return {
		ensureAvailable: vi.fn(async () => true),
		search: vi.fn().mockResolvedValue({ matches: [] }),
		searchWithRule: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
		validatePattern: vi.fn().mockResolvedValue({ valid: true }),
		validateRule: vi.fn().mockResolvedValue({ valid: true }),
		replace: vi.fn().mockResolvedValue({ matches: [] }),
		replaceWithRule: vi
			.fn()
			.mockResolvedValue({ matches: [], totalMatches: 0, applied: false }),
		outline: vi.fn().mockResolvedValue({ output: [] }),
		formatMatches: () => "",
	};
}

type Cli = ReturnType<typeof cliDouble>;

const TOOLS = [
	{
		name: "ast_grep_search",
		run: (cli: Cli, lang: unknown) =>
			createAstGrepSearchTool(cli as never).execute(
				"lang-1",
				{ pattern: "foo($X)", lang },
				undefined,
				null,
				{ cwd: "/proj" },
			),
		cliCalls: (cli: Cli) => cli.search.mock.calls.length,
	},
	{
		name: "ast_grep_replace",
		run: (cli: Cli, lang: unknown) =>
			createAstGrepReplaceTool(cli as never).execute(
				"lang-2",
				{ pattern: "var $X", rewrite: "let $X", lang },
				new AbortController().signal,
				null,
				{ cwd: "/proj" },
			),
		cliCalls: (cli: Cli) => cli.replace.mock.calls.length,
	},
	{
		name: "ast_grep_outline",
		run: (cli: Cli, lang: unknown) =>
			createAstGrepOutlineTool(cli as never).execute(
				"lang-3",
				{ paths: ["src"], lang } as never,
				undefined,
				null,
				{ cwd: "/proj" },
			),
		cliCalls: (cli: Cli) => cli.outline.mock.calls.length,
	},
] as const;

// Refused ids: a string that is not a registry id. The CLI accepts some of
// these (`ts` is an ast-grep alias, #4723 F5), so only this table pins that
// the validator keeps refusing them. Recurrence: an alias re-admitted on MCP.
const REFUSED_IDS: Array<[string, string]> = [
	["an unknown id", "klingon"],
	["an ast-grep CLI alias", "ts"],
];

describe("ast-grep tools refuse an unknown lang at execute (#4687)", () => {
	describe.each(TOOLS)("$name", (tool) => {
		it.each(REFUSED_IDS)(
			"refuses %s before the CLI runs, naming every valid id",
			async (_label, id) => {
				const cli = cliDouble();
				const result = (await tool.run(cli, id)) as ToolResult;

				expect(result.isError).toBe(true);
				const text = result.content[0]?.text ?? "";
				expect(text).toContain(`unknown lang "${id}"`);
				// The refusal is what the enum used to tell the model: every valid id.
				for (const valid of ["bash", "tsx", "typescript", "python", "yaml"])
					expect(text).toContain(valid);
				expect(tool.cliCalls(cli)).toBe(0);
				expect(cli.ensureAvailable).not.toHaveBeenCalled();
			},
		);
	});

	it.each(TOOLS)("$name still runs a valid lang", async (tool) => {
		const cli = cliDouble();
		const result = (await tool.run(cli, "typescript")) as ToolResult;

		expect(result.content[0]?.text ?? "").not.toContain("unknown lang");
		expect(tool.cliCalls(cli)).toBe(1);
	});

	// #4723 F4: the MCP route hands execute the client's JSON unvalidated, so
	// `lang` can be any JSON value. Recurrence: replace and outline threw a
	// TypeError on a number (`.replace` / `.trim` of a non-string) and search
	// called a number "lang is required"; each must be the refusal naming the
	// valid ids, before the CLI runs.
	const NON_STRINGS: Array<[string, unknown]> = [
		["a number", 3],
		["null", null],
		["an object", { id: "typescript" }],
		["an array", ["typescript"]],
		["a boolean", true],
	];
	describe.each(TOOLS)("$name with a non-string lang", (tool) => {
		// #4723 N2: outline's optional `lang` treats null as absent (see below),
		// so null is refused only on the required fields.
		const refusedHere = NON_STRINGS.filter(
			([, lang]) => !(lang === null && tool.name === "ast_grep_outline"),
		);
		it.each(refusedHere)(
			"refuses %s, naming every valid id",
			async (_l, lang) => {
				const cli = cliDouble();
				const result = (await tool.run(cli, lang)) as ToolResult;

				expect(result.isError).toBe(true);
				const text = result.content[0]?.text ?? "";
				expect(text).toContain("lang must be a string");
				expect(text).toContain("typescript");
				expect(tool.cliCalls(cli)).toBe(0);
				expect(cli.ensureAvailable).not.toHaveBeenCalled();
			},
		);
	});

	// #4723 F4: search and replace strip one pair of wrapping quotes from an id
	// a model sends quoted; outline refused `"\"typescript\""` as unknown.
	it.each(TOOLS)(
		"$name runs a quoted valid lang as the bare id",
		async (tool) => {
			const cli = cliDouble();
			const result = (await tool.run(cli, '"typescript"')) as ToolResult;

			expect(result.content[0]?.text ?? "").not.toContain("unknown lang");
			expect(tool.cliCalls(cli)).toBe(1);
			const call =
				tool.name === "ast_grep_outline"
					? (cli.outline.mock.calls[0]?.[1] as { lang?: string } | undefined)
							?.lang
					: tool.name === "ast_grep_search"
						? cli.search.mock.calls[0]?.[1]
						: cli.replace.mock.calls[0]?.[2];
			expect(call).toBe("typescript");
		},
	);

	// #4723 (CodeRabbit on the r1 head): a blank optional lang reached the CLI
	// as `--lang " "` instead of letting ast-grep infer the language.
	it("ast_grep_outline infers the language when lang is blank", async () => {
		const cli = cliDouble();
		const outline = TOOLS[2];
		const result = (await outline.run(cli, "   ")) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(outline.cliCalls(cli)).toBe(1);
		expect(cli.outline.mock.calls[0]?.[1]).toMatchObject({ lang: undefined });
	});

	it("ast_grep_outline still infers the language when lang is absent", async () => {
		const cli = cliDouble();
		const outline = TOOLS[2];
		await outline.run(cli, undefined);

		expect(outline.cliCalls(cli)).toBe(1);
		expect(cli.outline.mock.calls[0]?.[1]).toMatchObject({ lang: undefined });
	});

	// #4723 N2: master forwarded `lang: null` on the optional outline field and
	// the client built `--lang` only when truthy, so null meant "infer". The
	// required search field refused null at master too, so it stays refused.
	it("ast_grep_outline infers the language when lang is null (as at master)", async () => {
		const cli = cliDouble();
		const outline = TOOLS[2];
		const result = (await outline.run(cli, null)) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(outline.cliCalls(cli)).toBe(1);
		expect(cli.outline.mock.calls[0]?.[1]).toMatchObject({ lang: undefined });
	});

	it("ast_grep_search still refuses a null lang (required, as at master)", async () => {
		const cli = cliDouble();
		const search = TOOLS[0];
		const result = (await search.run(cli, null)) as ToolResult;

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text ?? "").toContain("lang must be a string");
		expect(search.cliCalls(cli)).toBe(0);
	});
});
