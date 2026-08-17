import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", () => ({ logLatency }));

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

describe("bash grep searchReads registration", () => {
	it("registers bash reads only from a successful tool result", async () => {
		const env = setupTestEnvironment("pi-lens-bash-read-result-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\n");
			const recordRead = vi.fn();
			const base = {
				getFlag: () => false,
				dbg: () => {},
				runtime: Object.assign(new RuntimeCoordinator(), {
					projectRoot: env.tmpDir,
				}),
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any;
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `cat ${filePath}` },
					content: [{ type: "text", text: "one\\ntwo\\nthree" }],
				},
			});
			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({ filePath, effectiveOffset: 1 }),
			);
			recordRead.mockClear();
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					isError: true,
					input: { command: `cat ${filePath}` },
					content: [{ type: "text", text: "permission denied" }],
				},
			});
			expect(recordRead).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("does not register grep output from a failed bash result", async () => {
		const env = setupTestEnvironment("pi-lens-bash-failed-grep-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\n");
			const recordRead = vi.fn();
			const base = {
				getFlag: () => false,
				dbg: () => {},
				runtime: Object.assign(new RuntimeCoordinator(), { projectRoot: env.tmpDir }),
				cacheManager: new CacheManager(false),
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any;
			await handleToolResult({
				...base,
				event: {
					toolName: "bash", isError: true,
					input: { command: `grep -n two ${filePath}; false` },
					content: [{ type: "text", text: `${filePath}:2:two` }],
				},
			});
			expect(recordRead).not.toHaveBeenCalled();
		} finally { env.cleanup(); }
	});

	it("records grep -n output lines as read-guard search reads", async () => {
		const env = setupTestEnvironment("pi-lens-grep-search-reads-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const recordRead = vi.fn();

			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `grep -n line9 ${filePath}` },
					details: {},
					content: [{ type: "text", text: "9:line9" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 7,
					effectiveLimit: 5,
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("monorepo turn-state cwd alignment", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("writes turn state under workspace root, not the nested language root", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-monorepo-cwd-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// Simulate a monorepo: workspace root with a nested Go module
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = path.join(goModuleDir, "main.go");
			fs.mkdirSync(goModuleDir, { recursive: true });
			fs.writeFileSync(
				path.join(goModuleDir, "go.mod"),
				"module daemon\n\ngo 1.22\n",
			);
			fs.writeFileSync(filePath, "package main\n\nfunc main() {}\n");

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.setTelemetryIdentity({ sessionId: "monorepo-session" });
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 package main" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// Turn state must be readable from the workspace root — this is
			// the cwd that turn_end uses. Before the fix, the state was
			// written under the Go module root instead, causing turn_end to
			// see an empty files map and skip the actionable-warnings phase.
			const turnState = cacheManager.readTurnState(workspaceRoot);
			const files = Object.keys(turnState.files);
			expect(files.length).toBeGreaterThan(0);
			expect(files[0]).toContain("main.go");

			// The language root's turn state should NOT have the file —
			// all turn state belongs under the workspace root.
			const langRootState = cacheManager.readTurnState(goModuleDir);
			expect(Object.keys(langRootState.files).length).toBe(0);

			// Project sequence/change-log bookkeeping is also workspace-scoped.
			expect(readChangesSince(workspaceRoot, 0)).toMatchObject([
				{ source: "agent-edit", filePath },
			]);
			expect(readChangesSince(goModuleDir, 0)).toEqual([]);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("still dispatches pipeline to the language root for linting", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-monorepo-dispatch-");
		try {
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = path.join(goModuleDir, "main.go");
			fs.mkdirSync(goModuleDir, { recursive: true });
			fs.writeFileSync(
				path.join(goModuleDir, "go.mod"),
				"module daemon\n\ngo 1.22\n",
			);
			fs.writeFileSync(filePath, "package main\n\nfunc main() {}\n");

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 package main" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// Pipeline must receive the language root (Go module dir) as cwd,
			// not the workspace root — linters need to run from there.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledWith(
				expect.objectContaining({
					cwd: goModuleDir,
					filePath,
				}),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("runtime-tool-result inline behavior warnings", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("appends project change log entries for analyzed agent edits", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-change-log-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "change-session" });
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			const changes = readChangesSince(env.tmpDir, 0);
			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				seq: 1,
				sessionId: "change-session",
				turnIndex: 1,
				source: "agent-edit",
				filePath,
				fileSeq: 1,
				changedRange: { start: 1, end: 1 },
			});
			expect(runtime.projectSeq).toBe(1);
			expect(runtime.getFileSeq(filePath)).toBe(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("queues successful write/edit files for deferred formatting by default", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-deferred-format-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const deferFormat = vi.fn();
			const deferMutation = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat,
					deferMutation,
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(deferFormat).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				"edit",
				env.tmpDir,
				undefined,
			);
			expect(deferMutation).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				"edit",
				env.tmpDir,
				"autofix",
				undefined,
			);
		} finally {
			env.cleanup();
		}
	});

	it("returns authoritative full content after immediate write autofix", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-post-mutation-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const value = 1;\n");
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				changedFiles: [filePath],
				postMutation: { filePath, content: fs.readFileSync(filePath, "utf-8"), source: "autofix" },
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: { toolName: "write", input: { path: filePath }, content: [{ type: "text", text: "base" }] },
				getFlag: () => false,
				dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			expect(returned?.content.at(-1)?.text).toContain(fs.readFileSync(filePath, "utf-8"));
			expect(returned?.content.at(-1)?.text).toContain("authoritative");
		} finally { env.cleanup(); }
	});

	it("runs bash synthetic writes immediately and returns authoritative content", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-write-");
		try {
			const filePath = createTempFile(env.tmpDir, "bash.ts", "const bash = true;\n");
			vi.mocked(runPipeline).mockImplementation(async (ctx) => ({
				output: "", hasBlockers: false, isError: false, fileModified: true,
				changedFiles: [filePath],
				postMutation: ctx.autofixMode === "immediate"
					? { filePath, content: fs.readFileSync(filePath, "utf-8"), source: "autofix" }
					: undefined,
			}));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: { toolName: "bash", input: { command: `echo x > "${filePath}"` }, content: [{ type: "text", text: "bash ok" }] },
				getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			expect(vi.mocked(runPipeline).mock.calls[0][0].autofixMode).toBe("immediate");
			expect(returned?.content.some((part) => part.text?.includes("authoritative"))).toBe(true);
		} finally { env.cleanup(); }
	});

	it("shares one authoritative-content budget across a multi-file bash write", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-budget-");
		try {
			// Each file's post-fix content fits the per-attachment cap (2 MiB) on
			// its own, but the pair exceeds it — the second attachment must
			// degrade to the re-read warning instead of inflating the aggregate
			// tool result without bound.
			const bigContent = "x".repeat(1.5 * 1024 * 1024);
			const fileA = createTempFile(env.tmpDir, "budget-a.ts", bigContent);
			const fileB = createTempFile(env.tmpDir, "budget-b.ts", bigContent);
			vi.mocked(runPipeline).mockImplementation(async (ctx) => ({
				output: "", hasBlockers: false, isError: false, fileModified: true,
				changedFiles: [ctx.filePath],
				postMutation: { filePath: ctx.filePath, content: bigContent, source: "autofix" },
			}));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: { toolName: "bash", input: { command: `echo x > "${fileA}"; echo x > "${fileB}"` }, content: [] },
				getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			const authoritative = returned?.content.filter((part) =>
				part.text?.startsWith("pi-lens applied autofix to"),
			);
			const warnings = returned?.content.filter((part) =>
				part.text?.includes("aggregate authoritative content"),
			);
			expect(authoritative).toHaveLength(1);
			expect(warnings).toHaveLength(1);
		} finally { env.cleanup(); }
	});

	it("demotes a bash write followed by an edit through the handler", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const formatEventsPublish = await import("../../clients/format-events-publish.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-edit-");
		try {
			const filePath = createTempFile(env.tmpDir, "bash-edit.ts", "let value = 1;\n");
			vi.mocked(runPipeline).mockResolvedValue({ output: "", hasBlockers: false, isError: false, fileModified: false });
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const emit = vi.fn();
			formatEventsPublish.wireFormatEventsBusEmitter(emit);
			const base = {
				getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any;
			await handleToolResult({ ...base, event: { toolName: "bash", input: { command: `echo x > "${filePath}"` }, content: [] } });
			fs.writeFileSync(filePath, "let value = 2;\n");
			await handleToolResult({ ...base, event: { toolName: "edit", input: { path: filePath }, content: [] } });
			expect(vi.mocked(runPipeline).mock.calls.map((call) => call[0].autofixMode)).toEqual(["immediate", "deferred"]);
			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(new Set(["format", "autofix"]));
			expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ kinds: ["autofix", "format"] });
		} finally {
			formatEventsPublish._resetFormatEventsPublishForTests();
			env.cleanup();
		}
	});

	it("clears already-fixed state through an alias spelling on edit", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-fixed-alias-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/alias.ts", "let alias = 1;\n");
			let aliasPath = filePath.toUpperCase();
			if (!fs.existsSync(aliasPath)) {
				aliasPath = path.join(env.tmpDir, "alias-link.ts");
				fs.symlinkSync(filePath, aliasPath, "file");
			}
			const runtime = new RuntimeCoordinator(); runtime.projectRoot = env.tmpDir;
			runtime.recordMutationToolReceipt(filePath, "write");
			runtime.fixedThisTurn.add(filePath);
			vi.mocked(runPipeline).mockImplementation(async (_ctx, deps) => {
				expect(deps.fixedThisTurn.has(filePath)).toBe(false);
				return { output: "", hasBlockers: false, isError: false, fileModified: false };
			});
			await handleToolResult({
				event: { toolName: "edit", input: { path: aliasPath }, content: [] }, getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) }, biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {}, agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally { env.cleanup(); }
	});

	it("queues format with deferred autofix under --immediate-format", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-immediate-format-");
		try {
			const filePath = createTempFile(env.tmpDir, "flag.ts", "let flag = 1;\n");
			vi.mocked(runPipeline).mockResolvedValue({ output: "", hasBlockers: false, isError: false, fileModified: false });
			const runtime = new RuntimeCoordinator(); runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: { toolName: "edit", input: { path: filePath }, content: [] },
				getFlag: (name: string) => name === "immediate-format", dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {},
				agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(new Set(["autofix", "format"]));
		} finally { env.cleanup(); }
	});

	it("does not attach authoritative content above the LSP byte limit", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-large-content-");
		try {
			logLatency.mockClear();
			const boundaryPath = createTempFile(env.tmpDir, "boundary.ts", "x\n");
			const filePath = createTempFile(env.tmpDir, "large.ts", "x\n");
			const boundaryContent = "x".repeat(2 * 1024 * 1024);
			const content = `${boundaryContent}x`;
			vi.mocked(runPipeline)
				.mockResolvedValueOnce({ output: "", hasBlockers: false, isError: false, fileModified: true, changedFiles: [boundaryPath], postMutation: { filePath: boundaryPath, content: boundaryContent, source: "autofix" } })
				.mockResolvedValueOnce({ output: "", hasBlockers: false, isError: false, fileModified: true, changedFiles: [filePath], postMutation: { filePath, content, source: "autofix" } });
			const runtime = new RuntimeCoordinator(); runtime.projectRoot = env.tmpDir;
			const boundaryReturned = await handleToolResult({
				event: { toolName: "write", input: { path: boundaryPath }, content: [] }, getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) }, biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {}, agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			const returned = await handleToolResult({
				event: { toolName: "write", input: { path: filePath }, content: [] }, getFlag: () => false, dbg: () => {}, runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) }, biomeClient: {}, ruffClient: {}, metricsClient: {}, resetLSPService: () => {}, agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "",
			} as any);
			expect(boundaryReturned?.content.some((part) => part.text?.includes(boundaryContent))).toBe(true);
			expect(returned?.content.some((part) => part.text?.includes(content))).toBe(false);
			expect(returned?.content.at(-1)?.text).toContain("too large to attach");
			expect(logLatency).toHaveBeenCalledWith(expect.objectContaining({
				phase: "authoritative_content_attachment_decision",
				metadata: expect.objectContaining({ bytes: boundaryContent.length, decision: "attached" }),
			}));
			expect(logLatency).toHaveBeenCalledWith(expect.objectContaining({
				phase: "authoritative_content_attachment_decision",
				metadata: expect.objectContaining({ bytes: content.length, decision: "size-capped" }),
			}));
		} finally { env.cleanup(); }
	});

	it("publishes pilens:format:queued only when deferFormat reports a NEW queue entry (#673)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});
		const formatEventsPublish = await import(
			"../../clients/format-events-publish.js"
		);

		const env = setupTestEnvironment("pi-lens-runtime-tool-format-queued-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const emit = vi.fn();
			formatEventsPublish.wireFormatEventsBusEmitter(emit);

			const baseDeps = {
				getFlag: () => false,
				dbg: () => {},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			};
			const runtimeStub = {
				projectRoot: env.tmpDir,
				setTelemetryIdentity: () => {},
				updateGitGuardStatus: () => {},
				appendCascadeResult: () => {},
				recordInlineBlockers: () => {},
				clearInlineBlockers: () => {},
				nextWriteIndex: () => 1,
				turnIndex: 1,
				telemetryModel: "test-model",
				telemetrySessionId: "test-session",
				fixedThisTurn: new Set<string>(),
				reportedThisTurn: new Set<string>(),
				formatPipelineCrashNotice: () => "",
				lastCascadeOutput: "",
				cachedExports: new Map(),
			};

			// First touch: deferFormat reports a NEW entry -> publish fires.
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				runtime: { ...runtimeStub, deferFormat: () => true },
				...baseDeps,
			} as any);

			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit).toHaveBeenCalledWith(
				"pilens:format:queued",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					tool: "edit",
					filePath: filePath.replace(/\\/g, "/"),
				}),
			);

			// Second touch (re-edit before agent_end): deferFormat reports a
			// re-touch (not new) -> no second publish, avoiding event spam.
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				runtime: { ...runtimeStub, deferFormat: () => false },
				...baseDeps,
			} as any);

			expect(emit).toHaveBeenCalledTimes(1);
		} finally {
			formatEventsPublish._resetFormatEventsPublishForTests();
			env.cleanup();
		}
	});

	it("does not append behavior warnings when blockers are present", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "🔴 blocker output",
			hasBlockers: true,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const response = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [
					{
						type: "blind-write",
						message: "⚠ BLIND WRITE",
						severity: "warning",
						details: {},
					},
				],
				formatBehaviorWarnings: () => "⚠ BLIND WRITE",
			} as any);

			const text = response?.content.at(-1)?.text ?? "";
			expect(text).toContain("🔴 blocker output");
			expect(text).not.toContain("⚠ BLIND WRITE");
		} finally {
			env.cleanup();
		}
	});

	it("appends behavior warnings when no blockers are present", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const response = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [
					{
						type: "blind-write",
						message: "⚠ BLIND WRITE",
						severity: "warning",
						details: {},
					},
				],
				formatBehaviorWarnings: () => "⚠ BLIND WRITE",
			} as any);

			const text = response?.content.at(-1)?.text ?? "";
			expect(text).toContain("✓ no blockers");
			expect(text).toContain("⚠ BLIND WRITE");
		} finally {
			env.cleanup();
		}
	});

	it("does not emit file-time warnings on rapid consecutive edits", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "rapid.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "value = 1\n");

			const logs: string[] = [];
			const dbg = (msg: string) => logs.push(msg);

			const deps = {
				getFlag: () => false,
				dbg,
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			await handleToolResult({
				...deps,
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 value = 2" },
					content: [{ type: "text", text: "base" }],
				},
			});

			fs.writeFileSync(filePath, "value = 2\n");

			await handleToolResult({
				...deps,
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 value = 3" },
					content: [{ type: "text", text: "base" }],
				},
			});

			// Distinct same-file states in the same turn must both be analyzed.
			expect(
				logs.filter((entry) => entry.includes("tool_result fired for")).length,
			).toBe(2);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
			expect(
				logs.some((entry) =>
					entry.includes("skipping already-analyzed file state this turn"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("deduplicates repeated tool_result events for the same file state", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-dedupe-");
		try {
			const filePath = path.join(env.tmpDir, "src", "same.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const value = 1;\n");

			const logs: string[] = [];
			const deps = {
				getFlag: () => false,
				dbg: (msg: string) => logs.push(msg),
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			const event = {
				toolName: "edit",
				input: { path: filePath },
				details: { diff: "+  1 export const value = 1;" },
				content: [{ type: "text", text: "base" }],
			};

			await handleToolResult({ ...deps, event });
			await handleToolResult({ ...deps, event });

			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
			expect(
				logs.some((entry) =>
					entry.includes("skipping already-analyzed file state this turn"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("tracks side-effect files changed by the pipeline", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-side-effect-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			const sideEffectPath = path.join(env.tmpDir, "src", "helper.rs");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "mod helper;\n");
			fs.writeFileSync(sideEffectPath, "pub fn helper() {}\n");

			vi.mocked(runPipeline).mockResolvedValue({
				output: "✅ Auto-fixed 1 issue(s)",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				changedFiles: [filePath, sideEffectPath],
			});

			const modifiedRanges: Array<{
				filePath: string;
				range: { start: number; end: number };
			}> = [];
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 mod helper;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: (
						changedFile: string,
						range: { start: number; end: number },
					) => {
						modifiedRanges.push({ filePath: changedFile, range });
					},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(modifiedRanges.map((entry) => entry.filePath)).toContain(
				sideEffectPath,
			);
		} finally {
			env.cleanup();
		}
	});

	it("uses fast LSP reset when pipeline crash recovery resets clients", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockRejectedValue(new Error("boom"));

		const env = setupTestEnvironment("pi-lens-runtime-tool-crash-reset-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const resetLSPService = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(resetLSPService).toHaveBeenCalledWith({ fast: true, reason: "pipeline_crash" });
		} finally {
			env.cleanup();
		}
	});

	it("resolves relative tool_result paths against the workspace root", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-path-");
		try {
			const projectRoot = path.join(env.tmpDir, "workspace");
			const filePath = path.join(projectRoot, "python-utils", "app", "main.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "VALUE = 1\n");

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: "python-utils/app/main.py" },
					details: { diff: "+  1 VALUE = 2" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(vi.mocked(runPipeline)).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
				}),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#484 turn-summary collection gate", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("does not record diagnostics/autofix/format on the turn-summary collector when lens-turn-summary is off (default)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: true,
			diagnostics: [
				{
					id: "d1",
					message: "unused var",
					filePath: "/repo/src/app.ts",
					line: 4,
					severity: "warning",
					semantic: "warning",
					tool: "eslint",
					rule: "no-unused-vars",
				},
			],
			formattersUsed: ["prettier"],
			fixedCount: 1,
			autofixTools: ["ruff:1"],
		});

		const env = setupTestEnvironment("pi-lens-turn-summary-off-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				// lens-turn-summary is never true here — default off
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(runtime.turnSummary.isEmpty()).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("records diagnostics, autofix, and format events on the turn-summary collector when lens-turn-summary is on", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: true,
			diagnostics: [
				{
					id: "d1",
					message: "unused var",
					filePath: "/repo/src/app.ts",
					line: 4,
					severity: "warning",
					semantic: "warning",
					tool: "eslint",
					rule: "no-unused-vars",
				},
			],
			formattersUsed: ["prettier"],
			fixedCount: 1,
			autofixTools: ["ruff:1"],
		});

		const env = setupTestEnvironment("pi-lens-turn-summary-on-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: (name: string) => name === "lens-turn-summary",
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(runtime.turnSummary.isEmpty()).toBe(false);
			const details = runtime.turnSummary.consume(1);
			expect(details.counts).toEqual({
				diagnostics: 1,
				autofixes: 1,
				formats: 1,
				byTool: {
					diagnostic: { eslint: 1 },
					autofix: { ruff: 1 },
					format: { prettier: 1 },
				},
			});
		} finally {
			env.cleanup();
		}
	});
});
