/**
 * The host-boundary stub for package-manager and global-binary lookups
 * (#4709 slice 3b).
 *
 * `findGlobalBinary`, `resolveNodePackageManager` and `allAvailableGlobalBinDirs`
 * ask the HOST two questions: which package managers are on PATH (`which npm`),
 * and where each one keeps its global binaries (`npm config get prefix`,
 * `pnpm bin -g`, `yarn global bin`). A test that fakes the answer with
 * `vi.mock("clients/package-manager.js", { findGlobalBinary })` replaces
 * pi-lens's own lookup with a value the test supplies, so the assertion that
 * follows it observes the double, not the seam (#4709 slice 3: a planted-path
 * mutant passed two such cases 43/43).
 *
 * This module moves the double to the process boundary where it belongs:
 *
 * - {@link installPathProbeStub} puts a temp directory of executable stand-ins
 *   FIRST on PATH, so the real lookup spawns the real `which` and the stand-in
 *   package managers, and finds binaries the test planted on disk.
 * - {@link routePackageManagerProbes} lets a file that already doubles
 *   `safeSpawnAsync` (the process boundary) pass ONLY the lookup's own probes
 *   to the real spawn, so those probes neither consume the file's mocked
 *   answers nor inflate its call counts.
 * - {@link writeStandIn} is the one writer of an executable stand-in (`.cmd`
 *   on Windows, `#!/bin/sh` elsewhere); two files had each hand-rolled it
 *   (net-count fold, #4709).
 *
 * ## Hermetic by construction
 *
 * PATH is the stub directory plus a second directory holding only a symlink to
 * the host's `which`. A package manager the test did not plant is therefore
 * ABSENT, whatever the maintainer's machine has installed: planting `npm` alone
 * yields exactly one global bin dir. `BUN_INSTALL` is pinned under the same
 * root, because bun's global bin dir is derived from it (or from the real home)
 * without any spawn.
 *
 * ## Windows
 *
 * {@link PATH_PROBE_STUB_SUPPORTED} is false on win32 and the manager and PATH
 * entry points throw there. Two reasons, neither measured on a Windows host
 * (this was written on Linux): `where` lives in System32, so a Windows PATH
 * cannot be scrubbed to the stub directory, and an unplanted manager would
 * still resolve to the runner's own one, which defeats the absence half of every
 * case; and `.cmd` stand-ins need `cmd.exe` quoting the POSIX ones avoid. A test
 * that uses the stub
 * therefore gates on the constant and names the lane that runs it; the win32
 * spelling of these lookups (`where`, `.cmd`, `.exe`) stays covered by
 * `tests/clients/package-manager.test.ts`, which drives it through
 * `setPlatform("win32")` and a doubled `safeSpawnAsync`. {@link writeStandIn}
 * alone is cross-platform.
 *
 * NOTHING here may statically import `clients/safe-spawn.js`: the router is
 * built INSIDE a `vi.mock` factory for that module, and importing the module
 * under mock from its own factory deadlocks resolution (the same constraint
 * `bootstrap-mock.ts` documents). Types are `import type` only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";
import { withEnv } from "./with-env.js";

/** False on win32: see the module header. */
export const PATH_PROBE_STUB_SUPPORTED = process.platform !== "win32";

/** The managers whose global bin dir comes from a spawned query. */
export type QueriedManager = "npm" | "pnpm" | "yarn";

const MANAGER_NAMES: readonly string[] = ["npm", "pnpm", "yarn", "bun"];

/**
 * The exact query each manager is asked for its global bin dir
 * (`clients/package-manager.ts` `probeGlobalBinDirs`). bun has none: its dir
 * is derived from `BUN_INSTALL`.
 */
const GLOBAL_BIN_QUERY: Readonly<Record<QueriedManager, readonly string[]>> = {
	npm: ["config", "get", "prefix"],
	pnpm: ["bin", "-g"],
	yarn: ["global", "bin"],
};

/**
 * Write an executable stand-in named `name` into `dir` and return its path:
 * `<name>.cmd` with an `@echo off` body on win32, an executable `#!/bin/sh`
 * script elsewhere. `body` is the shell (or batch) text after the preamble.
 */
export function writeStandIn(dir: string, name: string, body: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const isWin = process.platform === "win32";
	const file = path.join(dir, isWin ? `${name}.cmd` : name);
	if (isWin) {
		fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, "utf8");
	} else {
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {
			encoding: "utf8",
			mode: 0o755,
		});
	}
	return file;
}

export interface PathProbeStub {
	/** The directory of stand-ins, first on PATH. */
	readonly pathDir: string;
	/**
	 * Plant a stand-in for `pm` that answers its global-bin query, and return
	 * the global bin dir it reports. The dir exists but is empty.
	 */
	plantManager(pm: QueriedManager): string;
	/** Plant a stand-in `bun`; returns its global bin dir (`$BUN_INSTALL/bin`). */
	plantBun(): string;
	/** Put an executable `name` into `pm`'s global bin dir; returns its path. */
	plantGlobalBinary(
		pm: QueriedManager | "bun",
		name: string,
		body?: string,
	): string;
	/** Put an executable `name` directly on PATH; returns its path. */
	plantOnPath(name: string, body?: string): string;
	/** Global-bin queries the stand-in managers answered, oldest first. */
	queries(): string[];
	/** Put PATH and BUN_INSTALL back exactly as they were. */
	restore(): void;
}

function requireSupported(what: string): void {
	if (!PATH_PROBE_STUB_SUPPORTED) {
		throw new Error(
			`${what}: the PATH probe stub is POSIX-only (see tests/support/path-probe-stub.ts "Windows")`,
		);
	}
}

/** The host's real `which`, resolved through every symlink, or undefined. */
function findHostWhich(hostPath: string | undefined): string | undefined {
	for (const dir of (hostPath ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "which");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.realpathSync(candidate);
		} catch {
			// not in this directory
		}
	}
	return undefined;
}

/** A path safe to embed between single quotes in a stand-in script. */
function shellQuotable(value: string): string {
	if (value.includes("'") || /[\r\n]/.test(value)) {
		throw new Error(`path cannot be embedded in a stand-in script: ${value}`);
	}
	return value;
}

/**
 * Install the stub under `root` (a fixture directory the caller owns and
 * removes; this function creates only subdirectories of it) and return its
 * handle. PATH and BUN_INSTALL are restored by {@link PathProbeStub.restore},
 * which the caller runs in `afterEach`.
 */
export function installPathProbeStub(root: string): PathProbeStub {
	requireSupported("installPathProbeStub");
	const base = fs.realpathSync(root);
	const pathDir = path.join(base, "probe-stub", "path");
	const hostToolsDir = path.join(base, "probe-stub", "host-tools");
	const bunInstall = path.join(base, "probe-stub", "bun-install");
	const queryLog = path.join(base, "probe-stub", "queries.log");
	fs.mkdirSync(pathDir, { recursive: true });
	fs.mkdirSync(hostToolsDir, { recursive: true });
	fs.writeFileSync(queryLog, "");

	const hostWhich = findHostWhich(process.env.PATH);
	if (!hostWhich) {
		throw new Error("installPathProbeStub: no `which` on the host PATH");
	}
	fs.symlinkSync(hostWhich, path.join(hostToolsDir, "which"));

	const globalBinDirs = new Map<QueriedManager | "bun", string>();
	globalBinDirs.set("bun", path.join(bunInstall, "bin"));

	const restoreEnv = withEnv({
		PATH: [pathDir, hostToolsDir].join(path.delimiter),
		BUN_INSTALL: bunInstall,
	});

	return {
		pathDir,
		plantManager(pm) {
			const binDir = path.join(base, "probe-stub", `${pm}-global`, "bin");
			fs.mkdirSync(binDir, { recursive: true });
			// npm reports a PREFIX (binaries live in `<prefix>/bin`); pnpm and
			// yarn print the bin dir itself.
			const answer = pm === "npm" ? path.dirname(binDir) : binDir;
			const query = GLOBAL_BIN_QUERY[pm].join(" ");
			writeStandIn(
				pathDir,
				pm,
				[
					`printf '%s\\n' "$*" >> '${shellQuotable(queryLog)}'`,
					`if [ "$*" = '${query}' ]; then printf '%s\\n' '${shellQuotable(answer)}'; exit 0; fi`,
					"exit 1",
				].join("\n"),
			);
			globalBinDirs.set(pm, binDir);
			return binDir;
		},
		plantBun() {
			writeStandIn(pathDir, "bun", "exit 0");
			const binDir = globalBinDirs.get("bun") as string;
			fs.mkdirSync(binDir, { recursive: true });
			return binDir;
		},
		plantGlobalBinary(pm, name, body = "exit 0") {
			const binDir = globalBinDirs.get(pm);
			if (!binDir) {
				throw new Error(`plantGlobalBinary: plant ${pm} before its binaries`);
			}
			return writeStandIn(binDir, name, body);
		},
		plantOnPath(name, body = "exit 0") {
			return writeStandIn(pathDir, name, body);
		},
		queries() {
			return fs
				.readFileSync(queryLog, "utf8")
				.split("\n")
				.filter((line) => line.length > 0);
		},
		restore() {
			restoreEnv();
		},
	};
}

/**
 * Whether a spawn is one of the package-manager lookup's own probes: `which`
 * asked about exactly one manager, or a manager asked its
 * exact global-bin query. Everything else is NOT a probe. The list is closed on
 * purpose (a short list of known-good forms, never a list of known-bad ones):
 * an unrecognised spawn goes to the test's double, so a new production spawn
 * cannot silently become a real one.
 */
export function isPackageManagerProbe(
	command: string,
	args: readonly string[] = [],
): boolean {
	if (command === "which") {
		return args.length === 1 && MANAGER_NAMES.includes(args[0] as string);
	}
	if (!Object.hasOwn(GLOBAL_BIN_QUERY, command)) return false;
	const query = GLOBAL_BIN_QUERY[command as QueriedManager];
	return (
		args.length === query.length && query.every((word, i) => args[i] === word)
	);
}

type SpawnFn = (
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
) => Promise<SpawnResult>;

/**
 * Wrap a test's `safeSpawnAsync` double so the package-manager lookup's probes
 * run through `real` (the module's own `safeSpawnAsync`, taken from
 * `importOriginal`) and every other spawn goes to `double`. `probed`, when
 * given, receives `"<command> <args>"` for each probe in order, so a case can
 * assert the lookup ran, or did not.
 */
export function routePackageManagerProbes(
	real: SpawnFn,
	double: SpawnFn,
	probed?: string[],
): SpawnFn {
	return (command, args, options) => {
		if (isPackageManagerProbe(command, args)) {
			probed?.push([command, ...args].join(" "));
			return real(command, args, options);
		}
		return double(command, args, options);
	};
}
