/**
 * #1030 regression — monorepo disposition base-directory divergence.
 *
 * The mark tool (lens-diagnostic-mark) writes dispositions keyed on the PROJECT
 * ROOT (`runtime.projectRoot`). The per-edit dispatch read path used to key the
 * disposition filter on `ctx.cwd`, which `createDispatchContext` resolves to the
 * nearest LANGUAGE ROOT (`resolveLanguageRootForFile` — a nested `tsconfig.json`/
 * `package.json` dir in a monorepo). Because both the anchor AND the store
 * location (`getProjectDataDir`) are keyed on that base, write and read hit
 * DIFFERENT `diagnostic-dispositions.json` files with DIFFERENT anchors, so every
 * false-positive/flagged/defer mark on a file under a nested marker silently
 * no-op'd (#533 invisible-mark class).
 *
 * These tests drive the real dispatch pipeline (dispatchForFile) against a nested
 * language-root fixture and assert the mark is honored. Pre-fix the diagnostic
 * reappears (different anchor + different store); with the fix (read from
 * `ctx.projectRoot`) it is filtered. The single-project case (language root ==
 * project root) is asserted unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	getDisposition,
	markDisposition,
} from "../../../clients/diagnostic-dispositions.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../../clients/file-utils.js";
import { dataDir444 } from "../../support/data-dir-4-4-4.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
import { removeTempDirSync } from "../test-utils.js";

let tmpDir: string;
let previousDataDir: string | undefined;

const FILE_CONTENT = "export const target = bad();\n";
const DIAG = {
	tool: "eslint",
	rule: "no-bad",
	message: "bad call",
	line: 1,
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1030-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	// Isolated store so the test never touches the real disposition state.
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearCoverageNoticeState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetStateCacheForTests();
	removeTempDirSync(tmpDir);
});

/** A runner that always reports the single diagnostic the mark targets. */
function reporterFor(fileAbs: string): RunnerRegistry {
	const registry = new RunnerRegistry();
	registry.register(
		createMockRunner({
			id: "eslint",
			appliesTo: ["jsts"],
			runResult: {
				status: "succeeded",
				diagnostics: [
					{
						id: "diag-1",
						message: DIAG.message,
						filePath: fileAbs,
						line: DIAG.line,
						severity: "warning",
						semantic: "warning",
						tool: DIAG.tool,
						rule: DIAG.rule,
					},
				],
				semantic: "warning",
			},
		}),
	);
	return registry;
}

async function runDispatch(
	fileAbs: string,
	projectRoot: string,
): Promise<{ ctx: ReturnType<typeof createDispatchContext>; count: number }> {
	const facts = new FactStore();
	const ctx = createDispatchContext(
		fileAbs,
		projectRoot,
		{ getFlag: () => false },
		facts,
	);
	// The strict (false-positive) anchor hashes the diagnostic's own line from
	// the file content the dispatcher reads out of the fact store — seed it with
	// the same content the mark was recorded against.
	facts.setFileFact(ctx.filePath, "file.content", FILE_CONTENT);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["eslint"] }];
	const result = await dispatchForFile(ctx, groups, reporterFor(fileAbs));
	return { ctx, count: result.diagnostics.length };
}

describe("#1030 disposition base divergence (monorepo nested language root)", () => {
	it("honors a project-root false-positive mark on a file under a nested language root", async () => {
		const projectRoot = path.join(tmpDir, "project");
		const appRoot = path.join(projectRoot, "packages", "app");
		const srcDir = path.join(appRoot, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// Nested marker → resolveLanguageRootForFile picks packages/app, not root.
		fs.writeFileSync(path.join(appRoot, "tsconfig.json"), "{}\n");
		const fileAbs = path.join(srcDir, "x.ts");
		fs.writeFileSync(fileAbs, FILE_CONTENT);

		// WRITE exactly as the mark tool does: base = project root.
		markDisposition(
			projectRoot,
			{ cwd: projectRoot, filePath: fileAbs, ...DIAG, content: FILE_CONTENT },
			"false-positive",
		);
		_resetStateCacheForTests();

		const { ctx, count } = await runDispatch(fileAbs, projectRoot);

		// The divergence the bug rides on must actually be present in this fixture:
		// dispatch resolves cwd to the nested language root, distinct from the root.
		expect(ctx.projectRoot).toBeDefined();
		expect(ctx.cwd).not.toBe(ctx.projectRoot);
		expect(ctx.cwd.toLowerCase()).toContain("packages/app");
		expect((ctx.projectRoot ?? "").toLowerCase().endsWith("/project")).toBe(
			true,
		);

		// Fix: dispatch reads dispositions from the project root, so the mark is
		// found and the diagnostic is filtered. Pre-fix this is 1 (mark invisible).
		expect(count).toBe(0);
	});

	it("still honors the mark when the language root IS the project root (single-project unchanged)", async () => {
		const projectRoot = path.join(tmpDir, "solo");
		const srcDir = path.join(projectRoot, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// Marker at the project root → language root == project root.
		fs.writeFileSync(path.join(projectRoot, "tsconfig.json"), "{}\n");
		const fileAbs = path.join(srcDir, "x.ts");
		fs.writeFileSync(fileAbs, FILE_CONTENT);

		markDisposition(
			projectRoot,
			{ cwd: projectRoot, filePath: fileAbs, ...DIAG, content: FILE_CONTENT },
			"false-positive",
		);
		_resetStateCacheForTests();

		const { ctx, count } = await runDispatch(fileAbs, projectRoot);

		// language root == project root here (no nested marker).
		expect(ctx.cwd).toBe(ctx.projectRoot);
		expect(count).toBe(0);
	});
});

/** A store pi-lens 4.4.4 wrote for `aliasproj/src/x.ts` (see its README). */
const STORE_4_4_4 = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"fixtures",
	"data-dir-4.4.4",
	"dispatch-mark",
	"cache",
	"diagnostic-dispositions.json",
);

describe("#4689 disposition store under a session root spelled through a link", () => {
	// RECURRENCE GUARDED: #4689 review r2 A. The data dir was named from the
	// caller's form of the root: dispatch holds its identity, while the mark
	// tool, the turn-end readers and 4.4.4 hold the session's spelling. Under
	// a root reached through a link the two named different data dirs, so a
	// mark never silenced the finding it named, and marks written before the
	// upgrade stopped reaching dispatch.
	function aliasProject(): { alias: string; fileAbs: string } | undefined {
		const real = path.join(tmpDir, "realproj");
		const alias = path.join(tmpDir, "aliasproj");
		fs.mkdirSync(path.join(real, "src"), { recursive: true });
		fs.writeFileSync(path.join(real, "src", "x.ts"), FILE_CONTENT);
		try {
			fs.symlinkSync("realproj", alias, "dir");
		} catch {
			return undefined;
		}
		return { alias, fileAbs: path.join(alias, "src", "x.ts") };
	}

	it("honors a mark the mark tool wrote under the session's link spelling", async (ctx) => {
		const project = aliasProject();
		if (!project) return ctx.skip("symlinks unavailable");
		const { alias, fileAbs } = project;
		// WRITE exactly as the mark tool does: base = the session's cwd.
		markDisposition(
			alias,
			{ cwd: alias, filePath: fileAbs, ...DIAG, content: FILE_CONTENT },
			"false-positive",
		);
		_resetStateCacheForTests();
		const { ctx: dispatch, count } = await runDispatch(fileAbs, alias);
		// Premise: dispatch holds the root's identity, not the spelling.
		expect(dispatch.projectRoot).toBe(
			fs.realpathSync.native(alias).replace(/\\/g, "/"),
		);
		expect(count).toBe(0);
	});

	/** Put the 4.4.4 store where 4.4.4 wrote it: the data dir named by the
	 * session's spelling of the root (`tests/support/data-dir-4-4-4.ts`). */
	function seed444Store(alias: string): string {
		const cache = path.join(
			dataDir444(process.env.PILENS_DATA_DIR ?? "", alias),
			"cache",
		);
		fs.mkdirSync(cache, { recursive: true });
		const file = path.join(cache, "diagnostic-dispositions.json");
		fs.copyFileSync(STORE_4_4_4, file);
		_resetStateCacheForTests();
		return file;
	}

	it("honors a mark pi-lens 4.4.4 wrote, once session_start opens the data dir", async (ctx) => {
		const project = aliasProject();
		if (!project) return ctx.skip("symlinks unavailable");
		const { alias, fileAbs } = project;
		const spelled = seed444Store(alias);
		// What session_start does with the host's cwd, before any dispatch.
		getProjectDataDir(alias);
		const { count } = await runDispatch(fileAbs, alias);
		expect(count).toBe(0);
		// The 4.4.4 file stays, so a downgrade still reads its marks.
		expect(fs.existsSync(spelled)).toBe(true);
	});

	it("adopts the 4.4.4 store on a read that holds the root's spelling", async (ctx) => {
		const project = aliasProject();
		if (!project) return ctx.skip("symlinks unavailable");
		const { alias, fileAbs } = project;
		seed444Store(alias);
		// A turn-end or tool reader holds the host's cwd, the spelling.
		expect(getDisposition(alias, "dd:164197458e2b")?.reason).toBe(
			"4.4.4 fixture",
		);
		_resetStateCacheForTests();
		const { count } = await runDispatch(fileAbs, alias);
		expect(count).toBe(0);
	});

	it("still reports the finding when nothing marked it (control)", async (ctx) => {
		const project = aliasProject();
		if (!project) return ctx.skip("symlinks unavailable");
		const { count } = await runDispatch(project.fileAbs, project.alias);
		expect(count).toBe(1);
	});
});
