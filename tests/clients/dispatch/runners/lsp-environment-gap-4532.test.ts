/**
 * #4532 half 2: an environment gap is not a code defect.
 *
 * Recurrence it prevents: a pi session edited a file in a linked worktree that
 * had no `node_modules`. The `typescript` server rooted there published seven
 * severity-1 rows — TS2307 on `node:crypto`, TS2503 on `NodeJS`, and TS2304 for
 * the four timer globals — and pi-lens rendered them as `🔴 STOP — 7 issue(s)
 * must be fixed`. None of the seven was a defect in the edited file: the
 * worktree had no dependency install, so the server had no `@types/node`. The
 * agent cannot fix a missing install by editing code, and the blockers starved
 * the cascade (`cascade_skip reason=primary_has_blockers`).
 *
 * Real: the `lsp` dispatch runner, `convertLspDiagnostics`, the demotion seam
 * `clients/lsp/environment-gap.ts` sits in, and the runner's own result
 * semantics. Doubled only at the process boundary — the language server behind
 * `clients/lsp/capabilities.js`, installed through the real service lifecycle
 * seam rather than a module mock, so the runner's own `getLSPService()` call is
 * the one that runs.
 *
 * Fail-closed direction (AGENTS shape 69): the demotion admits a closed list of
 * (code, operand) pairs from the TypeScript server and refuses everything else,
 * so the cells below are half admitted forms and half refusals. A refusal cell
 * that demoted would hide a real type error, which is the harm this gate must
 * never cause. A missing module is admitted only as a Node built-in or a name a
 * `package.json` on the walk-up declares (#4532 round 5), so the refusal cells
 * name spellings the gate never lists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../../clients/lsp/capabilities.js";
import {
	ENVIRONMENT_GAP_MARKER,
	ENV_NODE_MODULES_WALK_MAX_LEVELS,
	hasResolvableNodeModules,
} from "../../../../clients/lsp/environment-gap.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";
import { installLspService } from "../../../support/lsp-service-seam.js";
import { setupTestEnvironment } from "../../test-utils.js";

type RawDiagnostic = {
	severity: number;
	message: string;
	code: number | string;
	source: string;
	serverId?: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
};

function atLine(line: number): RawDiagnostic["range"] {
	return {
		start: { line, character: 0 },
		end: { line, character: 24 },
	};
}

/** The seven rows the live session actually got, plus one real type error. */
function liveSessionRows(): RawDiagnostic[] {
	const ts = (code: number, message: string, line: number): RawDiagnostic => ({
		severity: 1,
		message,
		code,
		source: "ts",
		serverId: "typescript",
		range: atLine(line),
	});
	return [
		ts(
			2307,
			"Cannot find module 'node:crypto' or its corresponding type declarations.",
			3,
		),
		ts(2503, "Cannot find namespace 'NodeJS'.", 12),
		ts(2304, "Cannot find name 'setTimeout'.", 31),
		ts(2304, "Cannot find name 'clearTimeout'.", 32),
		ts(2304, "Cannot find name 'setInterval'.", 40),
		ts(2304, "Cannot find name 'clearInterval'.", 41),
		// The real defect in the same file: this one must keep blocking.
		ts(2322, "Type 'string' is not assignable to type 'number'.", 55),
	];
}

let env: { tmpDir: string; cleanup: () => void };
let root: string;
let file: string;
let rows: RawDiagnostic[];

function installService(): void {
	resetLSPService();
	installLspService(
		makeLspServiceDouble({
			supportsLSP: () => true,
			touchFile: async () => ({ diags: rows.map((row) => ({ ...row })) }),
			codeAction: async () => [],
		}),
	);
	getLSPService();
}

async function run(): Promise<
	Awaited<ReturnType<typeof lspRunner.run>> extends infer T
		? T extends undefined
			? never
			: T
		: never
> {
	const result = await lspRunner.run({
		filePath: file,
		cwd: root,
		fileRole: "source",
		pi: { getFlag: () => undefined },
	} as never);
	if (!result) throw new Error("the lsp runner returned no result");
	return result as never;
}

function finding(
	result: Awaited<ReturnType<typeof run>>,
	rule: string,
): { severity: string; semantic: string; message: string } | undefined {
	return result.diagnostics.find((item) => item.rule === rule) as
		| { severity: string; semantic: string; message: string }
		| undefined;
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-env-gap-4532-");
	root = path.join(env.tmpDir, "worktree");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	file = path.join(root, "src", "admission-limiter.ts");
	fs.writeFileSync(file, "export const x = 1;\n");
	rows = liveSessionRows();
	resetDegradationLedger();
	// Shape 73 (fixture adopts an ancestor root), CodeRabbit round 4: the walk
	// climbs 32 levels past the fixture, so an install anywhere in the temp
	// ancestry would red every demotion cell and make every blocking cell
	// vacuous. The premise is asserted, not assumed.
	expect(hasResolvableNodeModules(root)).toBe(false);
});

function missingModule(specifier: string, line: number): RawDiagnostic {
	return {
		severity: 1,
		message: `Cannot find module '${specifier}' or its corresponding type declarations.`,
		code: 2307,
		source: "ts",
		serverId: "typescript",
		range: atLine(line),
	};
}

function writeManifest(body: string): void {
	fs.writeFileSync(path.join(root, "package.json"), body);
}

afterEach(() => {
	resetLSPService();
	env.cleanup();
});

describe("a worktree with no dependency install (#4532)", () => {
	it("demotes the known environment-gap codes with a visible label and keeps the real code blocking", async () => {
		installService();
		const result = await run();

		const cryptoGap = finding(result, "ts:2307");
		const namespaceGap = finding(result, "ts:2503");
		const timerGap = finding(result, "ts:2304");
		const realError = finding(result, "ts:2322");

		// Demoted, never hidden: the finding is still there, at warning
		// authority, and says why in its own text.
		expect(cryptoGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(cryptoGap?.message).toContain(ENVIRONMENT_GAP_MARKER);
		expect(namespaceGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(namespaceGap?.message).toContain(ENVIRONMENT_GAP_MARKER);
		expect(timerGap).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
		expect(timerGap?.message).toContain(ENVIRONMENT_GAP_MARKER);

		// Fail closed: the file's own real type error still blocks, so the
		// result the agent sees is a blocker it can act on.
		expect(realError).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(realError?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
		expect(result.semantic).toBe("blocking");

		// One bounded record per admission kind: the ledger names what fired.
		const kinds = getDegradationSummary()
			.filter((group) => group.kind === "lsp-environment-gap-demoted")
			.flatMap((group) => group.latestReasons.map((entry) => entry.subject));
		expect(kinds).toContain("2307");
		expect(kinds).toContain("2503");
		expect(kinds).toContain("2304");
	});

	// CodeRabbit round 3: the main Node globals are reported with TS2580, or
	// TS2591 when `compilerOptions.types` is set — never with TS2304 — so the
	// four `NODE_GLOBALS` entries that matter most never matched. Fail-closed
	// direction kept: a name outside the closed list still blocks.
	it("demotes the TS2580/TS2591 forms of the main Node globals", async () => {
		const missingName = (
			code: number,
			name: string,
			line: number,
		): RawDiagnostic => ({
			severity: 1,
			message: `Cannot find name '${name}'. Do you need to install type definitions for node? Try \`npm i --save-dev @types/node\`.`,
			code,
			source: "ts",
			serverId: "typescript",
			range: atLine(line),
		});
		rows = [
			missingName(2580, "process", 7),
			missingName(2591, "require", 8),
			missingName(2580, "Buffer", 9),
			// Not a Node global: a real reference error keeps blocking.
			missingName(2580, "describe", 10),
		];
		installService();
		const result = await run();

		const admitted = result.diagnostics.filter((item) =>
			item.message.includes(ENVIRONMENT_GAP_MARKER),
		);
		expect(admitted).toHaveLength(3);
		expect(admitted.every((item) => item.severity === "warning")).toBe(true);
		expect(result.semantic).toBe("blocking");
		expect(
			result.diagnostics.some(
				(item) =>
					item.message.includes("'describe'") && item.semantic === "blocking",
			),
		).toBe(true);
	});

	// Greptile round 3 and CodeRabbit round 4, redesigned in round 5 (AGENTS.md
	// shape 69, second round on one gate): the enumerated gate refused `@/` and
	// demoted every alias it did not list, and this cell used to PIN that
	// (`@app/`, `~/` and `src/` asserted as demoted under a title saying the
	// opposite). The admit-list refuses them without naming them: no manifest
	// declares a path alias, and a misspelled import is not one either.
	it("keeps every path alias and undeclared name blocking, and demotes a declared package", async () => {
		writeManifest(
			JSON.stringify({
				dependencies: { "left-pad": "1.3.0", "@scope/pkg": "1.0.0" },
				devDependencies: {
					"@types/foo": "1.0.0",
					"@types/scope__bar": "1.0.0",
				},
				peerDependencies: { "peer-pkg": "1.0.0" },
				optionalDependencies: { "opt-pkg": "1.0.0" },
			}),
		);
		// A monorepo root's manifest declares what the install would hoist.
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { "hoisted-pkg": "1.0.0" } }),
		);
		const blocking = [
			"@/missing",
			"#internal/missing",
			"@app/missing",
			"~/missing",
			"src/missing",
			"components/missing",
			"left-pda",
		];
		const demoted = [
			"left-pad",
			"left-pad/lib/pad",
			"@scope/pkg/sub",
			"foo",
			"@scope/bar",
			"peer-pkg",
			"opt-pkg",
			"hoisted-pkg",
		];
		rows = [...blocking, ...demoted].map((specifier, index) =>
			missingModule(specifier, 3 + index),
		);
		installService();
		const result = await run();
		const rowFor = (specifier: string) =>
			result.diagnostics.find((item) =>
				item.message.includes(`'${specifier}'`),
			);

		for (const specifier of blocking) {
			expect(rowFor(specifier), specifier).toMatchObject({
				severity: "error",
				semantic: "blocking",
			});
		}
		for (const specifier of demoted) {
			expect(rowFor(specifier), specifier).toMatchObject({
				severity: "warning",
				semantic: "warning",
			});
			expect(rowFor(specifier)?.message).toContain(ENVIRONMENT_GAP_MARKER);
		}
	});

	// #4532 round 6 (verify r5, section 3): a manifest key that is not a package
	// name declared itself, so `""`, `"."`, `".."`, `"C:"`, an empty `@types/`
	// stem or an array's index keys made a project path (absolute, relative,
	// drive) demote. The admit-list now admits package-name spellings only; a
	// legacy capitalised name and yarn's `"~"` link key are real declarations
	// and still demote.
	it("declares nothing from a manifest key that is not a package name", async () => {
		writeManifest(
			JSON.stringify({
				dependencies: {
					"": "1.0.0",
					".": "1.0.0",
					"..": "1.0.0",
					"C:": "1.0.0",
					"@types/": "1.0.0",
					"@types/__": "1.0.0",
					"~": "link:./src",
					JSONStream: "1.0.0",
				},
				devDependencies: ["left-pad"],
				peerDependencies: "left-pad",
			}),
		);
		const blocking = [
			"/abs/missing",
			"./missing",
			"../missing",
			"C:/x/y",
			"0",
			"left-pad",
		];
		const demoted = ["~/missing", "JSONStream"];
		rows = [...blocking, ...demoted].map((specifier, index) =>
			missingModule(specifier, 3 + index),
		);
		installService();
		const result = await run();
		const rowFor = (specifier: string) =>
			result.diagnostics.find((item) =>
				item.message.includes(`'${specifier}'`),
			);
		for (const specifier of blocking) {
			expect(rowFor(specifier), specifier).toMatchObject({
				severity: "error",
				semantic: "blocking",
			});
		}
		for (const specifier of demoted) {
			expect(rowFor(specifier), specifier).toMatchObject({
				severity: "warning",
				semantic: "warning",
			});
		}
	});

	// The fail-closed half of the manifest read: a manifest the gate cannot read
	// declares nothing, so the import keeps blocking. A directory named
	// `package.json` stands in for an unreadable one on every platform.
	it("keeps a package import blocking when the manifest is absent, unreadable or malformed", async () => {
		const states: Array<[string, () => void]> = [
			["absent", () => undefined],
			[
				"unreadable",
				() =>
					fs.mkdirSync(path.join(root, "package.json"), { recursive: true }),
			],
			["malformed", () => writeManifest('{"dependencies": {"left-pad": ')],
		];
		for (const [state, plant] of states) {
			fs.rmSync(path.join(root, "package.json"), {
				recursive: true,
				force: true,
			});
			plant();
			rows = [missingModule("left-pad", 3)];
			installService();
			const result = await run();
			expect(finding(result, "ts:2307"), state).toMatchObject({
				severity: "error",
				semantic: "blocking",
			});
		}
	});

	// A Node built-in needs no manifest; a `node:` name that is not a built-in
	// is not one, whatever its prefix says.
	it("demotes a Node built-in with no manifest and keeps an unknown node: name blocking", async () => {
		rows = [
			missingModule("node:fs/promises", 3),
			missingModule("node:nope", 4),
		];
		installService();
		const result = await run();
		const rowFor = (specifier: string) =>
			result.diagnostics.find((item) =>
				item.message.includes(`'${specifier}'`),
			);
		expect(rowFor("node:fs/promises")).toMatchObject({ semantic: "warning" });
		expect(rowFor("node:nope")).toMatchObject({ semantic: "blocking" });
	});

	// Review F4: the severity and producer gates had no witness. A warning is
	// never relabelled (it was never a blocker), and a TS2307-shaped row from a
	// producer that is not the TypeScript server keeps its authority even when
	// it names no server.
	it("leaves a warning row and a non-TypeScript producer's row untouched", async () => {
		rows = [
			{ ...missingModule("node:crypto", 3), severity: 2 },
			{
				...missingModule("node:path", 4),
				source: "eslint",
				serverId: undefined,
			},
		];
		installService();
		const result = await run();
		const warning = result.diagnostics.find((item) =>
			item.message.includes("'node:crypto'"),
		);
		const foreign = result.diagnostics.find((item) =>
			item.message.includes("'node:path'"),
		);
		expect(warning?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
		expect(foreign).toMatchObject({ severity: "error", semantic: "blocking" });
		expect(foreign?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
	});

	it("keeps the install lookup's unreadable-directory and depth guards", () => {
		// An unreadable ancestor is not an absent one: the finding keeps its
		// published severity (fail closed).
		let calls = 0;
		const unreadable = hasResolvableNodeModules("/probe/root", () => {
			calls += 1;
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		expect(unreadable).toBe(true);
		expect(calls).toBe(1);
		// The 32-level cap is a depth bound, not a verdict: past it the question
		// is unanswered, so the finding stays blocking and the walk stops.
		calls = 0;
		const deep = `/${Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")}`;
		const capped = hasResolvableNodeModules(deep, () => {
			calls += 1;
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		expect(capped).toBe(true);
		expect(calls).toBe(ENV_NODE_MODULES_WALK_MAX_LEVELS);
	});

	it("keeps every code blocking when the root resolves a dependency install", async () => {
		fs.mkdirSync(path.join(root, "node_modules", "@types", "node"), {
			recursive: true,
		});
		installService();
		const result = await run();

		expect(finding(result, "ts:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(finding(result, "ts:2503")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
		expect(finding(result, "ts:2304")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	// LOW-2 (round 3): the reported symptom was `🔴 STOP — 7 issue(s)` from the
	// gap rows ALONE. The cell above stacks a real TS2322 beside them, so it
	// proves a blocker survives, never that the STOP goes away. This is the
	// reported shape with no real type error: only the environment-gap rows, so
	// the whole result must be non-blocking.
	it("reports the reported gap-only STOP shape as a warning, never a blocker", async () => {
		rows = liveSessionRows().filter((row) => row.code !== 2322);
		installService();
		const result = await run();

		expect(result.diagnostics).toHaveLength(rows.length);
		expect(result.semantic).toBe("warning");
		expect(
			result.diagnostics.every((item) => item.semantic === "warning"),
		).toBe(true);
		expect(
			result.diagnostics.filter((item) =>
				item.message.includes(ENVIRONMENT_GAP_MARKER),
			),
		).toHaveLength(rows.length);
	});

	it("keeps a namespace gap blocking when the namespace is not NodeJS", async () => {
		rows = [
			{
				severity: 1,
				message: "Cannot find namespace 'Deno'.",
				code: 2503,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2503")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps a module gap blocking when the specifier is project-relative", async () => {
		rows = [
			{
				severity: 1,
				message:
					"Cannot find module './missing' or its corresponding type declarations.",
				code: 2307,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps a missing name blocking when it is not a Node global", async () => {
		rows = [
			{
				severity: 1,
				message: "Cannot find name 'describe'.",
				code: 2304,
				source: "ts",
				serverId: "typescript",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "ts:2304")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("keeps an environment-shaped code blocking when another server produced it", async () => {
		rows = [
			{
				severity: 1,
				message:
					"Cannot find module 'node:crypto' or its corresponding type declarations.",
				code: 2307,
				source: "opentofu-ls",
				serverId: "opentofu",
				range: atLine(4),
			},
		];
		installService();
		const result = await run();
		expect(finding(result, "opentofu-ls:2307")).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});
});
