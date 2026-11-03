/**
 * #2657: the session registers a WORKSPACE, not every edited file's directory.
 *
 * Recurrence it prevents: `ensureLSPConfigInitialized` was called with
 * `path.dirname(filePath)` from the `tool_call` seam, so every directory an
 * agent touched became a registered session root. The registry is FIFO(128), so
 * a session touching 128 directories cycled it and evicted the project root
 * itself — the entry that carries the operator's `lsp.disabledServers` denial —
 * and the denial failed open (`lsp-session-root-evicted`) until something
 * re-registered that root. `getConfigForFile` also walked a population sized by
 * directories touched rather than by workspaces, on every dispatch.
 *
 * Real: `handleToolCall` (the production call site), `resolveSessionConfigRoot`,
 * the real `initLSPConfig` loader and its session-root registry,
 * `disabledPrimaries` (the denial reader) and the real degradation ledger. No
 * module is mocked: the language server is never spawned on this path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	disabledPrimaries,
	getSessionRootsForTelemetry,
	isSessionRootRegistered,
} from "../../../clients/lsp/session-roots.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { resetSessionScopedState } from "../../../clients/runtime-session.js";
import { handleToolCall } from "../../../clients/runtime-tool-call.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../../clients/lsp/service-singleton.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { runHandlerExpectingNoThrow } from "../../support/handler-verdict.js";
import { setupTestEnvironment } from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let workspace: string;
let runtime: RuntimeCoordinator;

/** index.ts's per-cwd memo, without its registry re-check (same effect here). */
async function memoizedInit(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	if (initialized.has(key)) return;
	await initLSPConfig(key);
	initialized.add(key);
}
const initialized = new Set<string>();

/** One `tool_call` for `filePath`, through the production handler. */
async function readCall(filePath: string, index: number): Promise<void> {
	const deps = {
		event: {
			toolName: "read",
			toolCallId: `2657-${index}`,
			input: { path: filePath },
		},
		ctx: { cwd: workspace },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		// The production wrapper adds a per-cwd memo (index.ts
		// `ensureLSPConfigInitialized`), so a repeated root loads once; the loader
		// below is what registers, and the memo is reproduced here rather than
		// re-loading 200 times.
		ensureLSPConfigInitialized: memoizedInit,
		updateLspStatus: () => {},
		resetLSPService: () => {},
		sessionId: "pi-lens-2657-probe",
	} as unknown as Parameters<typeof handleToolCall>[0];
	await runHandlerExpectingNoThrow(() => handleToolCall(deps));
}

beforeEach(async () => {
	env = setupTestEnvironment("pi-lens-2657-session-root-");
	workspace = path.join(env.tmpDir, "workspace");
	fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
	fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
	// The operator's denial lives at the workspace root, which is the entry the
	// per-directory registrations used to evict.
	fs.writeFileSync(
		path.join(workspace, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: ["typescript"] } }),
	);
	// The shared per-case session reset (AGENTS.md); the LSP config store and
	// the ledger below are owner resets it does not cover.
	resetSessionScopedState();
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	initialized.clear();
	// The language server is the process boundary: a service double keeps this a
	// measurement of the registration rule, not of 200 server round trips.
	resetLSPService();
	const service = makeLspServiceDouble({ supportsLSP: () => false });
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = workspace;
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-2657-probe" });
	runtime.beginTurn();
	await initLSPConfig(workspace);
});

afterEach(() => {
	resetLSPService();
	resetLSPConfigStateForTests();
	env.cleanup();
});

describe("a session root is a workspace (#2657)", () => {
	it("keeps one registry entry across 200 edited files in 200 directories", async () => {
		// 200 files in 200 directories, as the issue's probe names them. The files
		// need not exist: `tool_call` resolves the config root BEFORE it decides
		// whether the target is there, which is also the order a read of a path
		// about to be created takes.
		const files = Array.from({ length: 200 }, (_, index) =>
			path.join(workspace, "src", `pkg-${index}`, "deep", `file-${index}.ts`),
		);
		// The denial applies to a deep file BEFORE the probe …
		expect(disabledPrimaries(files[199]).disabledServerIds).toContain(
			"typescript",
		);

		for (const [index, file] of files.entries()) await readCall(file, index);

		// … the registry still holds exactly one root (the workspace) …
		expect(getSessionRootsForTelemetry(200)).toEqual([workspace]);
		expect(isSessionRootRegistered(workspace)).toBe(true);
		// … no directory was ever registered as its own root …
		expect(isSessionRootRegistered(path.dirname(files[199]))).toBe(false);
		// … nothing was evicted, so the cap was never reached …
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "lsp-session-root-evicted",
			),
		).toHaveLength(0);
		// … and the denial is still in force at the end of the probe.
		expect(disabledPrimaries(files[199]).disabledServerIds).toContain(
			"typescript",
		);
	}, 60_000);

	it("registers a nested config owner below the workspace root", async () => {
		const nested = path.join(workspace, "packages", "app");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
		fs.writeFileSync(
			path.join(nested, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["opengrep"] } }),
		);
		const file = path.join(nested, "src", "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");

		await readCall(file, 900);

		// The nested owner is registered so its own config keeps applying, and
		// the population stays O(config owners), not O(directories).
		expect(getSessionRootsForTelemetry(200)).toContain(nested);
		expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
	});
});
