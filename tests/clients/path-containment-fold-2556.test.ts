/**
 * #2556's remainder: every lexical containment answer in `clients/` comes from
 * `relativeInside` (and `isWithinIdentity` for the identity axis), so the
 * hand-rolled copies are gone. Each cell enters through a site's production
 * export and states the answer the seam must give; the recurrence is the
 * copies' two measured drifts (shape 83): `path.relative` text tested with a
 * bare `..` prefix, or without an `isAbsolute` arm.
 *
 * Expectations are spelled by hand (a literal relative text or verdict), never
 * recomputed with `path.relative`, so a cell cannot restate the code it checks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { isRuleIgnoredForPath } from "../../clients/dispatch/rule-ignores.js";
import { toRunnerDisplayPath } from "../../clients/dispatch/runner-context.js";
import { resolveTemplateSource } from "../../clients/dispatch/runners/helm-render.js";
import { parseHelmLintOutput } from "../../clients/dispatch/runners/helm-lint.js";
import {
	loadWorkspaceDiagnosticsCache,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
	clearWorkspaceDiagnosticsCacheAtAndAbove,
} from "../../clients/lsp/workspace-diagnostics-cache.js";
import {
	isAtOrAboveHomeDir,
	isWithinIdentity,
	normalizeMapKey,
	relativeInside,
} from "../../clients/path-utils.js";
import { isExcludedTestTarget } from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
beforeEach(() => {
	env = setupTestEnvironment("pi-lens-containment-fold-");
	root = fs.realpathSync(env.tmpDir);
});
afterEach(() => env.cleanup());

function touch(...segments: string[]): string {
	const file = path.join(root, ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "x\n");
	return file;
}

describe("relativeInside (the seam)", () => {
	it.each([
		{
			label: "posix",
			impl: path.posix,
			base: "/repo",
			cases: [
				["/repo/src/a.ts", "src/a.ts"],
				["/repo", ""],
				["/repo/..pkg/a.ts", "..pkg/a.ts"],
				["/repo/../other/a.ts", undefined],
				["/", undefined],
				["/repository/a.ts", undefined],
			],
		},
		{
			label: "win32",
			impl: path.win32,
			base: "C:\\repo",
			cases: [
				["C:\\repo\\src\\a.ts", "src/a.ts"],
				["c:\\REPO\\src\\a.ts", "src/a.ts"],
				["C:\\repo", ""],
				["C:\\repo\\..pkg\\a.ts", "..pkg/a.ts"],
				["D:\\repo\\a.ts", undefined],
				["C:\\other\\a.ts", undefined],
			],
		},
	] as const)(
		"answers $label containment from the path.relative text",
		({ impl, base, cases }) => {
			for (const [file, expected] of cases)
				expect(relativeInside(base, file, impl as typeof path), file).toBe(
					expected,
				);
		},
	);

	it("reads a home inside a directory named '..cfg' as at or above it", () => {
		// Recurrence: `!rel.startsWith("..")` read `<dir>/..cfg` as outside (#4835).
		expect(isAtOrAboveHomeDir("/h", "/h/..cfg", path.posix)).toBe(true);
		expect(isAtOrAboveHomeDir("/h/x", "/h", path.posix)).toBe(false);
		expect(isAtOrAboveHomeDir("C:\\h", "D:\\h", path.win32)).toBe(false);
	});
});

describe("turn-state key", () => {
	it("keys an in-tree file relative and everything else absolute", () => {
		const cache = new CacheManager();
		expect(cache.toTurnStateKey(path.join(root, "..pkg", "a.ts"), root)).toBe(
			"..pkg/a.ts",
		);
		expect(cache.toTurnStateKey(path.dirname(root), root)).toBe(
			normalizeMapKey(path.dirname(root)),
		);
		expect(cache.toTurnStateKey(root, root)).toBe(normalizeMapKey(root));
	});
});

describe("runner display path", () => {
	it("keeps the cwd's own parent absolute, not as '..'", () => {
		// Recurrence: the copy tested `startsWith("../")` and returned ".." for
		// the parent itself (no trailing separator).
		touch("..pkg", "a.ts");
		expect(toRunnerDisplayPath(root, path.join(root, "..pkg", "a.ts"))).toBe(
			"..pkg/a.ts",
		);
		expect(toRunnerDisplayPath(root, path.dirname(root))).toBe(
			normalizeMapKey(path.dirname(root)),
		);
	});
});

describe("rule ignores", () => {
	it("applies a directory carve-out inside the root and never across drives", () => {
		expect(
			isRuleIgnoredForPath("/repo/..pkg/a.ts", "/repo", ["..pkg/**"]),
		).toBe(true);
		expect(
			isRuleIgnoredForPath("/elsewhere/src/a.ts", "/repo", ["src/**"]),
		).toBe(false);
		expect(
			isRuleIgnoredForPath("D:\\repo\\src\\a.ts", "C:\\repo", ["**/src/**"]),
		).toBe(false);
		expect(
			isRuleIgnoredForPath("C:\\repo\\src\\a.ts", "C:\\repo", ["**/src/**"]),
		).toBe(true);
	});
});

describe("helm chart containment", () => {
	it("resolves a template inside the chart and refuses one that escapes", () => {
		const chart = path.join(root, "chart");
		const inside = touch("chart", "templates", "ok.yaml");
		touch("outside", "evil.yaml");
		expect(resolveTemplateSource("chart/templates/ok.yaml", chart)).toBe(
			inside,
		);
		expect(
			resolveTemplateSource("chart/../../outside/evil.yaml", chart),
		).toBeNull();
	});

	it.skipIf(process.platform === "win32")(
		// lane: dev-box-only — a symlink needs privilege on the Windows lanes.
		"refuses a template reached through a linked directory that points out of the chart",
		() => {
			const chart = path.join(root, "chart");
			fs.mkdirSync(chart, { recursive: true });
			touch("outside", "evil.yaml");
			fs.symlinkSync(path.join(root, "outside"), path.join(chart, "templates"));
			expect(
				resolveTemplateSource("chart/templates/evil.yaml", chart),
			).toBeNull();
		},
	);

	it("maps a lint message to a chart file only when the file is inside the chart", () => {
		const chart = path.join(root, "chart");
		const [escaped] = parseHelmLintOutput(
			"[ERROR] ../escape.yaml: unable to parse",
			chart,
		);
		expect(escaped?.filePath).toBe(path.join(chart, "Chart.yaml"));
		const [local] = parseHelmLintOutput(
			"[ERROR] templates/..odd.yaml: unable to parse",
			chart,
		);
		expect(local?.filePath).toBe(path.join(chart, "templates", "..odd.yaml"));
	});

	it.skipIf(process.platform === "win32")(
		// lane: dev-box-only — a symlink needs privilege on the Windows lanes.
		"isWithinIdentity reads a real link spelling out of the root and into it",
		() => {
			// Recurrence: the cell below spells every operand literally, so a
			// lexical `isWithinForm(normalizePathSpelling(...))` passes it. The
			// seam's contract is the identity axis in BOTH directions: a
			// lexically-inside link out of the root reads outside, and a
			// lexically-outside link that lands in the root reads inside.
			const chart = path.join(root, "chart");
			const alias = path.join(root, "alias");
			fs.mkdirSync(chart, { recursive: true });
			touch("outside", "evil.yaml");
			touch("real", "a.ts");
			try {
				fs.symlinkSync(path.join(root, "outside"), path.join(chart, "linked"));
				fs.symlinkSync(path.join(root, "real"), alias);
				// Both verdicts in one assertion, so one red shows both directions.
				expect({
					linkedOut: isWithinIdentity(
						path.join(chart, "linked", "evil.yaml"),
						chart,
					),
					linkedIn: isWithinIdentity(
						path.join(alias, "a.ts"),
						path.join(root, "real"),
					),
				}).toEqual({ linkedOut: false, linkedIn: true });
			} finally {
				fs.rmSync(path.join(chart, "linked"), { force: true });
				fs.rmSync(alias, { force: true });
			}
		},
	);

	it("isWithinIdentity meets a link spelling at its target and nothing else", () => {
		touch("real", "a.ts");
		expect(
			isWithinIdentity(
				path.join(root, "real", "a.ts"),
				path.join(root, "real"),
			),
		).toBe(true);
		expect(
			isWithinIdentity(path.join(root, "real"), path.join(root, "real")),
		).toBe(true);
		expect(
			isWithinIdentity(
				path.join(root, "realm", "a.ts"),
				path.join(root, "real"),
			),
		).toBe(false);
	});
});

describe("workspace diagnostics cache ancestor clear", () => {
	function seed(dir: string): void {
		fs.mkdirSync(dir, { recursive: true });
		saveWorkspaceDiagnosticsCache(dir, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[normalizeMapKey(path.join(dir, "f.ts"))]: {
					diagnostics: [{ message: "m", serverId: "typescript" } as never],
					count: 1,
					mtimeMs: 1,
					scannedAt: Date.now(),
					scopeKey: "all|",
				},
			},
		});
	}
	const entries = (dir: string): number =>
		Object.keys(loadWorkspaceDiagnosticsCache(dir)?.entries ?? {}).length;

	it("clears up to the ceiling and stops there", () => {
		const ceiling = path.join(root, "ws");
		const mid = path.join(ceiling, "..pkg");
		const member = path.join(mid, "member");
		for (const dir of [root, ceiling, mid, member]) seed(dir);
		clearWorkspaceDiagnosticsCacheAtAndAbove(member, ceiling);
		expect([entries(member), entries(mid), entries(ceiling)]).toEqual([
			0, 0, 0,
		]);
		expect(entries(root)).toBe(1);
	});

	it("clears only the client root when it is outside the ceiling", () => {
		const ceiling = path.join(root, "ws");
		const outside = path.join(root, "elsewhere", "pkg");
		for (const dir of [root, ceiling, path.dirname(outside), outside])
			seed(dir);
		clearWorkspaceDiagnosticsCacheAtAndAbove(outside, ceiling);
		expect(entries(outside)).toBe(0);
		expect([
			entries(path.dirname(outside)),
			entries(ceiling),
			entries(root),
		]).toEqual([1, 1, 1]);
	});
});

describe("turn-end test target exclusion", () => {
	it("excludes the project root and an out-of-tree target, not a '..pkg' one", () => {
		const target = touch("..pkg", "a.test.ts");
		expect(isExcludedTestTarget(target, root)).toBe(false);
		expect(isExcludedTestTarget(root, root)).toBe(true);
		expect(
			isExcludedTestTarget(path.join(path.dirname(root), "x.test.ts"), root),
		).toBe(true);
	});
});
