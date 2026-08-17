import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { resolvePiLensFlag } from "../../clients/lens-config.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { loadPiLensProjectConfig } from "../../clients/project-lens-config.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { getLastLoggedPhase } from "../../clients/latency-logger.js";
import * as latencyLogger from "../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import {
	_resetFormatEventsPublishForTests as resetFormatEventsPublish,
	wireFormatEventsBusEmitter,
} from "../../clients/format-events-publish.js";

// Only the "stale report" test below enables lens-actionable-warning-autofix,
// and it returns before reaching applyConservativeActionableWarningFixes (the
// staleness check short-circuits first) — safe to mock this at module scope
// for the dedicated #502 fix-provenance test further down without affecting
// any other test in this file.
const applyConservativeActionableWarningFixesMock = vi.fn();
vi.mock("../../clients/actionable-warnings.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/actionable-warnings.js")>();
	return {
		...actual,
		applyConservativeActionableWarningFixes: (
			...args: Parameters<typeof actual.applyConservativeActionableWarningFixes>
		) => applyConservativeActionableWarningFixesMock(...args),
	};
});

describe("runtime-agent-end deferred formatting", () => {
	it("does not resolve autofix clients for format-only records", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-only-clients-");
		try {
			const filePath = createTempFile(env.tmpDir, "format-only.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator(); runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "write", env.tmpDir);
			const getAutofixClients = vi.fn();
			await handleAgentEnd({
				ctxCwd: env.tmpDir, getFlag: (name) => name === "no-lsp", notify: vi.fn(), dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile: async (fp: string) => ({ filePath: fp, formatters: [], anyChanged: false, allSucceeded: true }) }) as any,
				getAutofixClients,
			});
			expect(getAutofixClients).not.toHaveBeenCalled();
		} finally { env.cleanup(); }
	});

	it("merges both phases when an aborted drain requeues one path twice", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-both-abort-");
		const controller = new AbortController();
		controller.abort();
		setAmbientAbortSignal(controller.signal);
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "both.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");

			await handleAgentEnd({
				ctxCwd: env.tmpDir, getFlag: (name) => name === "no-lsp",
				notify: vi.fn(), dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(new Set(["autofix", "format"]));
			// S2d (gap 4, #1432 review): one per-requeue record per abort branch,
			// distinguishable by reason/kinds instead of collapsing into the
			// aggregate drain row's coalesced requeuedKinds set.
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
				phase: "agent_end_deferred_mutation_requeue",
				metadata: expect.objectContaining({ reason: "abort", kinds: ["autofix"], fileCount: 1 }),
			}));
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
				phase: "agent_end_deferred_mutation_requeue",
				metadata: expect.objectContaining({ reason: "abort", kinds: ["format"], fileCount: 1 }),
			}));
		} finally {
			setAmbientAbortSignal(undefined);
			env.cleanup();
		}
	});

	it("preserves both kinds when autofix clients and formatting fail", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-both-fail-");
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "both.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");

			await handleAgentEnd({
				ctxCwd: env.tmpDir, getFlag: (name) => name === "no-lsp",
				notify: vi.fn(), dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({
					recordRead: () => {},
					formatFile: async () => { throw new Error("format failed"); },
				}) as any,
			});

			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(new Set(["autofix", "format"]));
			// S2d (gap 4, #1432 review): no biomeClient/ruffClient were passed, so
			// the autofix branch requeues for "clients-unavailable"; the format
			// branch requeues separately for "format-failed" — two distinct
			// per-requeue records, not one indistinguishable aggregate.
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
				phase: "agent_end_deferred_mutation_requeue",
				metadata: expect.objectContaining({ reason: "clients-unavailable", kinds: ["autofix"], fileCount: 1 }),
			}));
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
				phase: "agent_end_deferred_mutation_requeue",
				metadata: expect.objectContaining({ reason: "format-failed", kinds: ["format"], fileCount: 1 }),
			}));
		} finally { env.cleanup(); }
	});

	it("runs deferred autofix before format on the final edit state", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-mutation-order-");
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "let value=1\n");
			fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");
			const order: string[] = [];
			const biomeClient = {
				isSupportedFile: () => true,
				ensureAvailable: async () => true,
				fixFileAsync: async (fp: string) => {
					order.push("autofix");
					fs.writeFileSync(fp, "const value=1\n");
					return { success: true, changed: true, fixed: 1 };
				},
			};
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(), dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				biomeClient: biomeClient as any,
				ruffClient: {} as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile: async (fp: string) => {
					order.push("format");
					fs.writeFileSync(fp, "const value = 1;\n");
					return { filePath: fp, formatters: [{ name: "biome", success: true, changed: true }], anyChanged: true, allSucceeded: true };
				} }) as any,
			});
			expect(order).toEqual(["autofix", "format"]);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("const value = 1;\n");
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
				phase: "agent_end_deferred_mutation_drain",
				metadata: expect.objectContaining({
					autofixRecords: 1, formatRecords: 1, coalescedPaths: 1, requeuedKinds: [],
				}),
			}));
		} finally { env.cleanup(); }
	});

	it("formats each queued file once, clears the queue, and records a format change", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(filePath, env.tmpDir, "write", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});
			const modifiedRanges: Array<{ filePath: string; range: unknown }> = [];
			const notify = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify,
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: (changedFile: string, range: unknown) => {
						modifiedRanges.push({ filePath: changedFile, range });
					},
				} as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile,
					}) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(1);
			expect(summary?.queued).toBe(1);
			expect(summary?.changed).toEqual([filePath]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(modifiedRanges.map((entry) => entry.filePath)).toEqual([filePath]);
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{
					seq: 1,
					source: "format",
					filePath,
					fileSeq: 1,
				},
			]);
			expect(notify).toHaveBeenCalledWith(
				"pi-lens deferred format applied to 1 file(s): app.ts",
				"info",
			);
			expect(getLastLoggedPhase()?.phase).toBe("agent_end_deferred_format_done");
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("formats multiple files and preserves all side effects", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-multi-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const file1 = createTempFile(env.tmpDir, "src/a.ts", "const a=1");
			const file2 = createTempFile(env.tmpDir, "src/b.ts", "const b=2");
			const file3 = createTempFile(env.tmpDir, "src/c.ts", "const c=3");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(file1, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(file2, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(file3, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8") + "\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const modifiedRanges: string[] = [];
			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: (fp: string) =>
						modifiedRanges.push(path.basename(fp)),
				} as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			// All three files formatted
			expect(formatFile).toHaveBeenCalledTimes(3);
			expect(summary?.queued).toBe(3);
			expect(summary?.changed).toHaveLength(3);

			// Side effects recorded for all three files
			expect(modifiedRanges).toHaveLength(3);
			expect(readChangesSince(env.tmpDir, 0)).toHaveLength(3);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("bounds formatter concurrency and yields between ordered bookkeeping (#1387)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-yield-");
		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		try {
			const files = Array.from({ length: 10 }, (_, index) =>
				createTempFile(env.tmpDir, `${index}.ts`, `const x${index}=1`),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (const file of files) {
				runtime.deferFormat(file, env.tmpDir, "edit", env.tmpDir);
			}
			let inFlight = 0;
			let maxInFlight = 0;
			const immediateCallsAtBookkeeping: number[] = [];
			const formatFile = vi.fn(async (filePath: string) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise<void>((resolve) => setImmediate(resolve));
				inFlight--;
				return {
					filePath,
					formatters: [{ name: "fake", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: vi.fn(() => {
						immediateCallsAtBookkeeping.push(setImmediateSpy.mock.calls.length);
					}),
				} as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(files.length);
			expect(maxInFlight).toBeLessThanOrEqual(3);
			expect(maxInFlight).toBe(3);
			expect(immediateCallsAtBookkeeping).toHaveLength(files.length);
			for (let index = 1; index < immediateCallsAtBookkeeping.length; index++) {
				expect(immediateCallsAtBookkeeping[index]).toBeGreaterThan(
					immediateCallsAtBookkeeping[index - 1],
				);
			}
		} finally {
			setImmediateSpy.mockRestore();
			env.cleanup();
		}
	});

	it("requeues claimed files that were not started when the ambient turn aborts", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-abort-");
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
				createTempFile(env.tmpDir, name, `const ${name[0]}=1`),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (const file of files) runtime.deferFormat(file, env.tmpDir, "edit", env.tmpDir);
			const started: string[] = [];
			const formatFile = vi.fn(async (filePath: string) => {
				started.push(filePath);
				controller.abort();
				return {
					filePath,
					formatters: [{ name: "fake", success: true, changed: false }],
					anyChanged: false,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(started).toHaveLength(1);
			expect(runtime.pendingDeferredFormatCount).toBe(2);
			expect(runtime.consumeDeferredFormatFiles().map((record) => record.filePath)).toEqual(
				files.slice(1),
			);
		} finally {
			setAmbientAbortSignal(undefined);
			env.cleanup();
		}
	});

	it("rejects deferFormat calls that omit turnStateCwd at compile time (PR #114 lock)", () => {
		const runtime = new RuntimeCoordinator();
		// @ts-expect-error — turnStateCwd is required; omitting it would
		// silently reintroduce the monorepo cwd-mismatch bug PR #105 fixed.
		runtime.deferFormat("/some/file.ts", "/dispatch/cwd", "edit");
		// Sanity: the correct 4-arg form compiles and registers the entry.
		runtime.deferFormat(
			"/some/file.ts",
			"/dispatch/cwd",
			"edit",
			"/workspace/root",
		);
		expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);
	});

	it("records deferred format bookkeeping under the workspace root in monorepos", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-monorepo-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = createTempFile(
				goModuleDir,
				"main.go",
				"package main\n\nfunc main() {}\n",
			);
			createTempFile(goModuleDir, "go.mod", "module daemon\n\ngo 1.22\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.deferFormat(filePath, goModuleDir, "edit", workspaceRoot);
			const cacheManager = new CacheManager(false);
			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, `${fs.readFileSync(fp, "utf-8")}\n`);
				return {
					filePath: fp,
					formatters: [{ name: "gofmt", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: workspaceRoot,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(1);
			expect(readChangesSince(workspaceRoot, 0)).toMatchObject([
				{ source: "format", filePath },
			]);
			expect(readChangesSince(goModuleDir, 0)).toEqual([]);
			expect(Object.keys(cacheManager.readTurnState(workspaceRoot).files)).toEqual([
				"platform/svc/go/daemon/main.go",
			]);
			expect(Object.keys(cacheManager.readTurnState(goModuleDir).files)).toEqual(
				[],
			);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("skips actionable warning autofix when the cached report is stale", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-stale-aw-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(2);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [],
				summary: {
					warnings: 0,
					unsuppressed: 0,
					suppressed: 0,
					files: 0,
					actions: 0,
					autoFixEligible: 0,
				},
			};
			const dbg = vi.fn();
			const notify = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" || name === "no-lsp",
				notify,
				dbg,
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(summary?.queued).toBe(0);
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("stale report (project_seq_mismatch"),
			);
			expect(notify).not.toHaveBeenCalledWith(
				expect.stringContaining("conservative LSP warning quickfix"),
				"info",
			);
		} finally {
			env.cleanup();
		}
	});

	it("project config disables actionable warning autofix", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-project-policy-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({
					actionableWarnings: { autoFix: { enabled: false } },
				}),
			);
			const projectConfig = loadPiLensProjectConfig(env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const readCache = vi.fn();
			applyConservativeActionableWarningFixesMock.mockClear();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					resolvePiLensFlag(
						name,
						undefined,
						{ actionableWarnings: { autoFix: { enabled: true } } },
						projectConfig,
					),
				notify: vi.fn(),
				dbg: vi.fn(),
				runtime,
				cacheManager: { readCache } as any,
				getFormatService: () => ({}) as any,
			});

			expect(summary).toBeUndefined();
			expect(readCache).not.toHaveBeenCalled();
			expect(applyConservativeActionableWarningFixesMock).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("skips actionable warning autofix for files excluded by project ignore (#1247)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-ignore-");
		try {
			const filePath = createTempFile(env.tmpDir, "CHANGELOG.md", "# Title\n");
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["CHANGELOG.md"] }),
			);
			loadPiLensProjectConfig(env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "CHANGELOG.md",
						warnings: [
							{
								id: "aw:1",
								filePath,
								displayPath: "CHANGELOG.md",
								severity: "warning",
								tool: "markdownlint",
								message: "list indent",
								suppressed: false,
								origin: "dispatch",
								actions: [
									{
										title: "Fix list indent",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
			const dbg = vi.fn();
			applyConservativeActionableWarningFixesMock.mockClear();

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" || name === "no-lsp",
				notify: vi.fn(),
				dbg,
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(applyConservativeActionableWarningFixesMock).not.toHaveBeenCalled();
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("ignored by project"),
			);
		} finally {
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	});

	it("skips queued files when autoformat is disabled", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);
			const formatFile = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-autoformat" || name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile,
					}) as any,
			});

			expect(formatFile).not.toHaveBeenCalled();
			expect(summary?.skipped).toEqual([{ filePath, reason: "no-autoformat" }]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("publishes pilens:files:touched reason:\"format\" for deferred-format changed files (#482)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(emit).toHaveBeenCalledWith(
				"pilens:files:touched",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					reason: "format",
					paths: [filePath.replace(/\\/g, "/")],
				}),
			);
		} finally {
			resetBusPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("publishes pilens:format:start with the queued paths at deferred-format start (#673)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-format-start-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(emit).toHaveBeenCalledWith(
				"pilens:format:start",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					fileCount: 1,
					paths: [filePath.replace(/\\/g, "/")],
				}),
			);
		} finally {
			resetFormatEventsPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("does not publish pilens:format:start when there is nothing queued (#673)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-format-start-empty-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(emit).not.toHaveBeenCalledWith(
				"pilens:format:start",
				expect.anything(),
			);
		} finally {
			resetFormatEventsPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("includes fix-provenance entries (kind:\"format\") for deferred-format changed files (#502)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-fixes-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "prettier", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			const call = emit.mock.calls.find((c) => c[0] === "pilens:files:touched");
			expect(call?.[1]).toMatchObject({
				fixes: [
					{
						path: filePath.replace(/\\/g, "/"),
						tool: "prettier",
						kind: "format",
					},
				],
			});
		} finally {
			resetBusPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("includes fix-provenance entries (tool:\"lsp-quickfix\", kind:\"autofix\") for actionable-warning autofix changed files (#502)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-fixes-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "src/app.ts",
						warnings: [
							{
								id: "aw:502",
								filePath,
								displayPath: "src/app.ts",
								severity: "warning",
								tool: "typescript",
								message: "unused var",
								suppressed: false,
								origin: "dispatch",
								actions: [
									{
										title: "Remove unused var",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
			applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
				considered: 1,
				applied: 1,
				changedFiles: [filePath],
				skipped: [],
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" || name === "no-lsp",
				notify: vi.fn(),
				dbg: vi.fn(),
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			const call = emit.mock.calls.find((c) => c[0] === "pilens:files:touched");
			expect(call?.[1]).toMatchObject({
				reason: "autofix",
				fixes: [
					{
						path: filePath.replace(/\\/g, "/"),
						tool: "lsp-quickfix",
						kind: "autofix",
					},
				],
			});
		} finally {
			resetBusPublish();
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	});

	describe("pilens:autofix:start (#684)", () => {
		function eligibleReport(
			filePath: string,
			projectSeqEnd: number,
		): ActionableWarningsReport {
			return {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "app.ts",
						warnings: [
							{
								id: "aw:1",
								filePath,
								displayPath: "app.ts",
								severity: "warning",
								tool: "eslint",
								message: "unused var",
								actions: [
									{
										title: "Remove unused variable",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
								suppressed: false,
								origin: "lsp",
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
		}

		it("publishes pilens:autofix:start with the eligible paths when the report is fresh and non-empty", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-start-");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(1);
				const report = eligibleReport(filePath, 1);
				applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
					considered: 1,
					applied: 1,
					changedFiles: [filePath],
					skipped: [],
				});

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.objectContaining({
						v: 1,
						source: "pi-lens",
						fileCount: 1,
						eligibleCount: 1,
						paths: [filePath.replace(/\\/g, "/")],
					}),
				);
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the cached report is stale", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-stale-");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(2);
				// projectSeqEnd (1) mismatches the current project seq (2) — stale.
				const report = eligibleReport(filePath, 1);

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
				expect(applyConservativeActionableWarningFixesMock).not.toHaveBeenCalled();
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the cached report is missing", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-missing-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => undefined,
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
			} finally {
				resetFormatEventsPublish();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the report is fresh but has no autofix-eligible warnings", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-empty-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(1);
				const report: ActionableWarningsReport = {
					generatedAt: new Date().toISOString(),
					scope: "turn_delta",
					sessionId: "s1",
					turnIndex: 1,
					projectSeqEnd: 1,
					deltaOnly: true,
					includeLspCodeActions: true,
					files: [],
					summary: {
						warnings: 0,
						unsuppressed: 0,
						suppressed: 0,
						files: 0,
						actions: 0,
						autoFixEligible: 0,
					},
				};
				applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
					considered: 0,
					applied: 0,
					changedFiles: [],
					skipped: [],
				});

				const dbg = vi.fn();
				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg,
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
				// P2-A: the zero-eligible skip is explicit in the debug log — a
				// regression that collapses eligibleCount to 0 is not silent.
				expect(dbg).toHaveBeenCalledWith(
					expect.stringContaining("0 autofix-eligible warnings, skipping"),
				);
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});
	});

	describe("#791 deferred-format ownership", () => {
		it("a non-owning session's agent_end does NOT format a foreign record; it stays queued", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-foreign-");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				// Turn N: the OWNER (session-parent) writes the file.
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);
				// Turn N+1: a read-only turn begins (e.g. a concurrent in-process
				// subagent's own turn_start), advancing the shared turn counter.
				runtime.beginTurn();

				const formatFile = vi.fn();
				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
					// The non-owner: a different, KNOWN session id.
					currentSessionId: "session-subagent",
				});

				expect(formatFile).not.toHaveBeenCalled();
				expect(summary).toBeUndefined();
				expect(runtime.pendingDeferredFormatCount).toBe(1);
			} finally {
				env.cleanup();
			}
		});

		it("the owning session's agent_end DOES format its own queued record", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-owner-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-parent",
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
				expect(runtime.pendingDeferredFormatCount).toBe(0);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("an unknown current session id falls back to claiming everything (fail-safe: no regression on hosts without stable ids)", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-unknown-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
					// currentSessionId omitted — host never supplied one.
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("staleness fallback: an old orphaned foreign record IS claimed and logged", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-stale-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-dead-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});
				const dbg = vi.fn();

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg,
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-new-secondary",
					// Negative threshold: any elapsed time at all counts as stale,
					// the smallest reliable way to force the fallback without a
					// clock-injection hook.
					staleAfterMs: -1,
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
				expect(runtime.pendingDeferredFormatCount).toBe(0);
				expect(dbg).toHaveBeenCalledWith(
					expect.stringContaining("staleness fallback claimed"),
				);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});
	});

	describe("#484 turn-summary collection gate", () => {
		it("does not record deferred-format events on the turn-summary collector when lens-turn-summary is off (default)", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-off-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					// lens-turn-summary NOT among the true-returning flags — default off
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
				});

				expect(runtime.turnSummary.isEmpty()).toBe(true);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("records a format event on the turn-summary collector when lens-turn-summary is on", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-on-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "no-lsp" || name === "lens-turn-summary",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
				});

				expect(runtime.turnSummary.isEmpty()).toBe(false);
				const details = runtime.turnSummary.consume(1);
				expect(details.files).toHaveLength(1);
				expect(details.files[0].events).toEqual([
					{ kind: "format", tool: "biome" },
				]);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("suppresses the info-level deferred-format success toast when lens-turn-summary is on, but keeps the failure toast", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-toast-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});
				const notify = vi.fn();

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "no-lsp" || name === "lens-turn-summary",
					notify,
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
				});

				// The success info toast is redundant once the transcript entry is
				// opted in — must not fire.
				expect(notify).not.toHaveBeenCalledWith(
					expect.stringContaining("deferred format applied to"),
					"info",
				);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});
	});
});
