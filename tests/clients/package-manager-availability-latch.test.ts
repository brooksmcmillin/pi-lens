/**
 * #1496 — `isAvailable` in `package-manager.ts` memoized a `where`/`which <pm>`
 * probe for the life of the process. A timeout (a 5 s host-side budget, the
 * same shape as #1467/#1476) was remembered as "this manager is not
 * installed", so a declared pnpm/yarn manager would silently fall back to npm
 * for the rest of the session. The affected call sites are internal (installs
 * into pi-lens's managed tools directory, `pilens_rebuild` on a source
 * checkout) — no user-project lockfile was ever at risk.
 *
 * These tests exercise `resolveNodePackageManager`, the public surface every
 * caller (the installer, `pilens_rebuild`) actually uses, rather than the
 * private `isAvailable` memo directly. `safeSpawnAsync` is mocked; the probe
 * command (`where`/`which <pm>`) is asserted on directly so the test does not
 * depend on which implementation function issues it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

// `isCommandAvailableAsync` is reimplemented here (not `importOriginal`'d):
// the real function's internal call to `safeSpawnAsync` is bound to its OWN
// module's unmocked binding, not this mock, so importing it would silently
// bypass the mock and hit the real system PATH. Pre-fix `package-manager.ts`
// probes through `isCommandAvailableAsync`; post-fix code calls
// `safeSpawnAsync` directly. Routing both through the same hoisted mock lets
// one test file exercise both at the same boundary.
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	isCommandAvailableAsync: async (command: string) => {
		const finder = process.platform === "win32" ? "where" : "which";
		const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });
		return result.status === 0 && !result.error;
	},
}));

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** A real `where`/`which` that ran fine and found nothing: genuine absence. */
const notFoundResult = { stdout: "", stderr: "", status: 1 };

const okResult = (pm: string) => ({ stdout: `${pm}\n`, stderr: "", status: 0 });

function finder(): string {
	return process.platform === "win32" ? "where" : "which";
}

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

/** Empty project: no lockfile, no `packageManager` field — nothing declared. */
async function emptyProjectDir(): Promise<string> {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const path = await import("node:path");
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pm-latch-"));
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("package-manager availability (#1496)", () => {
	it("pins a successful probe: the declared manager resolves", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm" ? okResult("pnpm") : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		expect(await resolveNodePackageManager(dir)).toBe("pnpm");
	});

	it("pins a genuine absence: falls back to npm, latched (no re-probe)", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "npm" ? okResult("npm") : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		// pnpm is declared but genuinely absent — falls back through PREFERENCE.
		expect(await resolveNodePackageManager(dir)).toBe("npm");
		const probesBefore = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "pnpm",
		).length;
		expect(probesBefore).toBeGreaterThan(0);

		// A genuine absence latches: a second resolve does not re-probe pnpm.
		expect(await resolveNodePackageManager(dir)).toBe("npm");
		const probesAfter = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "pnpm",
		).length;
		expect(probesAfter).toBe(probesBefore);
	});

	/**
	 * THE regression proof (#1496): a project declares pnpm. The first probe
	 * for pnpm times out — a transient host stall, not a fact about the
	 * machine. Pre-fix, that timeout latched `false` forever and every later
	 * resolve silently used npm. Post-fix, the verdict expires on its cooldown
	 * and a later probe that finds pnpm resolves it correctly — no restart
	 * needed. This must FAIL on pre-fix code (pre-fix: pnpm never comes back).
	 */
	it("a timed-out probe expires: pnpm is found on retry, no permanent npm downgrade", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm" ? timeoutResult : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		// The stalled first probe falls back to npm for THIS call — acceptable,
		// the session still needs an answer right now.
		expect(await resolveNodePackageManager(dir)).toBe("npm");

		// Now pnpm is reachable again (the stall passed) and the cooldown expires.
		advancePastCooldown();
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm" ? okResult("pnpm") : notFoundResult,
		);

		// Pre-fix: the timeout latched `false` for pnpm for the life of the
		// process, so this still resolves "npm" and the assertion below fails.
		expect(await resolveNodePackageManager(dir)).toBe("pnpm");
	});

	it("concurrent first-time resolves for the same manager share one probe", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "npm" ? okResult("npm") : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();

		const results = await Promise.all([
			resolveNodePackageManager(dir),
			resolveNodePackageManager(dir),
			resolveNodePackageManager(dir),
		]);
		expect(results).toEqual(["npm", "npm", "npm"]);
		const npmProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "npm",
		).length;
		expect(npmProbes).toBe(1);
	});
});
