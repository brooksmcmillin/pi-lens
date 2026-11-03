// flake-shape: real-process-spawn — the subject is what a REAL tool another extension registers writes into a REAL git checkout, and the detector under test is git's own `status --porcelain`; a stubbed git could not say whether the write was seen.
/**
 * #4732 witness: a file written by a tool that is not `bash` is recovered,
 * published and dispatched like an opaque bash write.
 *
 * The defect: the opaque before/after diff ran only for `toolName === "bash"`.
 * A tool another extension registers (or an MCP tool routed through pi, or the
 * outer codemode call) that writes a file without naming it in a path field
 * was never diffed, so the file reached no diagnostic.
 *
 * What is REAL here: pi's own tool loop runs a tool registered through pi's
 * `customTools` option, so the write is a real write by a tool pi-lens has
 * never met; the BUILT extension's registered `tool_call` and `tool_result`
 * handlers; the real `git status` recovery; the disk-change publisher; and the
 * real tree-sitter dispatch behind the synthetic write. Scripted is the model
 * only, at the provider boundary.
 *
 * The delivered effect is the DISPATCHER's own `runner` record for the file
 * (rule `debugger-statement`). An opaque recovered write issues no model-facing
 * blocker (it is not the agent's edit), so the tool text is not where it shows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import { normalizeMapKey } from "../clients/path-utils.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const DISPATCH_RULE = "debugger-statement";
const BLOCKING = "export function f() {\n\tdebugger;\n}\n";

const fixture = piSessionFixture();

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
	git(["init", "-q"], dir);
	git(["config", "user.email", "t@t.local"], dir);
	git(["config", "user.name", "t"], dir);
	git(["add", "-A"], dir);
	git(["commit", "-qm", "base"], dir);
	return fs.realpathSync.native(dir);
}

interface Row {
	type?: string;
	phase?: string;
	filePath?: string;
	result?: string;
	diagnostics?: Array<{ rule?: string }>;
}

/**
 * A code generator another extension might register: it takes a module name,
 * not a path, and writes `<name>.ts` into the directory it runs in.
 */
function generatorTool(repo: string): ToolDefinition {
	return {
		name: "gen_module",
		label: "Generate module",
		description: "Generate a TypeScript module by name.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_toolCallId, params) {
			const { name } = params as { name: string };
			fs.writeFileSync(path.join(repo, `${name}.ts`), BLOCKING);
			return {
				content: [{ type: "text", text: `generated ${name}` }],
				details: undefined,
			};
		},
	};
}

describe("a write by a tool that is not bash (#4732)", () => {
	it(
		"recovers, publishes and dispatches a file another extension's tool wrote",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "ext-tool");
			const repo = initRepo(path.join(root, "proj"));
			const target = path.join(repo, "generated.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				customTools: [generatorTool(repo)],
				responses: [
					step(fauxToolCall("gen_module", { name: "generated" })),
					endTurn(),
				],
			});
			await session.prompt("generate the module");

			// The tool really ran through pi's loop: the defect was detection.
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);

			const read = await session.latencyRows();
			expect(read.skipped).toBe(0);
			const rows = read.rows as Row[];
			// The prescan names the tool, the recovery the file it wrote.
			expect(
				rows
					.filter((row) => row.phase === "opaque_mutation_prescan")
					.map((row) => row.filePath),
			).toEqual(["gen_module"]);
			expect(
				rows
					.filter(
						(row) =>
							row.phase === "opaque_mutation_recovered" &&
							(row.filePath ?? "").includes("generated.ts"),
					)
					.map((row) => row.result),
			).toEqual(["changed:1"]);
			expect(
				rows
					.filter(
						(row) =>
							row.phase === "disk_change_published" && row.filePath === repo,
					)
					.map((row) => row.result),
			).toContain("bash-recovery:1");
			// DELIVERY: the recovered bytes reached a dispatcher.
			const key = normalizeMapKey(target);
			expect(
				rows
					.filter(
						(row) =>
							row.type === "runner" &&
							row.filePath !== undefined &&
							normalizeMapKey(row.filePath) === key,
					)
					.flatMap((row) => (row.diagnostics ?? []).map((d) => d.rule)),
			).toContain(DISPATCH_RULE);
		},
	);
});
