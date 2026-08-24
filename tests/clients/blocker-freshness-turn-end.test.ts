/**
 * Turn-end integration for the blocker freshness gate (#1631).
 *
 * Drives the real `handleTurnEnd` and asserts the two agent-visible guarantees:
 *   1. A cached blocker whose dependency drifted out-of-band is NOT re-served as an
 *      authoritative "Unresolved from this turn" blocker; it is demoted to a
 *      `[stale — re-run to confirm]` advisory (acceptance criteria 1–2).
 *   2. Every turn end emits one `blocker_freshness_sweep` latency record naming the
 *      revalidated/retired/kept counts (acceptance criterion 5), so a future replay
 *      incident is reconstructible from `~/.pi-lens/latency.log` alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
});

describe("turn-end blocker freshness (#1631)", () => {
	it("re-serves a drifted blocker as a [stale] advisory, not an authoritative blocker, and logs the sweep", async () => {
		const env = setupTestEnvironment("pi-lens-fresh-turnend-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "fresh-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			// Consumer test file + the dependency it imports.
			const consumer = path.join(env.tmpDir, "git-env.test.ts");
			const dep = path.join(env.tmpDir, "worktree.ts");
			fs.mkdirSync(path.dirname(consumer), { recursive: true });
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
			);

			// The agent edited the consumer; the dispatch recorded a blocker.
			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				"fresh-session",
			);
			runtime.recordInlineBlockers(
				consumer,
				"🔴 L1 No exported member 'gitEnv' on './worktree.js'",
				1,
				["lsp"],
			);

			// The dependency is fixed out-of-band after the verdict.
			driftIntoFuture(dep);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			// The turn-end advisory must NOT re-assert the stale blocker.
			const findings = cacheManager.readCache<{ content: string }>(
				"turn-end-findings",
				env.tmpDir,
			);
			const content = findings?.data?.content ?? "";
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).toContain(path.basename(consumer));
			expect(content).not.toContain("Unresolved from this turn");

			// One bounded latency record names the freshness counts.
			const sweepRecord = logLatency.mock.calls
				.map((call) => call[0])
				.find(
					(entry: any) =>
						entry?.type === "phase" &&
						entry?.phase === "blocker_freshness_sweep",
				);
			expect(sweepRecord).toBeDefined();
			expect(sweepRecord.metadata).toMatchObject({
				total: 1,
				revalidated: 1,
				kept: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("still re-serves an un-drifted blocker as an authoritative blocker", async () => {
		const env = setupTestEnvironment("pi-lens-fresh-turnend-keep-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "keep-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.mkdirSync(path.dirname(consumer), { recursive: true });
			fs.writeFileSync(dep, "export const x = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { x } from "./dep.js";\nexport const y = x;\n',
			);

			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				"keep-session",
			);
			runtime.recordInlineBlockers(consumer, "🔴 a real blocker", 1, ["lsp"]);
			// Pin the dependency in the past so it cannot read as drifted.
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(dep, past, past);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const findings = cacheManager.readCache<{ content: string }>(
				"turn-end-findings",
				env.tmpDir,
			);
			const content = findings?.data?.content ?? "";
			expect(content).toContain("Unresolved from this turn");
			expect(content).not.toContain("[stale — re-run to confirm]");
		} finally {
			env.cleanup();
		}
	});
});
