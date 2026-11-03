// flake-shape: real-process-spawn — the stub exists so the real package-manager lookup spawns the real `which` and executable stand-in managers; a doubled spawn is the thing it replaces.
/**
 * Fidelity proofs for the PATH-probe stub (#4709 slice 3b).
 *
 * The #1673 lesson: an inert double is worse than none. Each claim the stub
 * makes is proved here through the PRODUCTION lookup (`findGlobalBinary`,
 * `allAvailableGlobalBinDirs`, `resolveNodePackageManager`), so a stub that
 * stops being hermetic, stops answering its query, or stops restoring PATH
 * reds this file, not a consumer that happened to trust it.
 *
 * lane: ubuntu and every other POSIX box. The stub is POSIX-only by design
 * (`tests/support/path-probe-stub.ts` "Windows"); the win32 spelling of the
 * same lookups is driven through `setPlatform("win32")` by
 * `tests/clients/package-manager.test.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetPackageManagerCache,
	allAvailableGlobalBinDirs,
	findGlobalBinary,
	resolveNodePackageManager,
} from "../../clients/package-manager.js";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	installPathProbeStub,
	isPackageManagerProbe,
	PATH_PROBE_STUB_SUPPORTED,
	type PathProbeStub,
	routePackageManagerProbes,
	writeStandIn,
} from "./path-probe-stub.js";

describe.skipIf(!PATH_PROBE_STUB_SUPPORTED)("PATH probe stub", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let stub: PathProbeStub;
	let ambientPath: string | undefined;
	let ambientBunInstall: string | undefined;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-path-probe-stub-");
		ambientPath = process.env.PATH;
		ambientBunInstall = process.env.BUN_INSTALL;
		_resetPackageManagerCache();
		stub = installPathProbeStub(env.tmpDir);
	});

	afterEach(() => {
		stub.restore();
		_resetPackageManagerCache();
		env.cleanup();
	});

	it("finds a binary planted in the stand-in npm's global bin dir", async () => {
		stub.plantManager("npm");
		const planted = stub.plantGlobalBinary("npm", "prisma");

		expect(await findGlobalBinary("prisma")).toBe(planted);
		// Recurrence: a lookup that never asked the manager would pass a planted
		// binary found some other way. The stand-in logs the exact query it served.
		expect(stub.queries()).toEqual(["config get prefix"]);
	});

	it("reports a miss when the manager has no such binary", async () => {
		stub.plantManager("npm");
		stub.plantGlobalBinary("npm", "prisma");

		expect(await findGlobalBinary("not-installed")).toBeUndefined();
	});

	it("treats a manager the test did not plant as absent, whatever the host has", async () => {
		// Recurrence: a stub that only PREPENDS to PATH leaks the maintainer's own
		// pnpm into the lookup, so an absence case passes on one box and fails on
		// the next. No manager planted: nothing may be found or probed.
		expect(await allAvailableGlobalBinDirs()).toEqual([]);
		expect(await findGlobalBinary("npm")).toBeUndefined();
		expect(stub.queries()).toEqual([]);
	});

	it("asks every planted manager, in the lookup's preference order", async () => {
		const npmDir = stub.plantManager("npm");
		const pnpmDir = stub.plantManager("pnpm");
		const bunDir = stub.plantBun();

		expect(await allAvailableGlobalBinDirs()).toEqual([
			npmDir,
			pnpmDir,
			bunDir,
		]);
		expect(stub.queries()).toEqual(["config get prefix", "bin -g"]);
	});

	it("finds a binary in bun's global bin dir, derived from the pinned BUN_INSTALL", async () => {
		stub.plantBun();
		const planted = stub.plantGlobalBinary("bun", "tsx");

		expect(await findGlobalBinary("tsx")).toBe(planted);
	});

	it("lets resolveNodePackageManager see exactly the planted managers", async () => {
		const project = path.join(env.tmpDir, "project");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "pnpm-lock.yaml"), "");

		// Declared manager absent: falls through to the first installed one.
		stub.plantManager("yarn");
		expect(await resolveNodePackageManager(project)).toBe("yarn");

		_resetPackageManagerCache();
		stub.plantManager("pnpm");
		expect(await resolveNodePackageManager(project)).toBe("pnpm");
	});

	it("runs a tool planted on PATH as a real child", async () => {
		stub.plantOnPath("planted-tool", "echo planted-ran");

		const result = await safeSpawnAsync("planted-tool", []);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("planted-ran");
	});

	it("writes an executable stand-in the platform can run", async () => {
		const file = writeStandIn(env.tmpDir, "stand-in", "echo ok");

		const result = await safeSpawnAsync(file, []);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("ok");
	});

	it("restores PATH and BUN_INSTALL exactly", () => {
		expect(process.env.PATH).not.toBe(ambientPath);

		stub.restore();

		expect(process.env.PATH).toBe(ambientPath);
		expect(process.env.BUN_INSTALL).toBe(ambientBunInstall);
	});
});

describe("isPackageManagerProbe", () => {
	it("admits only the lookup's own probes", () => {
		expect(isPackageManagerProbe("which", ["npm"])).toBe(true);
		expect(isPackageManagerProbe("which", ["bun"])).toBe(true);
		expect(isPackageManagerProbe("npm", ["config", "get", "prefix"])).toBe(
			true,
		);
		expect(isPackageManagerProbe("pnpm", ["bin", "-g"])).toBe(true);
		expect(isPackageManagerProbe("yarn", ["global", "bin"])).toBe(true);
	});

	it("refuses every other spawn, including a near miss of a probe", () => {
		// Recurrence (principles §1, gates fail closed): a router that forwards a
		// whole command family would let `npm install` run for real.
		expect(isPackageManagerProbe("which", ["git"])).toBe(false);
		expect(isPackageManagerProbe("which", ["npm", "pnpm"])).toBe(false);
		expect(isPackageManagerProbe("which", [])).toBe(false);
		expect(isPackageManagerProbe("npm", ["install", "left-pad"])).toBe(false);
		expect(
			isPackageManagerProbe("npm", ["config", "get", "prefix", "-g"]),
		).toBe(false);
		expect(isPackageManagerProbe("pnpm", ["bin"])).toBe(false);
		// Same length as a real query, different words: a router that checked
		// only the argument COUNT would let these run for real.
		expect(isPackageManagerProbe("npm", ["config", "get", "registry"])).toBe(
			false,
		);
		expect(isPackageManagerProbe("yarn", ["global", "dir"])).toBe(false);
		expect(isPackageManagerProbe("bun", ["bin", "-g"])).toBe(false);
		expect(isPackageManagerProbe("git", ["status"])).toBe(false);
		expect(isPackageManagerProbe("toString", ["bin", "-g"])).toBe(false);
	});
});

describe("routePackageManagerProbes", () => {
	const result = (stdout: string) => ({ stdout, stderr: "", status: 0 });

	it("sends a probe to the real spawn and anything else to the double", async () => {
		const real: string[] = [];
		const doubled: string[] = [];
		const probed: string[] = [];
		const route = routePackageManagerProbes(
			async (command) => {
				real.push(command);
				return result("real");
			},
			async (command) => {
				doubled.push(command);
				return result("double");
			},
			probed,
		);

		expect((await route("which", ["npm"])).stdout).toBe("real");
		expect((await route("npm", ["run", "build"])).stdout).toBe("double");

		expect({ real, doubled, probed }).toEqual({
			real: ["which"],
			doubled: ["npm"],
			probed: ["which npm"],
		});
	});
});
