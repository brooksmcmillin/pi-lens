/**
 * The inline separator fold has one owner: `toPosix` (clients/path-utils.ts).
 *
 * Recurrence this file prevents (docs/invariants/paths-os.md, AGENTS.md shape
 * 2): before this change 38 production sites hand-rolled `p.replace(/\\/g, "/")`
 * beside the sanctioned `toPosix`, so a change to the fold (or a site that
 * drifted from it) had 38 places to disagree. Each cell below drives one
 * former bypass site through its exported production caller with a
 * backslash-spelled input and asserts the folded, user-visible answer. The
 * expected values are independent of `toPosix`'s own source: they are what the
 * pre-fold build answered (probed through the built twins of both trees), so a
 * `toPosix` that stops folding reds every cell, and a site routed around the
 * seam keeps its own regex and is caught by a seam mutation only if it is
 * listed here.
 *
 * Not driven here, with the reason (a cell that stays green with `toPosix`
 * broken is a vacuous witness and was deleted):
 * - `path.relative(...)` folds, whose output carries a backslash only on win32
 *   (a POSIX literal backslash in a name is already folded upstream by
 *   `normalizeMapKey`): finding-identity.ts `relativeFile`, runner-context.ts
 *   `toRunnerDisplayPath`, cache-manager.ts `toTurnStateKey`, lsp/edits.ts
 *   `relativeToCwd`, lsp/index.ts rename description,
 *   actionable-warnings.ts `legacyActionableWarningId`,
 *   test-runner-client.ts glob path, file-utils.ts `displayProjectDataPath`.
 * - private, no exported route that carries a backslash, or a constant input:
 *   config-locations.ts `isLspScoped`, lsp/client.ts
 *   `fileOperationUriCandidates`, lsp/server.ts `markerExists`, tool-cwd.ts
 *   `walkMarkerRoot`, dispatch/integration.ts cascade neighbours and
 *   `getAvailableRunners`, lens-engine.ts `recentLatency`, resolved-config.ts
 *   `isLegacyLspFile`, tools/lsp-navigation.ts latency phase.
 * - file-utils.ts `isTestFile`: no predicate it applies reads a separator, so
 *   its fold is unobservable (routed through `toPosix` all the same; #5013 F5
 *   proved it dead and deferred the deletion, see the PR's accepted residuals).
 * One more was deleted outright because its fold was a no-op: file-role.ts (a
 * second fold of the already-folded `dir`).
 *
 * The other two folds this PR could not witness at first are driven from the
 * files that already own their harness rather than here, because each needs a
 * service or graph double this file does not carry: dispatch/integration.ts's
 * cascade neighbour path (tests/clients/cascade-compute.test.ts) and
 * lsp/index.ts's rename description (tests/clients/lsp/service-rename-file.test.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRuleIgnoredForPath } from "../../clients/dispatch/rule-ignores.js";
import { isGitHubWorkflowFile } from "../../clients/dispatch/runners/actionlint.js";
import { resolveRunnerPath } from "../../clients/dispatch/runner-context.js";
import {
	inferFeatureKind,
	inferTrustBoundaries,
} from "../../clients/feature-hints.js";
import { detectFileRole } from "../../clients/file-role.js";
import { isGitCommitOrPushAttempt } from "../../clients/git-guard.js";
import { validateWorkspaceEdit } from "../../clients/lsp/edits.js";
import { resolveRebuildScript } from "../../clients/mcp/review.js";
import {
	buildModuleGraph,
	clearModuleGraphCache,
} from "../../clients/review-graph/workspace-modules.js";
import { scanProjectRules } from "../../clients/rules-scanner.js";
import { isDisabledQueryFilePath } from "../../clients/tree-sitter-query-loader.js";
import { isZizmorAuditTarget } from "../../clients/zizmor-config.js";
import { setupTestEnvironment } from "./test-utils.js";

const BS = "\\";
/** Join with a backslash, the Windows spelling these sites exist for. */
const bs = (...parts: string[]): string => parts.join(BS);

describe('toPosix fold sites: former inline `.replace(/\\\\/g, "/")` callers', () => {
	const env = setupTestEnvironment("pi-lens-to-posix-fold-");
	const fx = env.tmpDir;

	beforeAll(() => {
		clearModuleGraphCache();
	});
	afterAll(() => {
		clearModuleGraphCache();
		env.cleanup();
	});

	it("actionlint folds a backslash workflow path (actionlint.ts)", () => {
		expect(isGitHubWorkflowFile(bs(".github", "workflows", "ci.yml"))).toBe(
			true,
		);
		expect(isGitHubWorkflowFile(bs("x", "workflows", "ci.yml"))).toBe(false);
	});

	it("zizmor folds a backslash workflow path (zizmor-config.ts)", () => {
		expect(
			isZizmorAuditTarget(bs("repo", ".github", "workflows", "ci.yaml")),
		).toBe(true);
	});

	it("tree-sitter query loader reads the parent of a backslash path (tree-sitter-query-loader.ts)", () => {
		expect(isDisabledQueryFilePath(bs("queries", "go-disabled", "x.scm"))).toBe(
			true,
		);
		expect(isDisabledQueryFilePath(bs("queries", "go", "x.scm"))).toBe(false);
	});

	it("file role classifies Windows-shaped dirs after the fold (file-role.ts)", () => {
		expect(
			detectFileRole(bs("C:", "proj", "migrations", "sub", "001_init.sql")),
		).toBe("migration");
		expect(detectFileRole(bs("C:", "proj", "src", "__tests__", "a.ts"))).toBe(
			"test",
		);
		expect(detectFileRole(bs("C:", "proj", "src", "a.ts"))).toBe("source");
	});

	it("runner path strips a leading cwd basename spelled with a backslash (runner-context.ts)", () => {
		fs.mkdirSync(path.join(fx, "src"), { recursive: true });
		fs.writeFileSync(path.join(fx, "src", "a.ts"), "x");
		const resolved = resolveRunnerPath(
			fx,
			bs(path.basename(fx), "src", "a.ts"),
		);
		expect(path.relative(fx, resolved)).toBe(path.join("src", "a.ts"));
	});

	it("rule ignores match a Windows-shaped relative path with a posix glob (rule-ignores.ts)", () => {
		expect(
			isRuleIgnoredForPath(bs("C:", "proj", "cli", "x.ts"), bs("C:", "proj"), [
				"cli/**",
			]),
		).toBe(true);
		expect(
			isRuleIgnoredForPath(bs("D:", "other", "x.log"), bs("C:", "proj"), [
				"D:/other/*.log",
			]),
		).toBe(true);
	});

	it("MCP rebuild script reads a Windows server path (mcp/review.ts)", () => {
		expect(
			resolveRebuildScript(bs("C:", "repo", "dist", "mcp", "server.js")),
		).toBe("build:dist");
		expect(resolveRebuildScript(bs("C:", "repo", "mcp", "server.js"))).toBe(
			"build",
		);
	});

	it("git guard recognises git behind a Windows path and a Windows shell wrapper (git-guard.ts)", () => {
		const attempt = (command: string): boolean =>
			isGitCommitOrPushAttempt("bash", { command });
		expect(attempt(`C:${BS}tools${BS}git.exe commit -m x`)).toBe(true);
		expect(attempt(`C:${BS}Windows${BS}bash.exe -c 'git push'`)).toBe(true);
		expect(attempt(`C:${BS}tools${BS}gitx.exe commit -m x`)).toBe(false);
	});

	it("a rename whose two spellings differ only by separator is refused (lsp/edits.ts preflight)", async () => {
		// The preflight folds the two resolved disk paths and throws before any read
		// (`preflightWorkspaceEdit`'s rename arm), so neither spelling needs to
		// exist, and both URIs are built through `pathToFileURL` so the fixture is
		// valid on a Windows host too — there a backslash is a separator, not a
		// file-name character (#5013 F2).
		await expect(
			validateWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(path.join(fx, `a${BS}r.ts`)).href,
							newUri: pathToFileURL(path.join(fx, "a", "r.ts")).href,
						},
					],
				},
				fx,
			),
		).rejects.toThrow("rename source and destination must differ");
	});

	it("feature hints read a backslash path as segments (feature-hints.ts)", () => {
		expect(inferFeatureKind(bs("src", "cli", "main.ts"))).toBe("cli-command");
		expect(inferTrustBoundaries(bs("src", "db", "x.ts"))).toEqual([
			"filesystem",
			"database",
		]);
	});

	it("workspace modules expand a backslash workspace glob and fold the relative path (review-graph/workspace-modules.ts)", () => {
		const ws = path.join(fx, "ws");
		fs.mkdirSync(path.join(ws, "packages", "a"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, "package.json"),
			JSON.stringify({ name: "r", workspaces: [bs("packages", "*")] }),
		);
		fs.writeFileSync(
			path.join(ws, "packages", "a", "package.json"),
			JSON.stringify({ name: "a" }),
		);
		const weird = path.join(fx, "ws2");
		// The module's `relativePath` fold is load-bearing only where the host's
		// `path.relative` can spell a separator as a backslash: on win32 for any
		// nested module, on POSIX only through a literal backslash inside one
		// directory's name. Each host gets the spelling that makes the fold do work,
		// and the one `packages/*` glob matches both (#5013 F2).
		const weirdDir = process.platform === "win32" ? "weird" : `we${BS}ird`;
		const weirdRel =
			process.platform === "win32" ? "packages/weird" : "packages/we/ird";
		fs.mkdirSync(path.join(weird, "packages", weirdDir), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(weird, "packages", weirdDir, "package.json"),
			JSON.stringify({ name: "weird" }),
		);
		fs.writeFileSync(
			path.join(weird, "package.json"),
			JSON.stringify({ name: "r2", workspaces: ["packages/*"] }),
		);
		const describeModules = (cwd: string): string[] => {
			clearModuleGraphCache();
			const graph = buildModuleGraph(cwd);
			return graph
				? [...graph.modules.values()]
						.map((m) => `${m.name}@${m.relativePath}`)
						.sort()
				: [];
		};
		expect(describeModules(ws)).toEqual(["a@packages/a"]);
		expect(describeModules(weird)).toEqual([`weird@${weirdRel}`]);
	});

	it("project rules scan folds a backslash directory name (rules-scanner.ts)", () => {
		const rr = path.join(fx, "rr");
		// `sub\dir` is one directory whose name contains a backslash on POSIX and
		// two nested directories on win32, where `path.relative` spells the
		// separators with backslashes anyway; the fold is load-bearing on both
		// (#5013 F2).
		fs.mkdirSync(path.join(rr, ".claude", "rules", `sub${BS}dir`), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(rr, ".claude", "rules", `sub${BS}dir`, "r.md"),
			"# r\n",
		);
		expect(scanProjectRules(rr).rules.map((r) => r.relativePath)).toEqual([
			".claude/rules/sub/dir/r.md",
		]);
	});
});
