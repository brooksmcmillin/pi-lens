/**
 * Tier 1 of the real-host test seam (#4632): load the BUILT pi-lens extension
 * through pi's own extension loader and drive it through pi's real
 * `ExtensionRunner`, instead of a hand-written `ExtensionAPI` stand-in.
 *
 * What this tier pins, and what it does not:
 *
 * - It pins the registries the real host holds after loading: the flags, the
 *   tools (including the definition pi wraps them in) and the commands
 *   `index.ts` registered. `tests/support/pi-mock.ts` records the arguments
 *   `index.ts` passed; the runner reports what pi actually stored.
 * - It pins what the extension itself declared, read from the maps pi's loader
 *   filled (`getDeclaredRegistrations`), so a contract case compares the
 *   declaration with the host's registry instead of sampling both.
 * - It does NOT pin event payload shapes or handler behaviour. This tier
 *   exposes no `emit`: a lifecycle event takes any object, so payload tests are
 *   tier 2, and the loaded copy's own writers cannot be drained from here
 *   (point 2).
 *
 * Three consequences of loading through pi's loader, all relied on below:
 *
 * 1. pi loads an extension file with jiti, so the factory runs against its own
 *    copies of `clients/*` — never the file's imports. Assert on registered
 *    data (names, descriptions, schemas, flags) or on `globalThis`, never on a
 *    `clients/` module object identity.
 * 2. The copy reads `PI_LENS_HOME` / `PILENS_DATA_DIR` at its own load, so both
 *    are pinned here, before the load. Its background writers are reachable
 *    only from inside that copy: `drainBackgroundWritesForTests` resolves the
 *    modules this test process loaded through Vite, so a write the loaded copy
 *    schedules would land in the pinned home after the fixture root is removed
 *    (#2912). That is why this tier emits nothing, and why the `afterAll` drain
 *    below covers the test-side writers only (#4641 F4).
 * 3. pi's loader also builds jiti's transform cache at
 *    `path.join(os.tmpdir(), "jiti")`, so the load runs with `os.tmpdir()`
 *    aimed inside the fixture: a direct child of the shared tmp root is a
 *    fixture sibling to the tmp-hygiene census (#4641 F1).
 */

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	Extension,
	ExtensionActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionFlag,
	ExtensionRunner,
	RegisteredTool,
	ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import { afterAll } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
	withFixtureTmpdir,
} from "../clients/test-utils.js";

/**
 * The certified host package. Measured on 0.86.1, 0.87.1, 0.99.2, 1.0.4, 1.1.0
 * and 1.3.0: every one exports `ExtensionRunner`, `discoverAndLoadExtensions`
 * and `VERSION`, and builds a runner from the same five arguments.
 */
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Points the helper at another installed host, as a package directory or a
 * module file: the version-spread run names a host directory, and the planned
 * nightly probe (#4632 slice 6) would too. Nothing in the default suite sets
 * it.
 */
const HOST_PACKAGE_ENV = "PI_LENS_PI_HOST_PACKAGE";

/** The built extension every test loads: `npm run build` writes this twin. */
const EXTENSION_ENTRY = fileURLToPath(
	new URL("../../index.js", import.meta.url),
);

const TMP_PREFIX = "pi-lens-pi-runner-";

/** The two environment variables the loaded copy binds at load. */
const ENV_KEYS = ["PI_LENS_HOME", "PILENS_DATA_DIR"] as const;

interface HostModule {
	ExtensionRunner: new (
		extensions: unknown,
		runtime: unknown,
		cwd: string,
		sessionManager: unknown,
		modelRegistry: unknown,
	) => ExtensionRunner;
	/** The host package's own version string (`pi/config.js`'s `VERSION`). */
	VERSION: string;
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
	) => Promise<{
		extensions: Extension[];
		errors: { path: string; error: unknown }[];
		warnings: unknown[];
		runtime: unknown;
	}>;
}

function hostSpecifier(): string {
	const override = process.env[HOST_PACKAGE_ENV];
	if (!override) return HOST_PACKAGE;
	// A probe names a directory; its entry is the package's own `main`.
	return path.isAbsolute(override) && !override.endsWith(".js")
		? pathToFileURL(path.join(override, "dist", "index.js")).href
		: override;
}

/**
 * The values this file replaced, saved before the first pin and put back by the
 * `afterAll` below — the shape `tests/config/test-env-restore-sweep.test.ts`
 * accepts for a module-scope record.
 */
const savedEnv: Record<string, string | undefined> = {};

/** Temp roots this file still owns; removed with the environment in `afterAll`. */
const liveFixtures: Array<() => void> = [];

function noop(): void {
	// A host action the extension may call; this tier asserts registrations, so
	// every action stays inert rather than fabricating a result a test could
	// mistake for host behaviour.
}

/**
 * The 26 host actions `bindCore` requires. They live here, once, so a host
 * version adding or renaming one is a single edit and never a per-test fork.
 */
const HOST_ACTIONS: ExtensionActions = {
	sendMessage: noop,
	sendUserMessage: noop,
	appendEntry: noop,
	setSessionName: noop,
	getSessionName: () => undefined,
	setLabel: noop,
	getActiveTools: () => [],
	getAllTools: () => [],
	getSettings: () => ({}) as ReturnType<ExtensionActions["getSettings"]>,
	setActiveTools: noop,
	refreshTools: noop,
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: noop,
};

const CONTEXT_ACTIONS: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: noop,
	hasPendingMessages: () => false,
	shutdown: noop,
	getContextUsage: () => undefined,
	compact: noop,
	getSystemPrompt: () => "",
};

/** What the loaded extension declared, read from the maps pi's loader filled. */
export interface PiRunnerDeclarations {
	/** Event types the extension registered a handler for (`pi.on`). */
	readonly handlers: readonly string[];
	/** Flag names the extension registered (`pi.registerFlag`). */
	readonly flags: readonly string[];
	/** Command names the extension registered (`pi.registerCommand`). */
	readonly commands: readonly string[];
}

/** A `pi` for one loaded extension: the real registries and its declarations. */
export interface PiRunner {
	/** Absolute project directory the extension was loaded for. */
	readonly cwd: string;
	/** Host package version that loaded and now runs the extension. */
	readonly hostVersion: string;
	/** Errors pi reported from a handler (`runner.onError`), in order. */
	readonly errors: ExtensionError[];
	/** What the extension declared, before the host resolves anything. */
	getDeclaredRegistrations(): PiRunnerDeclarations;
	/** `pi.registerFlag` results, as the host holds them. */
	getFlags(): Map<string, ExtensionFlag>;
	/** `pi.registerTool` results, including pi's own wrapper on each definition. */
	getAllRegisteredTools(): readonly RegisteredTool[];
	/** `pi.registerCommand` results, resolved through the host. */
	getRegisteredCommands(): readonly ResolvedCommand[];
	hasHandlers(event: string): boolean;
}

export interface StartPiRunnerOptions {
	/**
	 * Absolute project directory. Defaults to the fixture root, which the
	 * harness marks with `.git` — passing the repository under test would make
	 * every project-state write land in this checkout.
	 */
	cwd?: string;
	/** Extra paths pi loads after the extension, e.g. a second extension. */
	extraExtensionPaths?: string[];
}

/**
 * Load the built extension into a real `ExtensionRunner` for one test file.
 * Call it from `beforeAll`; it costs one jiti load (~0.4 s).
 */
export async function startPiRunner(
	options: StartPiRunnerOptions = {},
): Promise<PiRunner> {
	const fixture = setupTestEnvironment(TMP_PREFIX);
	const root = fixture.tmpDir;
	const agentDir = path.join(root, "agent");
	const cwd = options.cwd ?? root;
	// Save before pinning: the loaded copy reads both at its own load, so the
	// pin must precede `discoverAndLoadExtensions`.
	for (const key of ENV_KEYS) {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_HOME = path.join(root, "home");
	process.env.PILENS_DATA_DIR = path.join(root, "data");
	liveFixtures.push(fixture.cleanup);

	const host = (await import(
		/* @vite-ignore */ hostSpecifier()
	)) as unknown as HostModule;
	const loaded = await withFixtureTmpdir(root, () =>
		host.discoverAndLoadExtensions(
			[EXTENSION_ENTRY, ...(options.extraExtensionPaths ?? [])],
			cwd,
			agentDir,
		),
	);
	if (loaded.extensions === undefined || loaded.errors.length > 0) {
		throw new Error(
			`pi failed to load ${EXTENSION_ENTRY}: ${JSON.stringify(loaded.errors)}`,
		);
	}

	const sessionManager = {
		getSessionId: () => "pi-runner-session",
		getSessionFile: () => undefined,
		getCwd: () => cwd,
		getEntries: () => [],
	};
	const modelRegistry = {
		registerProvider: noop,
		unregisterProvider: noop,
		registerNativeProvider: noop,
		unregisterNativeProvider: noop,
		registerVirtualModel: noop,
		unregisterVirtualModel: noop,
	};
	const runner: ExtensionRunner = new host.ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		sessionManager,
		modelRegistry,
	);
	const errors: ExtensionError[] = [];
	runner.bindCore(HOST_ACTIONS, CONTEXT_ACTIONS);
	runner.bindCommandContext({
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	});
	runner.onError((error) => {
		errors.push(error);
	});

	return {
		cwd,
		hostVersion: host.VERSION,
		errors,
		getDeclaredRegistrations: () => {
			/** One entry per name a loaded extension declared in `pick`. */
			const names = (
				pick: (extension: Extension) => ReadonlyMap<string, unknown>,
			): string[] => [
				...new Set(loaded.extensions.flatMap((ext) => [...pick(ext).keys()])),
			];
			return {
				handlers: names((ext) => ext.handlers),
				flags: names((ext) => ext.flags),
				commands: names((ext) => ext.commands),
			};
		},
		getFlags: () => runner.getFlags(),
		getAllRegisteredTools: () => runner.getAllRegisteredTools(),
		getRegisteredCommands: () => runner.getRegisteredCommands(),
		hasHandlers: (event) => runner.hasHandlers(event),
	};
}

/**
 * Drain the test-side writers, put the environment back, then remove every
 * fixture root this file owns. The drain covers the modules this test process
 * loaded through Vite. It cannot reach the copy pi's loader created — that copy
 * is a separate jiti module graph with its own write queues (#4641 F4) — which
 * is why this tier emits no lifecycle event: a `session_start` emitted into the
 * loaded copy would schedule writes into the pinned home that nothing here can
 * await, and the root removed first would be re-created by its own writer
 * (#2912). The fixture lives for the whole file, which is why `startPiRunner`
 * belongs in `beforeAll`.
 */
afterAll(async () => {
	await drainBackgroundWritesForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const cleanup of liveFixtures.splice(0)) cleanup();
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});
