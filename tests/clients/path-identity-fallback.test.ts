/**
 * #4689: a path identity the kernel cannot finish is visible, not silent.
 *
 * `normalizeMapKey` derives an absolute spelling's identity from the realpath
 * of its nearest existing ancestor. A missing component is the ordinary answer
 * for a file not yet written and records nothing; any other realpath error (a
 * cyclic link here) makes the key fall back to an ancestor's identity, where
 * another spelling of the same file may derive a different key. That fallback
 * reaches `pilens_health` through the ledger's read-time fold
 * (`path-identity-fallback`), bounded to one row per errno code.
 *
 * Recurrence guarded: a silent identity fallback is the shape-1 split this
 * issue fixes, hidden again (engineering principles, "Every new failure path
 * gets bounded observability"). Lane: ubuntu Unit tests; a host that cannot
 * create symlinks skips visibly. The record is POSIX-only by construction (the
 * win32 arm of `normalizePathForm` never walks ancestors), so each case skips
 * on win32 in its body rather than by a platform gate, which would enrol the
 * file in the Windows lane only to skip it there (review r1, Sourcery S5).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	getPathIdentityFallbacks,
	normalizeMapKey,
} from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

function posixOnly(ctx: { skip: (note?: string) => void }): void {
	if (process.platform === "win32")
		ctx.skip("the win32 arm keys by realpath and never records a fallback");
}

function fallbackGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "path-identity-fallback",
	);
}

describe("path identity fallback record (#4689)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-path-identity-fallback-");
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
		env.cleanup();
	});

	it("a cyclic link keys under its nearest resolvable ancestor and records the fallback once per errno", (ctx) => {
		posixOnly(ctx);
		const root = fs.realpathSync.native(env.tmpDir);
		try {
			fs.symlinkSync("loop-b", path.join(root, "loop-a"));
			fs.symlinkSync("loop-a", path.join(root, "loop-b"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}
		const spelled = path.join(root, "loop-a", "x.ts");
		expect(normalizeMapKey(spelled)).toBe(spelled.replace(/\\/g, "/"));
		const group = fallbackGroup();
		// Two refusals (the file under the loop, then the loop itself), one row.
		expect(group?.count).toBe(2);
		expect(group?.latestReasons.map((row) => row.subject)).toEqual(["ELOOP"]);
		expect(group?.latestReasons[0]?.reason).toContain(spelled);
	});

	it("a file not yet written records nothing", (ctx) => {
		posixOnly(ctx);
		const root = fs.realpathSync.native(env.tmpDir);
		normalizeMapKey(path.join(root, "missing-dir", "new.ts"));
		expect(fallbackGroup()).toBeUndefined();
	});

	it("a path under a regular file records nothing: ENOTDIR is a missing component", (ctx) => {
		// RECURRENCE GUARDED: review r1 F6 (B2). `normalizeMapKey` on a path
		// under a FILE (a stale spelling, a tool that appends to a file path)
		// is refused with ENOTDIR, which is the not-written-yet answer, not an
		// identity the kernel could not finish; tallying it would fill the
		// health row with ordinary misses.
		posixOnly(ctx);
		const root = fs.realpathSync.native(env.tmpDir);
		const file = path.join(root, "plain.ts");
		fs.writeFileSync(file, "export {};\n");
		const under = path.join(file, "x.ts");
		expect(normalizeMapKey(under)).toBe(under.replace(/\\/g, "/"));
		expect(fallbackGroup()).toBeUndefined();
	});

	it("keeps at most 16 errno rows however many distinct codes the kernel answers", (ctx) => {
		// RECURRENCE GUARDED: review r1 F6 (B1). The tally is keyed by a value
		// the kernel chooses; its cap survived a mutation because no test
		// offered more codes than it holds, so an unbounded tally would ship
		// green. Synthetic codes stand in for errnos no fixture can provoke.
		posixOnly(ctx);
		const root = fs.realpathSync.native(env.tmpDir);
		const actual = fs.realpathSync.native;
		const native = vi
			.spyOn(fs.realpathSync, "native")
			.mockImplementation((value, options) => {
				const code = /\/(E\d+)(\/|$)/.exec(String(value))?.[1];
				if (code === undefined) return actual(value, options);
				throw Object.assign(new Error(code), { code });
			});
		try {
			for (let i = 0; i < 20; i++)
				normalizeMapKey(path.join(root, `E${i}`, "x.ts"));
		} finally {
			native.mockRestore();
		}
		const codes = getPathIdentityFallbacks().map((row) => row.code);
		expect(codes).toHaveLength(16);
		// The newest codes are kept; the oldest are evicted first.
		expect(codes).toContain("E19");
		expect(codes).not.toContain("E0");
	});

	it("re-arms with the ledger at a session boundary", (ctx) => {
		posixOnly(ctx);
		const root = fs.realpathSync.native(env.tmpDir);
		try {
			fs.symlinkSync("self", path.join(root, "self"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}
		normalizeMapKey(path.join(root, "self"));
		expect(fallbackGroup()?.count).toBe(1);
		resetDegradationLedger();
		expect(fallbackGroup()).toBeUndefined();
	});
});
