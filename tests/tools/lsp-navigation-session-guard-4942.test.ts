/**
 * #4942 (review r1 F1): the mutating `lsp_navigation` credits authorship on
 * the guard of the session that made the call, not on the guard the extension
 * captured at activation.
 *
 * RECURRENCE GUARDED: `index.ts` handed the tool `runtime.readGuard` at
 * construction, so a concurrent secondary's `rename_file` apply stamped the
 * coordinator's (the primary's) guard. The primary's blind edit of the file the
 * secondary's rename rewrote was then allowed and the secondary's own was
 * refused, the exact cross-session licence #4942 closes for every other
 * writer. The tool, `LSPService.renameFile`, `recordLspMutation` and the two
 * real `ReadGuard`s are production code; the language client and the `LSPService`
 * shell are the process-boundary doubles, as in
 * lsp-navigation-rename-file-staleness.test.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { LSPService } from "../../clients/lsp/index.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	addRenameClient,
	makeRenameClient,
} from "../support/lsp-rename-client-double.js";
import { installLspService } from "../support/lsp-service-seam.js";

const OLD_IMPORT = "import { value } from './old';\n";

let env: ReturnType<typeof setupTestEnvironment>;
let oldPath: string;
let newPath: string;
let importPath: string;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-lsp-guard-4942-");
	oldPath = path.join(env.tmpDir, "old.ts");
	newPath = path.join(env.tmpDir, "new.ts");
	importPath = path.join(env.tmpDir, "import.ts");
	fs.writeFileSync(oldPath, "export const value = 1;\n");
	fs.writeFileSync(importPath, OLD_IMPORT);
	for (const file of [oldPath, importPath]) {
		const longAgo = new Date(Date.now() - 60_000);
		fs.utimesSync(file, longAgo, longAgo);
	}
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	vi.restoreAllMocks();
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

const importEdit = () => ({
	changes: {
		[pathToFileURL(importPath).href]: [
			{
				range: {
					start: { line: 0, character: 25 },
					end: { line: 0, character: 28 },
				},
				newText: "new",
			},
		],
	},
});

describe("#4942 F1: a secondary's lsp_navigation rename_file licenses only its own session", () => {
	it("credits the rewritten importer to the secondary's guard and leaves the primary's refused", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		const realService = new LSPService();
		addRenameClient(
			realService,
			"typescript",
			env.tmpDir,
			makeRenameClient(env.tmpDir, importEdit()),
		);
		installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn(() => true),
				hasLSP: vi.fn(async () => true),
				renameFile: (
					from: string,
					to: string,
					options: Parameters<LSPService["renameFile"]>[2],
				) => realService.renameFile(from, to, options),
			}),
		);
		// The wiring `index.ts` gives the tool: the captured coordinator guard
		// and the per-call lookup.
		// Production's direct branch: `index.ts` hands the tool the runtime and
		// the cache manager, so the write is recorded through `recordLspMutation`
		// itself, not the mutation bridge's fallback for a tool built without
		// them (verify r2 N1).
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
			runtime,
			cacheManager: new CacheManager(false),
			readGuard: runtime.readGuard,
			readGuardFor: (sessionId) => runtime.readGuardFor(sessionId),
		});

		try {
			const result = (await tool.execute(
				"rename-file-4942",
				{
					operation: "rename_file",
					path: oldPath,
					newFilePath: newPath,
					apply: true,
				},
				new AbortController().signal,
				null,
				{
					cwd: env.tmpDir,
					sessionManager: { getSessionId: () => "secondary-session" },
				},
			)) as { isError?: boolean };

			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect({
				primaryEdit: runtime.readGuard.checkEdit(importPath, [1, 1]).action,
				secondaryEdit: runtime
					.readGuardFor("secondary-session")
					.checkEdit(importPath, [1, 1]).action,
			}).toEqual({ primaryEdit: "block", secondaryEdit: "allow" });
		} finally {
			await realService.shutdown();
		}
	});
});
