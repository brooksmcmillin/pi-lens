/**
 * `rules.<id>` read from each file's config owner (#5010 review round 3).
 *
 * A nested `.pi-lens.json` governs the files under it on every surface that
 * filters by rule policy: the per-edit dispatcher (`createDispatchContext` →
 * `ctx.rulePolicy`), and the multi-file surfaces that take a
 * `loadProjectRulePolicy` (lens_diagnostics, lsp_diagnostics, the pushed and
 * inline-blocker finding policies). Everything below drives real config files
 * on disk and the real resolver; only the runners and the LSP service are
 * stand-ins.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	applyPushedFindingPolicy,
	loadProjectRulePolicy,
} from "../../../clients/dispatch/finding-policy.js";
import { applyRulePolicy } from "../../../clients/dispatch/rule-policy.js";
import { parseHelmLintOutput } from "../../../clients/dispatch/runners/helm-lint.js";
import type {
	Diagnostic,
	RunnerDefinition,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { applyCascadeDisplayPolicy } from "../../../clients/cascade-format.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { applyInlineBlockerPolicy } from "../../../clients/inline-blocker-dispositions.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { clearWidgetState } from "../../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../../../tools/lsp-diagnostics.js";
import { useConfigPath } from "../../support/global-config.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

let tmpDir: string;
let repo: string;
let pkg: string;

function writeConfig(dir: string, config: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
}

function finding(filePath: string, rule = "no-eval"): Diagnostic {
	return {
		id: `${rule}:${filePath}`,
		message: rule,
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "ast-grep",
		rule,
		line: 1,
	};
}

function runnerReporting(diagnostics: Diagnostic[]): RunnerDefinition {
	return {
		id: "ast-grep",
		appliesTo: ["jsts"],
		priority: 10,
		async run() {
			return { status: "succeeded", diagnostics, semantic: "warning" };
		},
	};
}

/** Dispatch one file the way the pipeline does: `projectRoot` = the repo. */
async function dispatchUnderRepo(filePath: string): Promise<Diagnostic[]> {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "eval('1');\n");
	const registry = new RunnerRegistry();
	registry.register(runnerReporting([finding(filePath)]));
	const ctx = createDispatchContext(
		filePath,
		path.dirname(filePath),
		{ getFlag: () => false },
		new FactStore(),
		false,
		undefined,
		repo,
	);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["ast-grep"] }];
	return (await dispatchForFile(ctx, groups, registry)).diagnostics;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-owner-"));
	repo = path.join(tmpDir, "repo");
	pkg = path.join(repo, "pkg");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe("rules.<id> — dispatch reads the file's config owner", () => {
	it("control: with no nested rule the finding is delivered", async () => {
		writeConfig(pkg, { rules: { complexity: { threshold: 30 } } });

		const diagnostics = await dispatchUnderRepo(path.join(pkg, "a.ts"));

		expect(diagnostics.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	it("drops a rule a nested .pi-lens.json disables", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		expect(await dispatchUnderRepo(path.join(pkg, "a.ts"))).toEqual([]);
	});

	it("leaves a file outside the nested owner under the repo's own policy", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		const diagnostics = await dispatchUnderRepo(path.join(repo, "a.ts"));

		expect(diagnostics.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	it("still applies the repo root's policy to a file under the nested owner", async () => {
		writeConfig(repo, { rules: { "no-eval": { disable: ["no-eval"] } } });
		writeConfig(pkg, { rules: { complexity: { threshold: 30 } } });

		expect(await dispatchUnderRepo(path.join(pkg, "a.ts"))).toEqual([]);
	});

	it("matches a nested ignorePaths glob under the nested file's own directory", async () => {
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(await dispatchUnderRepo(path.join(pkg, "legacy", "a.ts"))).toEqual(
			[],
		);
		const kept = await dispatchUnderRepo(path.join(pkg, "src", "a.ts"));
		expect(kept.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	// PR #5011 round 5, F19 (greptile thread PRRT_kwDORt8rec6yJQYe): a config
	// directory named with glob magic (`pkg[1]`, Next.js `[id]`) anchored its
	// entries as `pkg[1]/legacy/**`, which minimatch reads as `pkg1/...`, so the
	// carve-out silently matched nothing under the real directory.
	it("anchors a nested ignorePaths glob under a config directory named with glob magic", async () => {
		const magic = path.join(repo, "pkg[1]");
		writeConfig(magic, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(await dispatchUnderRepo(path.join(magic, "legacy", "a.ts"))).toEqual(
			[],
		);
		const kept = await dispatchUnderRepo(path.join(magic, "src", "a.ts"));
		expect(kept.map((d) => d.rule)).toEqual(["no-eval"]);
	});
});

/**
 * PR #5011 round 8, F24 (greptile thread PRRT_kwDORt8rec6yLB8W): the dispatch
 * output filter applied the EDITED file's owner map to every finding, so a
 * runner that reports on several files (helm-lint attributes chart-level
 * findings to `Chart.yaml`, helm-lint.ts:55) had a nested `.pi-lens.json` hide
 * a finding outside its directory, and skip its own files when the edit was
 * elsewhere. Each case drives the real `createDispatchContext` +
 * `dispatchForFile`; only the runner is a stand-in.
 */
describe("rules.<id> — dispatch filters each finding by its own file's owner", () => {
	async function dispatchFindings(
		edited: string,
		diagnostics: (edited: string) => Diagnostic[],
		runnerId = "ast-grep",
	): Promise<string[]> {
		fs.mkdirSync(path.dirname(edited), { recursive: true });
		fs.writeFileSync(edited, "eval('1');\n");
		const registry = new RunnerRegistry();
		registry.register({
			...runnerReporting(diagnostics(edited)),
			id: runnerId,
			appliesTo: ["jsts", "helm-template"],
		});
		const ctx = createDispatchContext(
			edited,
			path.dirname(edited),
			{ getFlag: () => false },
			new FactStore(),
			false,
			undefined,
			repo,
		);
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: [runnerId] }];
		return (await dispatchForFile(ctx, groups, registry)).diagnostics
			.map((d) => path.relative(repo, d.filePath))
			.sort();
	}

	// Recurrence: F24 direction 1, a nested disable hid another package's finding.
	it("keeps a finding outside the nested owner when the edit is inside it", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });
		const other = path.join(repo, "other", "b.ts");

		const kept = await dispatchFindings(path.join(pkg, "a.ts"), (edited) => [
			finding(edited),
			finding(other),
		]);

		expect(kept).toEqual([path.join("other", "b.ts")]);
	});

	// Recurrence: F24 direction 2, the nested owner's disable skipped its own file.
	it("applies the nested owner's disable to its own file when the edit is elsewhere", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });
		const inPkg = path.join(pkg, "a.ts");

		const kept = await dispatchFindings(
			path.join(repo, "other", "b.ts"),
			(edited) => [finding(edited), finding(inPkg)],
		);

		expect(kept).toEqual([path.join("other", "b.ts")]);
	});

	// Recurrence: F24 live population, greptile's helm case: a chart-level error
	// parsed onto `chart/Chart.yaml` (helm-lint.ts:55) while the edit is a template.
	it("keeps a helm-lint chart-level error outside a templates/ owner that disables it", async () => {
		const chart = path.join(repo, "chart");
		fs.mkdirSync(chart, { recursive: true });
		fs.writeFileSync(path.join(chart, "Chart.yaml"), "name: chart\n");
		writeConfig(path.join(chart, "templates"), {
			rules: { helm: { disable: ["error"] } },
		});

		const kept = await dispatchFindings(
			path.join(chart, "templates", "deploy.yaml"),
			() =>
				parseHelmLintOutput(
					[
						"[ERROR] templates/deploy.yaml: unable to parse YAML",
						"[ERROR] chart metadata is missing these dependencies: sub",
					].join("\n"),
					chart,
				),
			"helm-lint",
		);

		expect(kept).toEqual([path.join("chart", "Chart.yaml")]);
	});

	// F24's rule for a finding with no file: the dispatcher stamps the edited
	// file on it before any filter (`normalizeDiagnosticFilePath`), so the
	// edited file's owner filters it. Recurrence: a stamp that fell back to the
	// workspace root would read the root's owner and deliver it.
	it("filters a finding with an empty filePath by the edited file's owner", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		const kept = await dispatchFindings(path.join(pkg, "a.ts"), () => [
			{ ...finding(""), filePath: "" },
		]);

		expect(kept).toEqual([]);
	});
});

describe("rules.<id> — a project policy reads each file's own owner", () => {
	const inRoot = () => path.join(repo, "legacy", "b.ts");
	const inPkgGenerated = () => path.join(pkg, "legacy", "a.ts");
	const inPkgSrc = () => path.join(pkg, "src", "c.ts");

	function keptFiles(diagnostics: Diagnostic[]): string[] {
		return applyRulePolicy(diagnostics, loadProjectRulePolicy(repo), {
			root: repo,
			filePath: repo,
		}).map((d) => path.relative(repo, d.filePath));
	}

	it("applies a nested disable to that package's files only", () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		expect(keptFiles([finding(inRoot()), finding(inPkgSrc())])).toEqual([
			path.relative(repo, inRoot()),
		]);
	});

	it("anchors a nested ignorePaths glob at the nested file's directory", () => {
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(
			keptFiles([
				finding(inRoot()),
				finding(inPkgGenerated()),
				finding(inPkgSrc()),
			]),
		).toEqual([path.relative(repo, inRoot()), path.relative(repo, inPkgSrc())]);
	});

	it("anchors a nested ignorePaths glob under a config directory named with glob magic", () => {
		const magic = path.join(repo, "pkg[1]");
		const neighbour = path.join(repo, "pkg1", "legacy", "n.ts");
		writeConfig(magic, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(
			keptFiles([
				finding(path.join(magic, "legacy", "a.ts")),
				finding(path.join(magic, "src", "c.ts")),
				finding(neighbour),
			]),
		).toEqual([
			path.relative(repo, path.join(magic, "src", "c.ts")),
			path.relative(repo, neighbour),
		]);
	});

	// PR #5011 round 6, F21 (CodeRabbit thread PRRT_kwDORt8rec6yKC-N):
	// minimatch.escape leaves `{ }` and a leading `!`. `{pkg,src}/legacy/**`
	// brace-expanded (the carve-out matched nothing under the real directory)
	// and `!docs/legacy/**` is a negation, which hid every finding under
	// `!docs/` that the carve-out never named. #5029 owns the meaning of a
	// user-authored `!`; this pins only the literal directory-name prefix.
	it.each([
		["!docs", "a leading bang"],
		["{pkg,src}", "braces"],
		["#pkg", "a leading hash"],
	])(
		"anchors a nested ignorePaths glob under a config directory named %s (%s)",
		(name) => {
			const dir = path.join(repo, name);
			const neighbour = path.join(repo, "src", "legacy", "n.ts");
			writeConfig(dir, {
				rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
			});

			expect(
				keptFiles([
					finding(path.join(dir, "legacy", "a.ts")),
					finding(path.join(dir, "src", "c.ts")),
					finding(neighbour),
				]),
			).toEqual([
				path.relative(repo, path.join(dir, "src", "c.ts")),
				path.relative(repo, neighbour),
			]);
		},
	);

	// PR #5011 round 8, F25 (CodeRabbit thread PRRT_kwDORt8rec6yLD-8): config
	// discovery records the nested document under its real path, and the
	// prefix was the lexical relative from a symlink-spelled root
	// (`../real/pkg`), so the carve-out matched nothing. lens_diagnostics hands
	// its tool cwd to `loadProjectRulePolicy` as spelled.
	it.skipIf(process.platform === "win32")(
		"anchors a nested ignorePaths glob under a root spelled through a symlink",
		() => {
			writeConfig(pkg, {
				rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
			});
			const link = path.join(tmpDir, "repo-link");
			fs.symlinkSync(repo, link, "dir");
			const files = [
				path.join(link, "legacy", "b.ts"),
				path.join(link, "pkg", "legacy", "a.ts"),
				path.join(link, "pkg", "src", "c.ts"),
			];

			const kept = applyRulePolicy(
				files.map((file) => finding(file)),
				loadProjectRulePolicy(link),
				{ root: link, filePath: link },
			).map((d) => path.relative(link, d.filePath));

			expect(kept).toEqual([
				path.join("legacy", "b.ts"),
				path.join("pkg", "src", "c.ts"),
			]);
		},
	);

	it("keeps the same glob text from two files as two carve-outs", () => {
		writeConfig(repo, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(
			keptFiles([
				finding(inRoot()),
				finding(inPkgGenerated()),
				finding(inPkgSrc()),
			]),
		).toEqual([path.relative(repo, inPkgSrc())]);
	});
});

describe("rules.<id> — lens_diagnostics source=lsp reads each file's owner", () => {
	const MESSAGE = "Type 'string' is not assignable to type 'number'.";

	beforeEach(() => clearWidgetState());
	afterEach(() => clearWidgetState());

	async function probe(paths: string[]): Promise<string> {
		for (const file of paths) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "const value: number = 'bad';\n");
		}
		const service = makeLspServiceDouble({
			touchFile: vi.fn(async () => ({
				diags: [
					{
						severity: 2,
						message: MESSAGE,
						source: "typescript",
						code: 2322,
						serverId: "typescript",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 11 },
						},
					},
				],
			})),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => repo,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-nested-owner",
			{ source: "lsp", scope: "paths", paths },
			new AbortController().signal,
			null,
			{ cwd: repo },
		)) as { content: Array<{ text: string }> };
		return result.content.map((part) => part.text).join("\n");
	}

	it("control: the repo root's own disable hides the finding", async () => {
		writeConfig(repo, { rules: { ts: { disable: ["typescript:2322"] } } });

		expect(await probe([path.join(repo, "app.ts")])).not.toContain(MESSAGE);
	});

	it("hides a finding a nested .pi-lens.json disables, and only under it", async () => {
		writeConfig(pkg, { rules: { ts: { disable: ["typescript:2322"] } } });

		expect(await probe([path.join(pkg, "app.ts")])).not.toContain(MESSAGE);
		expect(await probe([path.join(repo, "app.ts")])).toContain(MESSAGE);
	});
});

/**
 * #5011 verify round 3 (F11): four moved non-dispatch surfaces each read
 * `loadProjectRulePolicy(root)` and, reverted to the root's map, kept a finding
 * that a nested `.pi-lens.json` disables, with no red anywhere in the repo.
 * Each case drives the surface's real exported entry point against real config
 * files and asserts both a file under the nested owner (hidden) and one at the
 * repo root (kept). A surface handed the root's map fails the first assertion.
 */
describe("rules.<id> — the moved finding surfaces read each file's owner", () => {
	const PROBE_MESSAGE = "Type 'string' is not assignable to type 'number'.";
	const underPkg = () => path.join(pkg, "a.ts");
	const atRoot = () => path.join(repo, "a.ts");

	beforeEach(() => clearWidgetState());
	afterEach(() => clearWidgetState());

	/** A language-server ERROR as `convertLspDiagnostics` renders it (`typescript:2345`). */
	function lspError(): LSPDiagnostic {
		return {
			severity: 1,
			message:
				"Argument of type 'string' is not assignable to parameter of type 'number'.",
			source: "typescript",
			code: 2345,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 5 },
			},
		};
	}

	/** Write the file, then run the lsp_diagnostics tool over it (a fresh probe). */
	async function lspProbe(file: string): Promise<string> {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const value: number = 'bad';\n");
		const service = makeLspServiceDouble({
			touchFile: vi.fn(async () => ({
				diags: [
					{
						severity: 2,
						message: PROBE_MESSAGE,
						source: "typescript",
						code: 2322,
						serverId: "typescript",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 11 },
						},
					},
				],
			})),
		});
		const tool = createLspDiagnosticsTool(
			undefined,
			undefined,
			() => service as never,
		);
		const result = (await tool.execute(
			"lsp-nested-owner",
			{ path: file },
			new AbortController().signal,
			null,
			{ cwd: repo },
		)) as { content: Array<{ text: string }> };
		return result.content.map((part) => part.text).join("\n");
	}

	// Recurrence: F11 N13 (pushed findings, `applyPushedFindingPolicy` handed the root map).
	it("pushed findings: applyPushedFindingPolicy hides a nested disable under its own package only", () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		const nested = applyPushedFindingPolicy([finding(underPkg())], {
			cwd: repo,
			filePath: underPkg(),
			content: "eval('1');\n",
		});
		expect(nested.kept).toEqual([]);
		expect(nested.suppressed).toBe(1);

		const root = applyPushedFindingPolicy([finding(atRoot())], {
			cwd: repo,
			filePath: atRoot(),
			content: "eval('1');\n",
		});
		expect(root.kept.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	// Recurrence: F11 N14 (cascade format, `applyCascadeDisplayPolicy` handed the root map).
	it("cascade format: applyCascadeDisplayPolicy hides a nested disable under its own package only", () => {
		writeConfig(pkg, { rules: { ts: { disable: ["typescript:2345"] } } });

		const nested = applyCascadeDisplayPolicy([lspError()], {
			cwd: repo,
			policyRoot: repo,
			filePath: underPkg(),
			content: "const marked = 1;\n",
		});
		expect(nested.diagnostics).toEqual([]);
		expect(nested.suppressed).toBe(1);

		const root = applyCascadeDisplayPolicy([lspError()], {
			cwd: repo,
			policyRoot: repo,
			filePath: atRoot(),
			content: "const marked = 1;\n",
		});
		expect(root.diagnostics).toHaveLength(1);
	});

	// Recurrence: F11 N15 (inline blockers, `applyInlineBlockerPolicy` handed the root map).
	it("inline blockers: applyInlineBlockerPolicy hides a nested disable under its own package only", () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(underPkg(), "eval('1');\n");
		fs.writeFileSync(atRoot(), "eval('1');\n");

		const nested = applyInlineBlockerPolicy(
			{
				filePath: underPkg(),
				summary: "eval",
				diagnostics: [finding(underPkg())],
			},
			repo,
		);
		expect(nested.kept).toBe(0);
		expect(nested.body).toBeUndefined();

		const root = applyInlineBlockerPolicy(
			{ filePath: atRoot(), summary: "eval", diagnostics: [finding(atRoot())] },
			repo,
		);
		expect(root.kept).toBe(1);
	});

	// Recurrence: F11 N16 (lsp_diagnostics probe, `applyProbeFindingPolicy` handed the root map).
	it("lsp_diagnostics probe: hides a nested disable under its own package only", async () => {
		writeConfig(pkg, { rules: { ts: { disable: ["typescript:2322"] } } });

		expect(await lspProbe(underPkg())).not.toContain(PROBE_MESSAGE);
		expect(await lspProbe(atRoot())).toContain(PROBE_MESSAGE);
	});
});
