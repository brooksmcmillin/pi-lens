// flake-shape: real-process-spawn — the cases must run the real package-manager resolver against executable stand-in managers on PATH; a doubled resolver verdict is what this file used to assert on.
/**
 * runRebuild spawns the resolved package manager's `run <script>` — not a
 * hardcoded npm — and surfaces which manager it used. The build spawn is
 * doubled (no real build runs); the resolver is REAL: it reads the project's
 * lockfile and asks the host which managers are installed, through the
 * PATH-probe stub's stand-ins (#4709 slice 3b). Before, a doubled
 * `resolveNodePackageManager` handed each case the manager it then asserted on.
 *
 * lane: ubuntu and every other POSIX box (the stub is POSIX-only,
 * `tests/support/path-probe-stub.ts` "Windows"); the win32 resolver spelling is
 * `tests/clients/package-manager.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	installPathProbeStub,
	PATH_PROBE_STUB_SUPPORTED,
	type PathProbeStub,
} from "../../support/path-probe-stub.js";
import { setupTestEnvironment } from "../test-utils.js";

// The probe log is read by the "refuses before resolving" case; hoisted so the
// factory below can hand it to the router.
const { safeSpawnAsync, probed } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	probed: [] as string[],
}));

// The build spawn is the process boundary. The resolver's own probes (`which`,
// the manager's global-bin query) are NOT the build, so the router lets exactly
// those run for real and keeps them out of this double's call list.
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/safe-spawn.js")>();
	const { routePackageManagerProbes } =
		await import("../../support/path-probe-stub.js");
	return {
		...actual,
		safeSpawnAsync: routePackageManagerProbes(
			actual.safeSpawnAsync,
			safeSpawnAsync,
			probed,
		),
	};
});

import { _resetPackageManagerCache } from "../../../clients/package-manager.js";
import {
	canRebuildPiLens,
	REBUILD_UNAVAILABLE_MESSAGE,
	runRebuild,
} from "../../../clients/mcp/review.js";

describe.skipIf(!PATH_PROBE_STUB_SUPPORTED)("runRebuild", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let stubEnv: ReturnType<typeof setupTestEnvironment>;
	let repoRoot: string;
	let stub: PathProbeStub;

	beforeEach(() => {
		vi.clearAllMocks();
		probed.length = 0;
		_resetPackageManagerCache();
		env = setupTestEnvironment("pi-lens-rebuild-");
		repoRoot = env.tmpDir;
		fs.writeFileSync(path.join(repoRoot, "tsconfig.dist.json"), "{}");
		// The stand-ins live OUTSIDE the project handed to runRebuild: a PATH
		// entry under the project root is what a trust rule over the lookup
		// refuses (#4530), and the project here must stay a clean project.
		stubEnv = setupTestEnvironment("pi-lens-rebuild-stub-");
		stub = installPathProbeStub(stubEnv.tmpDir);
	});

	afterEach(() => {
		stub.restore();
		_resetPackageManagerCache();
		stubEnv.cleanup();
		env.cleanup();
	});

	it("runs the resolved manager's script and reports it", async () => {
		fs.writeFileSync(path.join(repoRoot, "bun.lock"), "");
		// npm is installed too and wins the preference order, so bun is chosen
		// only because the project's lockfile declares it.
		stub.plantManager("npm");
		stub.plantBun();
		safeSpawnAsync.mockResolvedValue({
			stdout: "done",
			stderr: "",
			status: 0,
		});

		const outcome = await runRebuild(repoRoot, "build");

		const [cmd, args] = safeSpawnAsync.mock.calls[0];
		// pmBinary("bun") is bare `bun` off Windows.
		expect(cmd).toContain("bun");
		expect(args).toEqual(["run", "build"]);
		expect(outcome.ok).toBe(true);
		expect(outcome.packageManager).toBe("bun");
		expect(outcome.script).toBe("build");
	});

	it("uses the first installed manager when the project declares none", async () => {
		// npm is absent here, so the preference order lands on the next one
		// installed. (With npm planted the answer would be npm either way, which
		// is why this case plants pnpm alone.)
		stub.plantManager("pnpm");
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "",
			status: 0,
		});

		const outcome = await runRebuild(repoRoot, "build:dist");

		const [cmd, args] = safeSpawnAsync.mock.calls[0];
		expect(cmd).toContain("pnpm");
		expect(args).toEqual(["run", "build:dist"]);
		expect(outcome.packageManager).toBe("pnpm");
	});

	it("falls back to npm when the declared manager is not installed", async () => {
		fs.writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "");
		stub.plantManager("npm");
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "",
			status: 0,
		});

		const outcome = await runRebuild(repoRoot, "build");

		const [cmd, args] = safeSpawnAsync.mock.calls[0];
		expect(cmd).toContain("npm");
		expect(args).toEqual(["run", "build"]);
		expect(outcome.packageManager).toBe("npm");
	});

	it("reports failure on a non-zero exit", async () => {
		fs.writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "");
		// npm outranks pnpm in the preference order; pnpm wins only through the
		// lockfile.
		stub.plantManager("npm");
		stub.plantManager("pnpm");
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "boom",
			status: 1,
		});

		const outcome = await runRebuild(repoRoot, "build");
		expect(outcome.ok).toBe(false);
		expect(outcome.packageManager).toBe("pnpm");
	});

	it("refuses an installed package before resolving or spawning", async () => {
		fs.rmSync(path.join(repoRoot, "tsconfig.dist.json"));
		fs.writeFileSync(path.join(repoRoot, "bun.lock"), "");
		stub.plantBun();

		const outcome = await runRebuild(repoRoot, "build:dist");

		expect(outcome).toMatchObject({
			ok: false,
			output: REBUILD_UNAVAILABLE_MESSAGE,
		});
		// The resolver asks the host (`which bun`) the moment it runs; no probe
		// means it never ran.
		expect(probed).toEqual([]);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("refuses paths inside node_modules even when a tsconfig is present", () => {
		const installedRoot = path.join(repoRoot, "node_modules", "pi-lens");
		fs.mkdirSync(installedRoot, { recursive: true });
		fs.writeFileSync(path.join(installedRoot, "tsconfig.dist.json"), "{}");

		expect(canRebuildPiLens(installedRoot)).toBe(false);
	});
});
