/**
 * #3734: `LSPService.renameFile` applied the merged `workspace/willRenameFiles`
 * text edits with no content binding, so a file written between a server
 * computing its edit and pi-lens applying it was overwritten at the server's
 * stale offsets. The fix reuses the `rename` path's capture (#3601, #3736)
 * with the request instant taken before `workspace/willRenameFiles`. Everything
 * between the tool and the disk is production code here: the tool, the real
 * `LSPService.renameFile`, `captureRenameExpectedContent`,
 * `applyWorkspaceEdit` inside pi's mutation queue, and the degradation ledger.
 * The two seams that are doubles are the process boundaries: the language
 * client's `willRenameFiles` answer (as in service-rename-file.test.ts) and the
 * `LSPService` shell the tool resolves (as in
 * tests/tools/lsp-navigation-rename-staleness.test.ts).
 *
 * The state table below is the failure list written before the fix; each row is
 * one `it(` in this file.
 *
 *  | file status                              | write lands             | edit set      | expected |
 *  |------------------------------------------|-------------------------|---------------|----------|
 *  | unopened                                 | between T and the answer| one importer  | refused, names the file, nothing written, nothing moved, one ledger row |
 *  | opened, disk no longer the last send     | before the answer       | one importer  | refused on the hash |
 *  | opened, disk equals the last send        | during the compute      | one importer  | refused on the send stamp |
 *  | one opened (clean) + one unopened (written) | between T and the answer | two importers | the whole edit refused: neither importer rewritten, nothing moved |
 *  | unopened, mtime before T                 | none                    | one importer  | applies: importer rewritten, file moved |
 *  | unopened, written                        | between T and the answer| one importer, preview | preview returns the merged edit and writes nothing |
 *
 * Round 3 (one identity, the registry client key; table in the PR body):
 *
 *  | contributors                                   | write lands             | expected |
 *  |------------------------------------------------|-------------------------|----------|
 *  | one root of a server throws, another answers   | none                    | applies the answer; the failure is still reported |
 *  | one with a matching record + one with none     | after T, or in the margin | refused, names the contributor with no record |
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import type { RenameClientDouble } from "../support/lsp-rename-client-double.js";
import {
	addRenameClient,
	makeRenameClient,
} from "../support/lsp-rename-client-double.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";
import { LSPService } from "../../clients/lsp/index.js";
import { installLspService } from "../support/lsp-service-seam.js";

/** The importer as the server read it: the edit replaces `old` with `new`. */
const OLD_IMPORT = "import { value } from './old';\n";
/** What an agent writes while the server computes. Long enough on line 1 that
 *  the server's line-1 offsets land inside it (a short line would make the
 *  stale edit throw out-of-range instead of overwriting, and a throw is not
 *  the corruption this test is about). */
const AGENT_IMPORT =
	"// agent edit while the rename was computed\nimport { value } from './old';\n";

const importEdit = (importPath: string) => ({
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

const agentImportEdit = (importPath: string) => ({
	changes: {
		[pathToFileURL(importPath).href]: [
			{
				range: {
					start: { line: 1, character: 25 },
					end: { line: 1, character: 28 },
				},
				newText: "new",
			},
		],
	},
});

let env: ReturnType<typeof setupTestEnvironment>;
let oldPath: string;
let newPath: string;
let importPath: string;

beforeEach(() => {
	resetDegradationLedger();
	env = setupTestEnvironment("pi-lens-rename-file-3734-");
	oldPath = path.join(env.tmpDir, "old.ts");
	newPath = path.join(env.tmpDir, "new.ts");
	importPath = path.join(env.tmpDir, "import.ts");
	fs.writeFileSync(oldPath, "export const value = 1;\n");
	fs.writeFileSync(importPath, OLD_IMPORT);
	clientFor = () => makeRenameClient(env.tmpDir, null);
	clientsFor = () => [{ serverId: "typescript", client: clientFor() }];
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	lsp.service = undefined;
	vi.restoreAllMocks();
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

/** Sets `file`'s mtime to `ageMs` before now: the fixture for "the server read
 *  these bytes earlier than the request", not a wait. */
function ageFile(file: string, ageMs: number): void {
	const when = new Date(Date.now() - ageMs);
	fs.utimesSync(file, when, when);
}

const staleRows = () =>
	getDegradationSummary().filter(
		(group) => group.kind === "lsp-edit-stale-content",
	);

/** The per-case language client double; a case replaces it before it builds
 *  the harness, so the client its rename answers from is the one it controls. */
let clientFor = (): RenameClientDouble => makeRenameClient(env.tmpDir, null);
let clientsFor = (): Array<{
	serverId: string;
	client: RenameClientDouble;
	root?: string;
}> => [{ serverId: "typescript", client: clientFor() }];

/** A real `LSPService` rename behind the shell the tool resolves. Nothing the
 *  case starts may outlive it: `shutdown` runs before the fixture goes. */
function makeHarness(): { realService: LSPService } {
	const realService = new LSPService();
	for (const { serverId, client, root } of clientsFor()) {
		addRenameClient(realService, serverId, root ?? env.tmpDir, client);
	}
	lsp.service = installLspService(
		makeLspServiceDouble({
			supportsLSP: vi.fn(() => true),
			hasLSP: vi.fn(async () => true),
			renameFile: (
				oldFilePath: string,
				newFilePath: string,
				options: Parameters<LSPService["renameFile"]>[2],
			) => realService.renameFile(oldFilePath, newFilePath, options),
		}),
	);
	return { realService };
}

async function runRenameFile(
	cwd: string,
	apply: boolean,
): Promise<{
	isError?: boolean;
	content: Array<{ text?: string }>;
	details?: Record<string, unknown>;
}> {
	const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
	return (await tool.execute(
		"rename-file-3734",
		{ operation: "rename_file", path: oldPath, newFilePath: newPath, apply },
		new AbortController().signal,
		null,
		{ cwd },
	)) as never;
}

const resultText = (result: { content: Array<{ text?: string }> }): string =>
	String(result.content[0]?.text ?? "");

describe("#3734: rename_file refuses an edit on a file that changed", () => {
	it("an agent write made while the server computes the rename is not overwritten, and the refusal names the file", async () => {
		const edit = importEdit(importPath);
		const client = makeRenameClient(env.tmpDir, edit);
		client.willRenameFiles.mockImplementation(async () => {
			// The agent's write lands after the server read the importer.
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			// The rename's offsets land on the agent's bytes unless it is refused.
			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("stale text document content");
			expect(resultText(result)).toContain(path.basename(importPath));
			// A refusal is not a half-applied rename: the move never ran.
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("checks the client that produced a lower-priority edit", async () => {
		const edit = importEdit(importPath);
		const primary = makeRenameClient(env.tmpDir, null);
		primary.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(AGENT_IMPORT),
			changedAtMs: 0,
		}));
		const secondary = makeRenameClient(env.tmpDir, edit);
		secondary.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(OLD_IMPORT),
			changedAtMs: 0,
		}));
		secondary.willRenameFiles.mockImplementation(async () => {
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		clientsFor = () => [
			{ serverId: "typescript", client: primary },
			{ serverId: "eslint", client: secondary },
		];
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain(path.basename(importPath));
			expect(resultText(result)).toContain(
				"it changed after the language server computed the rename from it",
			);
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("ignores a same-server client that contributed no edit", async () => {
		const edit = agentImportEdit(importPath);
		const contributor = makeRenameClient(env.tmpDir, edit);
		contributor.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(AGENT_IMPORT),
			changedAtMs: 0,
		}));
		contributor.willRenameFiles.mockImplementation(async () => {
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		const bystanderRoot = path.join(env.tmpDir, "package");
		fs.mkdirSync(bystanderRoot);
		const bystander = makeRenameClient(bystanderRoot, null);
		bystander.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(OLD_IMPORT),
			changedAtMs: 0,
		}));
		clientsFor = () => [
			{ serverId: "typescript", client: contributor },
			{ serverId: "typescript", client: bystander, root: bystanderRoot },
		];
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(importPath, "utf-8")).toContain("./new");
			expect(fs.existsSync(newPath)).toBe(true);
			expect(staleRows()).toEqual([]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("excludes a non-contributing server with a different stale send", async () => {
		const edit = agentImportEdit(importPath);
		const contributor = makeRenameClient(env.tmpDir, edit);
		contributor.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(AGENT_IMPORT),
			changedAtMs: 0,
		}));
		contributor.willRenameFiles.mockImplementation(async () => {
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		const bystander = makeRenameClient(env.tmpDir, null);
		bystander.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(OLD_IMPORT),
			changedAtMs: 0,
		}));
		clientsFor = () => [
			{ serverId: "eslint", client: contributor },
			{ serverId: "typescript", client: bystander },
		];
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(importPath, "utf-8")).toContain("./new");
			expect(fs.existsSync(newPath)).toBe(true);
			expect(staleRows()).toEqual([]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	// #3734 r3 F5: the failure partition was keyed by server id, so one root of
	// `typescript` throwing discarded the other root's answer too. Alone, that
	// refused a valid rename ("failed for all active LSP servers"); beside a
	// server that answered no edit, the rename moved the file and silently left
	// the importer on `./old`.
	it.each([
		{ label: "the only answer", withBystander: false },
		{ label: "beside a server that answered no edit", withBystander: true },
	])(
		"keeps a same-server client's edit when another root of that server fails ($label)",
		async ({ withBystander }) => {
			ageFile(importPath, 60_000);
			ageFile(oldPath, 60_000);
			const failing = makeRenameClient(env.tmpDir, null);
			failing.willRenameFiles.mockRejectedValue(
				new Error("boom from the first root"),
			);
			const answeringRoot = path.join(env.tmpDir, "package");
			fs.mkdirSync(answeringRoot);
			const answering = makeRenameClient(answeringRoot, importEdit(importPath));
			clientsFor = () => [
				{ serverId: "typescript", client: failing },
				{ serverId: "typescript", client: answering, root: answeringRoot },
				...(withBystander
					? [{ serverId: "eslint", client: makeRenameClient(env.tmpDir, null) }]
					: []),
			];
			const harness = makeHarness();

			try {
				const result = await runRenameFile(env.tmpDir, true);

				expect(result.isError).toBeUndefined();
				expect(fs.readFileSync(importPath, "utf-8")).toBe(
					"import { value } from './new';\n",
				);
				expect(fs.existsSync(newPath)).toBe(true);
				// The failing root is still reported, not swallowed.
				expect(resultText(result)).toContain("boom from the first root");
				expect(staleRows()).toEqual([]);
			} finally {
				await harness.realService.shutdown();
			}
		},
	);

	// #3734 r3 F6: one contributor's matching record bound the whole file, so a
	// second contributor holding no record had its stale edit applied with no
	// refusal (`rnewme`). Both mtime branches must see it: a write stamped after
	// the request, and one inside the margin before it (a coarse clock).
	const unboundWriteStamps = [
		{
			label: "stamped after the request",
			stampMs: 5_000,
			why: "it was written after the rename was requested",
		},
		{
			label: "stamped inside the margin before the request",
			stampMs: -1_000,
			why: "it was modified within 2 s of the rename request",
		},
	];
	it.each(unboundWriteStamps)(
		"refuses an edit from a contributor with no send record although another contributor's record matches ($label)",
		async ({ stampMs, why }) => {
			const recorded = makeRenameClient(
				env.tmpDir,
				agentImportEdit(importPath),
			);
			recorded.getSentContent = vi.fn(() => ({
				hash: hashDiagnosticContent(AGENT_IMPORT),
				changedAtMs: 0,
			}));
			const unrecorded = makeRenameClient(env.tmpDir, null);
			unrecorded.willRenameFiles.mockImplementation(async () => {
				// Computed from the old bytes; the agent's write lands meanwhile.
				fs.writeFileSync(importPath, AGENT_IMPORT);
				const when = new Date(Date.now() + stampMs);
				fs.utimesSync(importPath, when, when);
				return importEdit(importPath);
			});
			clientsFor = () => [
				{ serverId: "typescript", client: recorded },
				{ serverId: "eslint", client: unrecorded },
			];
			const harness = makeHarness();

			try {
				const result = await runRenameFile(env.tmpDir, true);

				expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
				expect(result.isError).toBe(true);
				expect(resultText(result)).toContain(path.basename(importPath));
				expect(resultText(result)).toContain(why);
				// The refusal names the contributor that holds no record, and only it.
				expect(resultText(result)).toContain(
					`eslint:${normalizeMapKey(env.tmpDir)}`,
				);
				expect(resultText(result)).not.toContain(
					`typescript:${normalizeMapKey(env.tmpDir)}`,
				);
				expect(fs.existsSync(oldPath)).toBe(true);
				expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
			} finally {
				await harness.realService.shutdown();
			}
		},
	);

	it("an opened importer whose disk no longer holds the client's last send is refused on the hash", async () => {
		const client = makeRenameClient(env.tmpDir, importEdit(importPath));
		// The client sent the original bytes a minute ago; an external write has
		// since replaced them and no sync followed.
		client.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(OLD_IMPORT),
			changedAtMs: Date.now() - 60_000,
		}));
		fs.writeFileSync(importPath, AGENT_IMPORT);
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("stale text document content");
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("an opened importer re-sent while the server computes is refused on the send stamp, although its disk equals that send", async () => {
		const edit = importEdit(importPath);
		// The clock is frozen at the real instant the case starts, so the write's
		// mtime stays consistent with the request instant; only the answer's own
		// arrival moves it forward, which is what makes "before the request" and
		// "after the answer" two distinct instants here.
		let clock = Date.now();
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
		let sentAtMs = 0;
		const client = makeRenameClient(env.tmpDir, edit);
		client.willRenameFiles.mockImplementation(async () => {
			// The agent's write and its hook sync, both inside the compute: the
			// server answered from the send before this one.
			sentAtMs = Date.now();
			fs.writeFileSync(importPath, AGENT_IMPORT);
			clock = sentAtMs + 1_000;
			return edit;
		});
		client.getSentContent = vi.fn(() => ({
			hash: hashDiagnosticContent(AGENT_IMPORT),
			changedAtMs: sentAtMs,
		}));
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(result.isError).toBe(true);
			// The stamp rule, not the mtime margin: the disk equals the last send.
			expect(resultText(result)).toContain(
				"it changed after the language server computed the rename from it",
			);
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		} finally {
			nowSpy.mockRestore();
			await harness.realService.shutdown();
		}
	});

	it("refuses a two-importer edit whole: the clean importer is not rewritten either", async () => {
		const cleanPath = path.join(env.tmpDir, "clean.ts");
		fs.writeFileSync(cleanPath, OLD_IMPORT);
		ageFile(cleanPath, 60_000);
		const edit = {
			changes: {
				...importEdit(cleanPath).changes,
				...importEdit(importPath).changes,
			},
		};
		const client = makeRenameClient(env.tmpDir, edit);
		client.willRenameFiles.mockImplementation(async () => {
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			// The write lands inside willRenameFiles, so the capture throws on the
			// stale file before applyWorkspaceEdit is entered: the whole edit is
			// refused and neither the stale file nor the clean sibling is written.
			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(fs.readFileSync(cleanPath, "utf-8")).toBe(OLD_IMPORT);
			expect(result.isError).toBe(true);
			expect(staleRows()).toEqual([expect.objectContaining({ count: 1 })]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("still applies a clean rename: the importer is rewritten and the file moves", async () => {
		ageFile(importPath, 60_000);
		ageFile(oldPath, 60_000);
		const client = makeRenameClient(env.tmpDir, importEdit(importPath));
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, true);

			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.existsSync(newPath)).toBe(true);
			expect(staleRows()).toEqual([]);
		} finally {
			await harness.realService.shutdown();
		}
	});

	it("previews a stale rename without writing or refusing", async () => {
		const edit = importEdit(importPath);
		const client = makeRenameClient(env.tmpDir, edit);
		client.willRenameFiles.mockImplementation(async () => {
			fs.writeFileSync(importPath, AGENT_IMPORT);
			return edit;
		});
		clientFor = () => client;
		const harness = makeHarness();

		try {
			const result = await runRenameFile(env.tmpDir, false);

			// A preview writes nothing, so there is nothing to refuse: the guard
			// sits on the apply path only, and the preview still reports the edit.
			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(importPath, "utf-8")).toBe(AGENT_IMPORT);
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(staleRows()).toEqual([]);
			expect(resultText(result)).toContain("import.ts");
		} finally {
			await harness.realService.shutdown();
		}
	});
});
