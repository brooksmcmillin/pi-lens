// #3405: an MCP host's write reaches a save-triggered server as a save.
// `pilens_analyze` is the route the PostToolUse hooks (warm IPC and the cold
// analyze-cli) and the explicit tool share; each one re-syncs the file through
// `analyzeFile`, and a server that declared `textDocumentSync.save` must get a
// `textDocument/didSave` after that push, as it does from pi's post-write sync.
// Server: clangd (declares `save`), launched as the built-in cpp server from
// PATH, its input mirrored by `--input-mirror-file` (no wrapper needed).
//   analyze  pilens_diagnostics positive control, then pilens_analyze twice
//            with an on-disk edit between
import fs from "node:fs";
import path from "node:path";

export const variants = ["analyze"];

const saveFor = (file) => (l) =>
	l.includes('"textDocument/didSave"') && l.includes(`/${file}"`);
const changeFor = (file) => (l) =>
	/"textDocument\/did(Open|Change)"/.test(l) && l.includes(`/${file}"`);

export async function setup(ctx) {
	const dir = process.env.VERIFY_CLANGD_DIR;
	if (!dir || !fs.existsSync(path.join(dir, "clangd")))
		throw new Error(
			"set VERIFY_CLANGD_DIR to a directory holding a clangd binary",
		);
	// Read by the MCP server's environment, which launchServer copies after setup.
	process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
	process.env.CLANGD_FLAGS = `--input-mirror-file=${process.env.VERIFY_LSP_WIRE}.in`;
	ctx.write("compile_flags.txt", "-xc\n-std=c11\n");
	ctx.write("a.c", "int main(void) { return undeclared_a; }\n");
	ctx.write("b.c", "int main(void) { return undeclared_b; }\n");
}

export async function run(ctx) {
	const control = await ctx.call(
		"pilens_diagnostics",
		{
			source: "lsp",
			scope: "paths",
			paths: ["a.c"],
			serverScope: "primary",
			waitMs: 5000,
			severity: "all",
		},
		"control: pilens_diagnostics a.c",
	);
	ctx.expect(
		"control: clangd answered for a.c",
		/undeclared_a/.test(control.text),
	);
	const controlSaves = ctx.lspWire(/didSave/).filter(saveFor("a.c")).length;
	ctx.expect(
		"control: the wire carries a didSave for a.c (the capture sees saves)",
		controlSaves >= 1,
		`${controlSaves} didSave(s)`,
	);

	await ctx.call("pilens_analyze", { file: "b.c" }, "analyze b.c");
	const first = ctx.lspWire(/didSave/).filter(saveFor("b.c")).length;
	ctx.expect(
		"analyze: the wire carries a didSave for b.c",
		first >= 1,
		`${first} didSave(s)`,
	);

	// Whole new text, so the incremental change carries the new name.
	ctx.write("b.c", "long value = undeclared_c + 1;\n");
	await ctx.call(
		"pilens_analyze",
		{ file: "b.c" },
		"analyze b.c after an edit",
	);
	const wire = ctx.lspWire(/textDocument\/did(Open|Change|Save)/);
	const saves = wire.filter(saveFor("b.c")).length;
	ctx.expect(
		"edit: the second analysis sends exactly one more didSave for b.c",
		saves === first + 1,
		`${first} then ${saves}`,
	);
	// The first push of the new bytes is the analysis's pre-touch. Later pushes
	// of the same bytes are the dispatch runner's re-push under its own debounce
	// key (the residual the #3405 PR names), not saves.
	const firstNewPush = wire.findIndex(
		(l) => changeFor("b.c")(l) && l.includes("undeclared_c"),
	);
	const lastSave = wire.findLastIndex(saveFor("b.c"));
	ctx.expect(
		"edit: the save follows the push of the new bytes",
		firstNewPush >= 0 && lastSave > firstNewPush,
		`first push of the new bytes #${firstNewPush}, save #${lastSave}`,
	);
}
