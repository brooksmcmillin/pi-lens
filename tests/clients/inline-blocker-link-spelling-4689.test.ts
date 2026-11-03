/**
 * #4689 batch 1, round 2 (review F1): the coordinator's inline-blocker and
 * deferred-format stores key every accessor the same way, so one file that a
 * directory link spells with `..` cannot answer under two keys.
 *
 * Shape (AGENTS.md shape 1, divergent path keys): `repo/src/linked` is a link
 * to `repo/shared`. The spelling `repo/src/linked/../shared/util.ts` names
 * `repo/shared/util.ts` to the kernel, but `path.resolve` collapses the `..`
 * lexically to `repo/src/shared/util.ts`. A store whose writer keys the kernel
 * identity and whose reader keys the lexical form misses the record: the
 * stale demotion returns false and the snapshot drops the row. Recurrence:
 * the r1 drop of six wrappers left eleven accessors on `path.resolve`, and
 * this spelling split them (review F1, 2026-10-25).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	createPathIdentityFixture,
	setupTestEnvironment,
} from "./test-utils.js";

describe("inline-blocker and deferred stores key one file one way (#4689 F1)", () => {
	let env: { tmpDir: string; cleanup: () => void };

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-link-spelling-");
	});

	afterEach(() => {
		env.cleanup();
	});

	it("records through recordInlineBlockers and reads through the stale and snapshot accessors for a dir-link spelling with ..", (ctx) => {
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		// Built by concatenation: path.join would collapse the `..` itself.
		const spelled = `${fx.repo}/src/linked/../shared/util.ts`;
		const runtime = new RuntimeCoordinator();

		// Record through one accessor (write side, absolute spelling).
		expect(
			runtime.recordInlineBlockers(spelled, "🔴 STOP L1", 1, ["biome"], [1]),
		).toBeDefined();

		// Read through two other accessors with the same spelling.
		expect(runtime.markInlineBlockerStale(spelled, "dependency-drift")).toBe(
			true,
		);
		const rows = runtime.getInlineBlockersSnapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.stale).toBe(true);
	});

	it("keys a deferred format record the way deferredFormatIdentity reads it", (ctx) => {
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const spelled = `${fx.repo}/src/linked/../shared/util.ts`;
		const runtime = new RuntimeCoordinator();

		expect(
			runtime.deferMutation(spelled, fx.repo, "edit", fx.repo, "format"),
		).toBe(true);
		expect(runtime.deferredFormatIdentity(spelled)).toBeDefined();
	});
});
