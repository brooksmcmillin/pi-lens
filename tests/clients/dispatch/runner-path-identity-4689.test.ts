/**
 * #4689 item 6 (batch 7, the #4853 verify F2 member): a runner's file path is
 * the spelling's PATH IDENTITY, so a deferred runner's blockers for a `link/..`
 * spelling meet the inline record the pipeline wrote for the same file.
 *
 * Shape (AGENTS.md shape 1, "never put `path.resolve` in front of an identity
 * key"): `resolveAgainstAncestors` answered an absolute spelling with
 * `path.resolve`, which folds a `..` after a directory link lexically.
 * `repo/src/linked` is a link to `repo/shared`, so `repo/src/linked/../shared/
 * util.ts` names `repo/shared/util.ts` to the kernel and `repo/src/shared/
 * util.ts` to `path.resolve`. `ctx.filePath` (`dispatcher.ts:374`) carried the
 * lexical form into the deferred store, while the coordinator keys the inline
 * record by identity: the collect-later answer was judged about a file that
 * does not exist, so the commit gate never saw the blocker the pipeline
 * recorded (recurrence: the third instance of this shape on 2026-10-25,
 * after #4853 F1 and the #4860 CodeRabbit finding).
 *
 * Everything here is real: `createDispatchContext`, the collect-later tier,
 * `dispatchForFile`, the pending store and `absorbSettledRunnerBlockers`. The
 * fixture is the #4689 symlinked family, so a host that cannot create
 * symlinks skips visibly.
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunnerPath } from "../../../clients/dispatch/runner-context.js";
import {
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { resetPendingRunnerFindings } from "../../../clients/dispatch/pending-runner-findings.js";
import type {
	Diagnostic,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import { absorbSettledRunnerBlockers } from "../../../clients/deferred-runner-blockers.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import {
	createPathIdentityFixture,
	setupTestEnvironment,
} from "../test-utils.js";

const RUNNER_ID = "slow-runner";
const INLINE_RUNNER_ID = "biome";

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-runner-identity-");
	resetObservedRunnerLatency();
	resetPendingRunnerFindings();
});

afterEach(() => {
	resetPendingRunnerFindings();
	env.cleanup();
});

/** Let the deferred runner's promise settle (it was handed to the store). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function blockingFinding(
	filePath: string,
	runnerId: string,
	message: string,
): Diagnostic {
	return {
		id: `${runnerId}:util.ts:1`,
		message,
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: runnerId,
		runnerId,
	};
}

/** A registry whose one jsts runner is deferred by the collect-later tier. */
function slowRunner(answer: (filePath: string) => RunnerResult) {
	const registry = new RunnerRegistry();
	registry.register({
		id: RUNNER_ID,
		appliesTo: ["jsts"],
		priority: 1,
		run: async (ctx) => answer(ctx.filePath),
	});
	return registry;
}

describe("a runner path keys the file's identity (#4689 batch 7)", () => {
	it("gives the dispatch context the identity, not the lexical form, of a `link/..` spelling", (ctx) => {
		// RECURRENCE GUARDED: `resolveRunnerPath` answered `path.resolve(filePath)`
		// for an absolute path, so this spelling keyed `repo/src/shared/util.ts`,
		// a file that does not exist, while `normalizeMapKey` keys the real one.
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		// Concatenated: `path.join` would collapse the `..` itself.
		const spelled = `${fx.repo}/src/linked/../shared/util.ts`;
		const dispatched = createDispatchContext(
			spelled,
			fx.repo,
			{ getFlag: () => false },
			new FactStore("4689-runner-path"),
		);
		expect(dispatched.filePath).toBe(normalizeMapKey(fx.sharedFile));
	});

	it("records a deferred runner's blocker on the inline record of a `link/..` spelling", async (ctx) => {
		// RECURRENCE GUARDED: the deferred entry carried the lexical path, so the
		// freshness gate read a missing file, called the answer stale and recorded
		// nothing; the inline blocker stayed alone and the commit gate passed.
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const spelled = `${fx.repo}/src/linked/../shared/util.ts`;
		expect(fs.existsSync(spelled)).toBe(true);

		// The record the edit's own pipeline wrote, keyed by identity.
		const runtime = new RuntimeCoordinator();
		expect(
			runtime.recordInlineBlockers(
				fx.sharedFile,
				"inline blocker",
				1,
				[INLINE_RUNNER_ID],
				[1],
				undefined,
				[blockingFinding(fx.sharedFile, INLINE_RUNNER_ID, "inline blocker")],
			),
		).toBeDefined();

		observeRunnerLatency({
			projectRoot: fx.repo,
			runnerId: RUNNER_ID,
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		const registry = slowRunner((filePath) => ({
			status: "succeeded",
			diagnostics: [blockingFinding(filePath, RUNNER_ID, "late blocker")],
			semantic: "blocking",
		}));
		const dispatched = createDispatchContext(
			spelled,
			fx.repo,
			{ getFlag: () => false },
			new FactStore("4689-runner-blocker"),
			undefined,
			undefined,
			fx.repo,
			1,
		);
		const edit = await dispatchForFile(
			dispatched,
			[{ mode: "all", runnerIds: [RUNNER_ID] }],
			registry,
		);
		// The deferred runner answered nothing on the edit path.
		expect(edit.diagnostics).toEqual([]);

		await settle();
		const absorbed = absorbSettledRunnerBlockers(runtime, fx.repo);
		expect(absorbed.recorded).toBe(1);
		// One record for one file: the late blocker joined the inline one, read
		// back through the handler that names it.
		expect(
			runtime
				.getInlineBlockerDiagnostics(spelled)
				?.map((finding) => finding.runnerId),
		).toEqual([INLINE_RUNNER_ID, RUNNER_ID]);
	});

	it("pays one identity read for an absolute spelling, not two", (ctx) => {
		// RECURRENCE GUARDED (#2016 cost; #4876 review r2 F3): the absolute branch
		// called `realpathOrResolve` and `resolveRunnerPath`'s `normalizeMapKey`
		// paid the same kernel read again, so every dispatched file doubled its
		// `readlink` count (measured: 5702 -> 11402 per 300 resolves).
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const native = vi.spyOn(fs.realpathSync, "native");
		try {
			resolveRunnerPath(fx.repo, fx.sharedFile);
			expect(native).toHaveBeenCalledTimes(1);
		} finally {
			native.mockRestore();
		}
	});
});
