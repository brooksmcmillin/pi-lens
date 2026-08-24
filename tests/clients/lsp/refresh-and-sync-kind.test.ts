/**
 * #1669: `workspace/diagnostic/refresh` handler + negotiated
 * `textDocumentSync.change` kind honored on outgoing `didChange`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
	clientRequestWorkspaceDiagnostics,
	createLSPClient,
	handleNotifyChange,
	handleNotifyOpen,
	setupIncomingHandlers,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	createWorkspaceDiagnosticsCacheContext,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { negotiateSyncKind } from "../../../clients/lsp/sync-kind.js";
// #1669 review F8/rebase: #1682 landed the shared factory this file's local
// copy was anticipating — use it instead of hand-maintaining a parallel one
// (single-source-of-truth). `createMockState` there now also carries the F8
// fix (openDocumentUris/projectIdentityProbedFiles) and a `syncKind` default,
// both folded into the shared file directly by this round's rebase.
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);

describe("workspace/diagnostic/refresh handler (#1669)", () => {
	it("registers a handler that replies null and clears workspacePullResultCache", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-refresh-"));
		const state = createMockState({ root });
		state.workspacePullResultCache.set(TEST_KEY, {
			uri: `file://${TEST_FILE}`,
			resultId: "stale-result-id",
			diagnostics: [],
		});
		setupIncomingHandlers(state, {});

		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const registered = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		);
		expect(
			registered,
			"workspace/diagnostic/refresh handler registered",
		).toBeDefined();

		const reply = await registered![1]();
		expect(reply).toBeNull();
		expect(state.workspacePullResultCache.size).toBe(0);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("also clears the persisted workspace-diagnostics cache on disk", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-refresh-cache-"),
		);
		// Pre-populate the persisted sweep cache the way a REAL sweep would —
		// through `createWorkspaceDiagnosticsCacheContext`, which is also what
		// registers `root` as a cwd `clearAllWorkspaceDiagnosticsCaches` (#1669
		// review F1) knows to clear. A raw `saveWorkspaceDiagnosticsCache` call
		// writes the file without ever registering it, which would prove
		// nothing about the refresh handler's real behavior.
		const ctx = createWorkspaceDiagnosticsCacheContext(root);
		ctx.record(path.join(root, "app.ts"), "all|", [], 1);
		ctx.persist();
		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}).length,
		).toBe(1);

		const state = createMockState({ root });
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];
		expect(handler).toBeDefined();

		await handler!();

		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}).length,
		).toBe(0);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("negotiateSyncKind (#1669)", () => {
	it("reads the legacy bare-number shape", () => {
		expect(negotiateSyncKind({ textDocumentSync: 2 })).toBe(2);
		expect(negotiateSyncKind({ textDocumentSync: 0 })).toBe(0);
	});

	it("reads TextDocumentSyncOptions.change", () => {
		expect(negotiateSyncKind({ textDocumentSync: { change: 2 } })).toBe(2);
	});

	it("defaults to Full when unspecified, absent, or unrecognized", () => {
		expect(negotiateSyncKind({})).toBe(1);
		expect(negotiateSyncKind(undefined)).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: { change: 99 } })).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: "bogus" })).toBe(1);
	});
});

describe("outgoing didChange honors the negotiated sync kind (#1669)", () => {
	function lastDidChangeParams(state: LSPClientState): {
		contentChanges: Array<{ range?: unknown; text: string }>;
	} {
		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const call = [...calls]
			.reverse()
			.find((c) => c[0] === "textDocument/didChange");
		expect(
			call,
			"a textDocument/didChange notification was sent",
		).toBeDefined();
		return call![1] as {
			contentChanges: Array<{ range?: unknown; text: string }>;
		};
	}

	it("Full sync kind: unchanged whole-document event", async () => {
		const state = createMockState({ syncKind: 1 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
	});

	it("None sync kind: unchanged whole-document event", async () => {
		const state = createMockState({ syncKind: 0 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
	});

	it("Incremental sync kind: sends a ranged full-document replace, not a shapeless event", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// Prime the previously-sent content the way didOpen would.
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;\nconst y = 1;",
		});

		await handleNotifyChange(state, TEST_FILE, "const x = 1;\nconst y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toHaveLength(1);
		const [change] = params.contentChanges;
		expect(change.range).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: "const y = 1;".length },
		});
		expect(change.text).toBe("const x = 1;\nconst y = 2;");
	});

	it("Incremental sync kind with no retained previous text falls back to whole-document (self-heals)", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// No prior documentContentHashes entry for this path.

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
		// #1669 review F5: this assertion is the part that actually
		// distinguishes the fix from a no-op/broken one. Pre-fix (or a fix that
		// never wires `recordSentContent` to retain text under Incremental),
		// `documentContentHashes` never carries a `text` field at all — the
		// whole-document-output assertion above would ALSO pass against that
		// inert baseline, since Full and "missing feature" both send
		// `{ text }`. Checking that this call retained `text` for the path
		// proves the self-heal is genuine: the NEXT change for this path now
		// has a basis to diff against, per `buildContentChanges`'s doc comment.
		expect(state.documentContentHashes.get(TEST_KEY)?.text).toBe(
			"const y = 2;",
		);
	});

	it("recordSentContent binding stays consistent with what was sent under Incremental", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;",
		});

		await handleNotifyChange(state, TEST_FILE, "const x = 2;");

		const recorded = state.documentContentHashes.get(TEST_KEY);
		expect(recorded?.version).toBe(1);
		expect(recorded?.text).toBe("const x = 2;");
	});

	it("Incremental didOpen (fresh document) still sends the full text, never a range", async () => {
		const state = createMockState({ syncKind: 2 });

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpen = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpen).toBeDefined();
		expect(
			(didOpen![1] as { textDocument: { text: string } }).textDocument.text,
		).toBe("const x = 1;");
		// #1669 review F5: didOpen always sending full text is unchanged
		// behavior on BOTH sides of the fix, so the assertion above alone
		// can't tell a real Incremental wire-up from a no-op one. What IS new
		// under Incremental is that `recordSentContent` retains the text so a
		// FOLLOWING didChange has a basis to diff against — assert that here,
		// on the open path specifically.
		expect(state.documentContentHashes.get(TEST_KEY)?.text).toBe(
			"const x = 1;",
		);
	});

	it("counts a lone-CR line ending as a real line break, not part of the previous line (#1669 review F6)", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// Classic Mac (lone \r, no \n) line ending between two lines. A plain
		// `.split("\n")` sees this as ONE line (`"line0\rline1"`) — pre-fix, the
		// computed range would end at `{ line: 0, character: "line0\rline1".length }`
		// instead of the real last line.
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "line0\rline1",
		});

		await handleNotifyChange(state, TEST_FILE, "line0\rline2");

		const params = lastDidChangeParams(state);
		const [change] = params.contentChanges;
		expect(change.range).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: "line1".length },
		});
	});
});

describe("recordSentContent only mirrors a CONFIRMED send (#1669 review F7)", () => {
	it("does not update documentContentHashes when the didChange notification is swallowed as a stream error", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;",
		});
		// A stream error is SWALLOWED by `safeSendNotification` (connection
		// error handlers update state separately) — the caller sees a resolved
		// promise, not a rejection, so gating on a thrown error alone would be
		// insufficient.
		vi.mocked(state.connection.sendNotification).mockImplementationOnce(() =>
			Promise.reject(new Error("stream destroyed")),
		);

		await handleNotifyChange(state, TEST_FILE, "const x = 2;");

		// Pre-fix, `recordSentContent` ran unconditionally after the send
		// attempt: this would read `{ version: 1, text: "const x = 2;" }` even
		// though the server never actually received it — desyncing the
		// Incremental mirror from what the server has, with no self-heal.
		const recorded = state.documentContentHashes.get(TEST_KEY);
		expect(recorded?.version).toBe(0);
		expect(recorded?.text).toBe("const x = 1;");
	});

	it("does update documentContentHashes once the send genuinely succeeds", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;",
		});

		await handleNotifyChange(state, TEST_FILE, "const x = 2;");

		const recorded = state.documentContentHashes.get(TEST_KEY);
		expect(recorded?.version).toBe(1);
		expect(recorded?.text).toBe("const x = 2;");
	});
});

describe("workspace/diagnostic/refresh clears per-document pull state and re-pulls open docs (#1669 review F3)", () => {
	it("drops the same per-path state a resync's clearDiagnosticsForPath drops, and proactively re-pulls open documents under pull mode", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		state.openDocuments.add(TEST_KEY);
		state.openDocumentUris!.set(TEST_KEY, pathToFileURL(TEST_FILE).href);
		state.pullResultIds.set(TEST_KEY, "stale-result-id");
		state.documentPullDiagnostics.set(TEST_KEY, [
			{
				message: "stale",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			} as any,
		]);
		state.diagnosticBindings.set(TEST_KEY, { contentHash: "stale-hash" });
		state.diagnosticsVersionsByPath.set(TEST_KEY, 5);

		vi.mocked(state.connection.sendRequest).mockResolvedValue({
			kind: "full",
			resultId: "fresh-result-id",
			items: [],
		});

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];
		expect(handler).toBeDefined();

		await handler!();

		// #1104 basis dropped — same fields `clearDiagnosticsForPath` drops for
		// a normal resync. Pre-fix, only `workspacePullResultCache` (handled
		// separately, above) was cleared; these all stayed stale. Checked
		// BEFORE the deferred re-pull runs (it legitimately re-populates
		// `pullResultIds` with a fresh basis) — the clear itself is
		// synchronous, inside the handler's own execution, not behind
		// `setImmediate`.
		expect(state.pullResultIds.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticsVersionsByPath.has(TEST_KEY)).toBe(false);

		// #1669 review N2: the re-pull is deliberately deferred via
		// `setImmediate` (so the protocol reply is never delayed behind it) —
		// a microtask flush alone will NOT reach it; wait a real macrotask
		// tick to observe it.
		await new Promise((resolve) => setImmediate(resolve));

		// Proactively re-pulled: a textDocument/diagnostic request went out
		// for the open document instead of waiting on its next edit.
		const pullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(
			pullCall,
			"textDocument/diagnostic was requested for the open doc",
		).toBeDefined();
	});

	it("does not re-pull under push-only mode (a pull request there would just be refused)", async () => {
		const state = createMockState(); // default workspaceDiagnosticsSupport.mode = "push-only"
		state.openDocuments.add(TEST_KEY);
		state.openDocumentUris!.set(TEST_KEY, pathToFileURL(TEST_FILE).href);
		state.pullResultIds.set(TEST_KEY, "stale-result-id");

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];

		await handler!();
		await Promise.resolve();

		expect(state.pullResultIds.has(TEST_KEY)).toBe(false);
		const pullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(pullCall).toBeUndefined();
	});
});

describe("clientRequestWorkspaceDiagnostics: unchanged report with no cached basis (#1669 review F4)", () => {
	it("falls back to a per-file pull instead of silently dropping the file as clean", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		// No workspacePullResultCache entry — simulates right after a refresh
		// cleared it, then a sweep's `workspace/diagnostic` pull runs before
		// this file has a fresh basis again.
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "workspace/diagnostic") {
					return {
						items: [
							{
								uri: pathToFileURL(TEST_FILE).href,
								kind: "unchanged",
								resultId: "r2",
							},
						],
					};
				}
				if (method === "textDocument/diagnostic") {
					return {
						kind: "full",
						resultId: "r3",
						items: [
							{
								message: "fresh finding",
								severity: 1,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
							},
						],
					};
				}
				return undefined;
			},
		);

		const out = await clientRequestWorkspaceDiagnostics(state, 5000);

		expect(
			out,
			"workspace/diagnostic pull must not fail outright",
		).toBeDefined();
		const entry = out!.find((r) => normalizeMapKey(r.filePath) === TEST_KEY);
		// Pre-fix, `continue` on a missing `prior` basis dropped this file from
		// `out` entirely — indistinguishable from a genuinely clean file to
		// every caller (`runWorkspaceDiagnosticsSwept`'s doc comment: "a file
		// absent from the result is clean").
		expect(entry, "file must not silently drop out as clean").toBeDefined();
		expect(entry!.diagnostics).toHaveLength(1);
		const fallbackPullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(fallbackPullCall, "fell back to a real per-file pull").toBeDefined();
	});

	it("stays absent when the fallback pull is genuinely clean", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "workspace/diagnostic") {
					return {
						items: [
							{
								uri: pathToFileURL(TEST_FILE).href,
								kind: "unchanged",
								resultId: "r2",
							},
						],
					};
				}
				if (method === "textDocument/diagnostic") {
					return { kind: "full", resultId: "r3", items: [] };
				}
				return undefined;
			},
		);

		const out = await clientRequestWorkspaceDiagnostics(state, 5000);

		expect(out).toBeDefined();
		expect(
			out!.find((r) => normalizeMapKey(r.filePath) === TEST_KEY),
		).toBeUndefined();
	});
});

describe("clientRequestWorkspaceDiagnostics unchanged-fallback shares ONE deadline (#1669 review N1)", () => {
	it("does not grant the full call budget to a SECOND file's fallback pull once the first has already exhausted it", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		const file1 = "/project/file1.ts";
		const file2 = "/project/file2.ts";
		const uri1 = pathToFileURL(file1).href;
		const uri2 = pathToFileURL(file2).href;

		// A controllable clock: Date.now() reads `baseTime + elapsedOffset`.
		// `elapsedOffset` only moves when the test explicitly bumps it (inside
		// file1's mocked response, below) — deterministic regardless of how
		// many incidental Date.now() calls happen around it.
		const baseTime = 1_700_000_000_000;
		let elapsedOffset = 0;
		const dateNowSpy = vi
			.spyOn(Date, "now")
			.mockImplementation(() => baseTime + elapsedOffset);

		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown, params?: unknown) => {
				if (method === "workspace/diagnostic") {
					return {
						items: [
							{ uri: uri1, kind: "unchanged", resultId: "r1" },
							{ uri: uri2, kind: "unchanged", resultId: "r2" },
						],
					};
				}
				if (method === "textDocument/diagnostic") {
					const uri = (params as { textDocument?: { uri?: string } })
						?.textDocument?.uri;
					if (uri === uri1) {
						// Pre-fix, file2 would still get the FULL 100ms budget next —
						// budgets were re-granted per file, never shared. Blow the
						// whole shared budget here to prove the fix shares it.
						elapsedOffset = 10_000;
						return { kind: "full", resultId: "r1b", items: [] };
					}
					// file2 must never reach here once the shared deadline is fixed.
					return { kind: "full", resultId: "r2b", items: [] };
				}
				return undefined;
			},
		);

		try {
			const out = await clientRequestWorkspaceDiagnostics(state, 100);

			expect(out).toBeDefined();
			const pullCalls = vi
				.mocked(state.connection.sendRequest)
				.mock.calls.filter((c) => c[0] === "textDocument/diagnostic");
			// Pre-fix: 2 calls, each granted the full 100ms budget serially.
			// Post-fix: only file1's call — file2 bails once the SHARED deadline
			// (exhausted by file1) leaves it nothing to spend.
			expect(pullCalls).toHaveLength(1);
			expect(
				(pullCalls[0][1] as { textDocument?: { uri?: string } })?.textDocument
					?.uri,
			).toBe(uri1);
			// file2 must not silently read as clean either — it was never asked.
			expect(
				out!.find(
					(r) => normalizeMapKey(r.filePath) === normalizeMapKey(file2),
				),
			).toBeUndefined();
		} finally {
			dateNowSpy.mockRestore();
		}
	});
});

describe("workspace/diagnostic/refresh caps simultaneous re-pulls (#1669 review N2)", () => {
	it("never runs more than the configured cap of textDocument/diagnostic requests at once", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		const DOC_COUNT = 12;
		for (let i = 0; i < DOC_COUNT; i++) {
			const filePath = `/project/concurrency-file-${i}.ts`;
			const key = normalizeMapKey(filePath);
			state.openDocuments.add(key);
			state.openDocumentUris!.set(key, pathToFileURL(filePath).href);
		}

		let inFlight = 0;
		let maxInFlight = 0;
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "textDocument/diagnostic") {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise<void>((resolve) => setImmediate(resolve));
					inFlight--;
					return { kind: "full", resultId: "r", items: [] };
				}
				return undefined;
			},
		);

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];
		const reply = await handler!();
		// #1669 review N2: the reply must not wait on the re-pulls at all.
		expect(reply).toBeNull();

		// Drain the worker pool fully before asserting.
		for (let i = 0; i < DOC_COUNT + 4; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}

		expect(inFlight, "worker pool must have fully drained").toBe(0);
		const pullCalls = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.filter((c) => c[0] === "textDocument/diagnostic");
		expect(pullCalls).toHaveLength(DOC_COUNT);
		// Pre-fix: `void clientRequestPullDiagnostics` per doc with no cap at
		// all fired essentially all of them at once — maxInFlight would read
		// DOC_COUNT (12). Post-fix it must stay at the small fixed cap.
		expect(maxInFlight).toBeLessThan(DOC_COUNT);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});
});

describe("workspace/diagnostic/refresh coalesces a burst into one trailing rerun (#1669 review R1)", () => {
	it("a burst of N refreshes costs at most 2 passes over open documents and never exceeds the concurrency cap", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		const DOC_COUNT = 50;
		for (let i = 0; i < DOC_COUNT; i++) {
			const filePath = `/project/burst-file-${i}.ts`;
			const key = normalizeMapKey(filePath);
			state.openDocuments.add(key);
			state.openDocumentUris!.set(key, pathToFileURL(filePath).href);
		}

		let inFlight = 0;
		let maxInFlight = 0;
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "textDocument/diagnostic") {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise<void>((resolve) => setImmediate(resolve));
					inFlight--;
					return { kind: "full", resultId: "r", items: [] };
				}
				return undefined;
			},
		);

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];
		expect(handler).toBeDefined();

		// The real trigger the review names: a watch-mode rebuild or a `git
		// checkout` can fire many `workspace/diagnostic/refresh` requests back
		// to back. Fire a burst of 20 essentially synchronously — no await
		// between them — mirroring how a real jsonrpc connection would
		// deliver a rapid-fire sequence of independent requests.
		const BURST_SIZE = 20;
		const replies: unknown[] = [];
		for (let i = 0; i < BURST_SIZE; i++) {
			replies.push(await handler!());
		}
		// Every refresh in the burst still gets its OWN protocol reply — the
		// coalescing only applies to the background re-pull pool, never to
		// spec compliance.
		expect(replies).toHaveLength(BURST_SIZE);
		expect(replies.every((r) => r === null)).toBe(true);

		// Drain fully: at most 2 pool passes x (DOC_COUNT / cap) batches, plus
		// slack.
		for (let i = 0; i < DOC_COUNT * 2 + 8; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}

		expect(inFlight, "worker pool must have fully drained").toBe(0);
		const pullCalls = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.filter((c) => c[0] === "textDocument/diagnostic");
		// Pre-fix: one independent pool per refresh — 20 refreshes x 50 docs =
		// 1000 pulls (20x redundant) and peak concurrency 20 x 4 = 80. Post-fix:
		// at most ONE trailing rerun coalesces the whole burst, so at most 2
		// passes over the open-document set, and the cap is never exceeded
		// regardless of how many refreshes arrived.
		expect(pullCalls.length).toBeLessThanOrEqual(2 * DOC_COUNT);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	// #1669 review R1b: the "at most 2 passes" assertion above cannot tell a
	// working rerun apart from a BROKEN one that silently drops it — 1 pass
	// (no rerun at all) also satisfies "<= 2". This test gates the mid-burst
	// refreshes on a REAL in-flight pull (never a timer/tick proxy for one)
	// and asserts the EXACT pull count a genuine single trailing rerun
	// produces: 1 initial pass + 10 mid-pool refreshes coalesced into exactly
	// 1 rerun pass, over 20 open documents, is exactly 40 pulls — never 20
	// (rerun dropped) and never more than 40 (rerun fired per refresh).
	it("a refresh arriving while a REAL pull is in flight produces exactly one rerun pass, not zero and not one per refresh", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		const DOC_COUNT = 20;
		for (let i = 0; i < DOC_COUNT; i++) {
			const filePath = `/project/r1b-file-${i}.ts`;
			const key = normalizeMapKey(filePath);
			state.openDocuments.add(key);
			state.openDocumentUris!.set(key, pathToFileURL(filePath).href);
		}

		// Every "textDocument/diagnostic" pull hangs until THIS test releases
		// it explicitly — the gate is a real outstanding request, not a timer.
		let inFlight = 0;
		const pendingReleases: Array<() => void> = [];
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "textDocument/diagnostic") {
					inFlight++;
					await new Promise<void>((resolve) => {
						pendingReleases.push(() => {
							inFlight--;
							resolve();
						});
					});
					return { kind: "full", resultId: "r", items: [] };
				}
				return undefined;
			},
		);

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(c) => c[0] === "workspace/diagnostic/refresh",
		)?.[1];
		expect(handler).toBeDefined();

		// Initial refresh — starts the pool on the next tick.
		expect(await handler!()).toBeNull();
		// Let the pool's setImmediate fire and reach its first real pulls.
		await new Promise((resolve) => setImmediate(resolve));
		// Gate on a REAL in-flight pull: wait until at least one is genuinely
		// outstanding before firing the mid-pool refreshes.
		for (let i = 0; i < 50 && pendingReleases.length === 0; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(
			pendingReleases.length,
			"a real textDocument/diagnostic pull must be in flight before the mid-pool burst",
		).toBeGreaterThan(0);

		// 10 refreshes arrive WHILE the first pass's pulls are genuinely
		// unresolved — every one of them must coalesce into a SINGLE trailing
		// rerun, not zero (dropped) and not ten (uncapped).
		for (let i = 0; i < 10; i++) {
			expect(await handler!()).toBeNull();
		}

		// Drain: release every in-flight/queued pull as it appears, across
		// both the first pass and the one rerun pass, until nothing is left.
		for (let tick = 0; tick < DOC_COUNT * 4 + 20; tick++) {
			if (pendingReleases.length === 0 && inFlight === 0) break;
			const toRelease = pendingReleases.splice(0, pendingReleases.length);
			for (const release of toRelease) release();
			await new Promise((resolve) => setImmediate(resolve));
		}

		expect(inFlight, "worker pool must have fully drained").toBe(0);
		const pullCalls = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.filter((c) => c[0] === "textDocument/diagnostic");
		// Exactly 2 passes over 20 open documents. A dropped-rerun mutant
		// (refreshRepullRerunRequested forced to `false`) produces 20 here —
		// still "<= 40", but wrong; this assertion is exact, not a ceiling.
		expect(pullCalls.length).toBe(2 * DOC_COUNT);
	});
});

describe("workspace/diagnostic/refresh reaches an unregistered cwd's on-disk cache (#1669 review N3)", () => {
	it("clears the persisted cache at state.root even when no sweep has registered that cwd in this process yet", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-refresh-n3-"));
		try {
			// Simulate a PRIOR session's sweep: real entries on disk, written
			// directly (bypassing `createWorkspaceDiagnosticsCacheContext`, so
			// `root` is NOT in this process's `_registeredCwds` — a virgin cwd
			// from `clearAllWorkspaceDiagnosticsCaches`'s point of view, exactly
			// the "refresh arrives before any sweep this process" scenario).
			const filePath = path.join(root, "stale.ts");
			const {
				saveWorkspaceDiagnosticsCache,
				WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			} = await import("../../../clients/lsp/workspace-diagnostics-cache.js");
			saveWorkspaceDiagnosticsCache(root, {
				version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
				entries: {
					[normalizeMapKey(filePath)]: {
						diagnostics: [{ message: "stale" } as any],
						count: 1,
						mtimeMs: 1,
						scannedAt: Date.now(),
						scopeKey: "all|",
					},
				},
			});
			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}),
			).toHaveLength(1);

			// The refresh fires for a client whose `state.root` IS this project's
			// cwd (the common single-root case) — `clearAllWorkspaceDiagnosticsCaches`
			// alone (registry-only) would clear nothing here.
			const state = createMockState({ root });
			setupIncomingHandlers(state, {});
			const calls = vi.mocked(state.connection.onRequest).mock
				.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
			const handler = calls.find(
				(c) => c[0] === "workspace/diagnostic/refresh",
			)?.[1];
			await handler!();

			// Pre-fix: still 1 stale entry — nothing ever reached this cwd's file.
			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}),
			).toHaveLength(0);

			// A LATER sweep for this cwd (its first `createWorkspaceDiagnosticsCacheContext`
			// call in this process) must not resurrect the stale entry either.
			const ctx = createWorkspaceDiagnosticsCacheContext(root);
			expect(ctx.lookup(filePath, "all|")).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("workspace/diagnostic/refresh reaches a never-swept monorepo cache (#1707)", () => {
	it("clears the sweep-root cache when the client root is a nested member", async () => {
		const workspaceRoot = fs.mkdtempSync(
			path.join(process.cwd(), "pi-lens-refresh-1707-"),
		);
		const memberRoot = path.join(workspaceRoot, "packages", "member");
		fs.mkdirSync(memberRoot, { recursive: true });
		try {
			const filePath = path.join(
				workspaceRoot,
				"packages",
				"member",
				"stale.ts",
			);
			const {
				saveWorkspaceDiagnosticsCache,
				WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			} = await import("../../../clients/lsp/workspace-diagnostics-cache.js");
			saveWorkspaceDiagnosticsCache(workspaceRoot, {
				version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
				entries: {
					[normalizeMapKey(filePath)]: {
						diagnostics: [{ message: "stale" } as any],
						count: 1,
						mtimeMs: 1,
						scannedAt: Date.now(),
						scopeKey: "all|",
					},
				},
			});

			const state = createMockState({ root: memberRoot });
			setupIncomingHandlers(state, {});
			const calls = vi.mocked(state.connection.onRequest).mock
				.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
			const handler = calls.find(
				(c) => c[0] === "workspace/diagnostic/refresh",
			)?.[1];
			await handler!();

			expect(
				Object.keys(
					loadWorkspaceDiagnosticsCache(workspaceRoot)?.entries ?? {},
				),
			).toHaveLength(0);
		} finally {
			fs.rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});
});

describe("createWorkspaceDiagnosticsCacheContext.lookup() honors a mid-sweep clear (#1669 review N4)", () => {
	it("stops serving pre-refresh entries for the REST of an in-flight sweep, not only at persist() time", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-refresh-n4-"));
		try {
			const { clearWorkspaceDiagnosticsCache } =
				await import("../../../clients/lsp/workspace-diagnostics-cache.js");
			const filePath = path.join(root, "a.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const mtimeMs = fs.statSync(filePath).mtimeMs;

			// A sweep starts and records+persists a fresh entry for `a.ts`.
			const ctx = createWorkspaceDiagnosticsCacheContext(root);
			ctx.record(
				filePath,
				"all|",
				[{ message: "pre-refresh" } as any],
				mtimeMs,
			);
			ctx.persist();
			// This SAME sweep's `entries` map still holds `a.ts` in memory — the
			// next lookup would normally hit it (isEntryFresh only checks mtime,
			// unchanged here).
			expect(ctx.lookup(filePath, "all|")).toBeDefined();

			// Mid-sweep, a refresh clears this cwd (e.g. from a concurrent LSP
			// client's `workspace/diagnostic/refresh` handler for the SAME
			// project).
			clearWorkspaceDiagnosticsCache(root);

			// Pre-fix: `lookup()` had no epoch check at all — this sweep kept
			// serving its own now-disowned in-memory copy for the rest of its
			// run, even though the epoch would already have blocked its
			// `persist()`. Post-fix: `lookup()` itself goes dark the instant the
			// epoch moves.
			expect(ctx.lookup(filePath, "all|")).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

// #1669 review F5: every other test in this file drives `handleNotifyChange`
// against a HAND-BUILT `LSPClientState` with `syncKind` set directly by the
// test — none of them exercise the real seam that sets it in production,
// `state.syncKind = negotiateSyncKind(initResult.capabilities)` inside
// `createLSPClient`. This suite spawns the real fake LSP server fixture
// (same pattern as tests/clients/lsp/integration.test.ts) so the sync kind
// is negotiated from an ACTUAL `initialize` response, and asserts on the
// real wire shape of the resulting `didChange` — proof the negotiation seam
// itself, not just `buildContentChanges` in isolation, drives production.
describe("negotiateSyncKind through the real createLSPClient init path (#1669 review F5)", () => {
	it("a server advertising Incremental sync gets a ranged didChange on the wire", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: {
				...process.env,
				FAKE_LSP_SYNC_KIND: "2", // Incremental
				FAKE_LSP_ECHO_DID_CHANGE: "1",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-incremental",
			process: proc,
			root: process.cwd(),
		});
		try {
			const received: Array<{
				contentChanges: Array<{ range?: unknown; text: string }>;
			}> = [];
			client.connection.onNotification(
				"$/test/didChangeReceived",
				(params: {
					contentChanges: Array<{ range?: unknown; text: string }>;
				}) => {
					received.push(params);
				},
			);

			const filePath = path.join(os.tmpdir(), "pi-lens-sync-kind-real-init.ts");
			await client.notify.open(filePath, "const x = 1;\n", "typescript");
			await client.notify.change(filePath, "const x = 1;\nconst y = 2;\n");

			await vi.waitFor(() => {
				expect(received.length).toBeGreaterThan(0);
			});
			const [change] = received[0].contentChanges;
			// The real negotiation from the server's actual `initialize` response
			// drove a RANGED edit — not the whole-document `{ text }` shape a
			// Full-sync (or unwired) client would send.
			expect(change.range).toBeDefined();
			expect(change.text).toBe("const x = 1;\nconst y = 2;\n");
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);

	it("a server advertising Full sync (the fixture's default) gets a whole-document didChange", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_ECHO_DID_CHANGE: "1" },
		});
		const client = await createLSPClient({
			serverId: "fake-full",
			process: proc,
			root: process.cwd(),
		});
		try {
			const received: Array<{
				contentChanges: Array<{ range?: unknown; text: string }>;
			}> = [];
			client.connection.onNotification(
				"$/test/didChangeReceived",
				(params: {
					contentChanges: Array<{ range?: unknown; text: string }>;
				}) => {
					received.push(params);
				},
			);

			const filePath = path.join(
				os.tmpdir(),
				"pi-lens-sync-kind-real-init-full.ts",
			);
			await client.notify.open(filePath, "const x = 1;\n", "typescript");
			await client.notify.change(filePath, "const x = 1;\nconst y = 2;\n");

			await vi.waitFor(() => {
				expect(received.length).toBeGreaterThan(0);
			});
			const [change] = received[0].contentChanges;
			expect(change.range).toBeUndefined();
			expect(change.text).toBe("const x = 1;\nconst y = 2;\n");
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);
});
