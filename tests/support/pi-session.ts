/**
 * Tier 2 of the real-host test seam (#4632): the BUILT pi-lens extension inside
 * a real pi `AgentSession`, with a scripted model at the provider boundary. No
 * child process, no network, in process.
 *
 * What the seam is. `createAgentSessionServices` builds pi's real services and
 * runs pi's OWN extension loader over `index.js` (`additionalExtensionPaths` →
 * `discoverAndLoadExtensions`, the same call `tests/support/pi-runner.ts`
 * makes); `createAgentSessionFromServices` builds the real `AgentSession`;
 * pi-ai's `fauxProvider` answers every provider request and records the
 * messages pi actually sent. `tests/support/pi-mock.ts` records what
 * `index.ts` PASSED to a handler; this tier records what the host and the
 * model actually GOT.
 *
 * ONE FIXTURE ROOT PER FILE, one live session per case, and both are enforced
 * rather than documented. `piSessionFixture()` pins the file's root as it
 * creates it, and `startPiSession` refuses any other root: a session started
 * under a SECOND fixture root writes into the first root's home and nothing
 * into its own — measured: the second root's session put 78 `session_start`
 * rows under the first root's home and 0 under its own, whose `home/`
 * directory it still created (#4664 F4). A case that needs another project
 * root passes another `cwd` under the same root. Every handle is registered
 * when it is created and disposed in `afterEach`, so a case that fails before
 * its own `dispose()` leaves no live session for the next case (#4664 M2); a
 * session still live in a different root would be classified by pi-lens as a
 * concurrent secondary, whose full start it declines.
 *
 * What it pins, and what it does not. It pins the session loop's own flow —
 * `session_start`, a turn, a tool-call round trip, the transcript the provider
 * receives, resume from the persisted session file, and manual compaction —
 * so a case asserts an effect of the extension's registered behaviour rather
 * than the shape of a handler's return value. It does NOT pin event payload
 * shapes: for those `pi-mock.ts`'s `emit` stays the cheaper tool, and tier 1's
 * `pi-runner.ts` owns registration questions.
 *
 * SIX CONSEQUENCES OF LOADING THROUGH PI'S OWN LOADER, all relied on below:
 *
 * 1. pi loads the entry with jiti and `moduleCache: false`, so the factory runs
 *    against its OWN copies of `clients/*` — never the copies this test
 *    process imported. Assert on what leaves the copy (provider requests, pi's
 *    session entries, files under the pinned root, process-wide registries),
 *    never on a module object identity.
 * 2. The copy reads `PI_LENS_HOME` / `PILENS_DATA_DIR` at its own load, so both
 *    are pinned here BEFORE the load, saved in a module-scope record and put
 *    back in `afterAll` (`tests/config/test-env-restore-sweep.test.ts`'s
 *    accepted shape). `PI_LENS_TEST_MODE=0` matches
 *    `tests/index-3521-fork-tree-witness.test.ts`: the start runs its
 *    production writes instead of the test-mode shortcuts.
 * 3. `PI_LENS_STARTUP_MODE` pins the start shape, and the pinned value is what
 *    a `session_start_total` row reports as `mode`. `"full"` (the default here)
 *    settles the start inside `bindExtensions`. `"quick"` is the shape a real
 *    process's FIRST `session_start` takes (the cold-start heuristic), and it
 *    is paired with `PI_LENS_COLD_START_QUICK=0`: a quick start otherwise arms
 *    an unref'd 2 s warmup timer (`clients/runtime-session.ts`), and the warmup's
 *    project-snapshot persist is a module-scope queue in the loaded copy that
 *    nothing here can drain — measured, it lands after this fixture root is
 *    gone and re-creates it (the accepted `p3` residual in the PR body). The
 *    opt-out drops the TIMER, not the quick start: the skipped-work branch and
 *    the `mode: "quick"` row are what a quick-mode case observes.
 * 4. The load builds jiti's transform cache at `path.join(os.tmpdir(), "jiti")`,
 *    so `os.tmpdir()` is aimed inside the fixture for the load only — tier 1's
 *    `withFixtureTmpdir`, now the ONE copy in `tests/clients/test-utils.ts`
 *    (#4641 F1: a direct child of the shared tmp root is a fixture sibling to
 *    the tmp-hygiene census).
 * 5. The scripted provider comes from the HOST's own `@earendil-works/pi-ai`,
 *    resolved at runtime through the host package's directory (`piAiModule`)
 *    instead of a static specifier: that package is not a dependency of this
 *    repo — it ships inside the certified host's install — so declaring it here
 *    would pin a second version of a module the host answers for itself
 *    (#4664 F1). Nothing in this file or in a case that imports it holds a
 *    `@earendil-works/pi-ai` import specifier for knip to read.
 * 6. Teardown does NOT pretend to reach the loaded copy's internals. Three
 *    seams are real and are used:
 *      - pi's `ExtensionRunner.emit` AWAITS every handler
 *        (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`),
 *        and emitting `session_shutdown` therefore runs the copy's own shutdown
 *        handler: its primary release, its registry deregistration, and its
 *        writer drain (`index.ts` returns
 *        `bounded(flushAllNdjsonWriters(), …)`). That handler's effects are what
 *        the helper's contract test reads back;
 *      - the NDJSON writer map is process-global
 *        (`clients/ndjson-logger.ts`, `Symbol.for("pi-lens.ndjson-logger.state")`),
 *        so `flushAllNdjsonWriters()` from this side settles the copy's sinks
 *        too (probed: 13 writers, all under the pinned home). It is a
 *        belt-and-braces second drain, NOT the proof that the emit ran: it
 *        writes the same rows either way, so a case that must prove the emit
 *        asserts a handler effect instead;
 *      - the registry mutation tail is process-global too (#2146 keys it on
 *        `globalThis`), so `_settleRegistryMutationsForTests()` here joins the
 *        copy's own queued `deregisterInstance()` write. Without that await the
 *        write lands after `dispose()` returns and re-creates the removed
 *        fixture root (#4664 F7, probed).
 *    The copy's module-scope persist queues (`clients/project-snapshot.ts`,
 *    `clients/review-graph/builder.ts`, the warmup timer) have no such seam:
 *    they are reachable only through the copy's own module objects, which
 *    nothing here holds. That is the `p3` residual documented in the PR body,
 *    NOT a silence.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach } from "vitest";
import { _settleRegistryMutationsForTests } from "../../clients/instance-registry-tail.js";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
	withFixtureTmpdir,
} from "../clients/test-utils.js";

/** The built extension every case loads: `npm run build` writes this twin. */
const EXTENSION_ENTRY = fileURLToPath(
	new URL("../../index.js", import.meta.url),
);

/**
 * The scripted-provider package, and the host whose dependency graph supplies
 * it. `@earendil-works/pi-ai` is NOT a dependency of this repo: it ships inside
 * the certified host's own install, and a row for it here would pin a second
 * version of a module the host must answer for itself (#4664 F1). So the module
 * is resolved at RUNTIME through the host package's directory — never through a
 * static specifier the dependency graph (and `npm run knip`) would read.
 *
 * The host constants repeat `tests/support/pi-runner.ts`'s rather than being
 * imported from it: that module registers file-scope vitest hooks (`afterAll`)
 * on import, so a tier-2 file importing it for two strings would attach tier
 * 1's teardown to itself.
 */
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
/**
 * Points the helper at another installed host, as a package directory or a
 * module file — tier 1's own override (`tests/support/pi-runner.ts`), honoured
 * here for the one module this tier loads from the host's graph.
 */
const HOST_PACKAGE_ENV = "PI_LENS_PI_HOST_PACKAGE";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/** One message pi sent to the provider, as the live module shaped it. */
export interface PiMessage {
	readonly role: string;
	readonly content?: unknown;
	readonly [key: string]: unknown;
}

/** What a scripted reply receives: the request pi is answering. */
export interface PiFauxContext {
	readonly messages: readonly PiMessage[];
}

/** A scripted reply computed from the request pi is answering. */
export type PiFauxReplyFactory = (
	context: PiFauxContext,
	options: unknown,
	state: unknown,
	model: unknown,
) => Record<string, unknown>;

/** A scripted provider reply: a message, or a function of the request it answers. */
export type PiFauxReply = Record<string, unknown> | PiFauxReplyFactory;

/** The provider half of the host's own `pi-ai` that this tier calls. */
interface FauxProviderHandle {
	readonly provider: unknown;
	setResponses(responses: readonly PiFauxReply[]): void;
}

/**
 * The host's `@earendil-works/pi-ai` surface this tier uses. Structural on
 * purpose: the module is loaded at runtime, so no declaration of it can come
 * from its own package (see `piAiModule`).
 */
interface PiAiModule {
	fauxProvider(options?: {
		models?: readonly Record<string, unknown>[];
	}): FauxProviderHandle;
	fauxText(text: string): Record<string, unknown>;
	fauxToolCall(
		name: string,
		arguments_: Record<string, unknown>,
		options?: { id?: string },
	): Record<string, unknown>;
	fauxAssistantMessage(
		content: unknown,
		options?: Record<string, unknown>,
	): Record<string, unknown>;
}

const nodeRequire = createRequire(import.meta.url);

let loadedPiAi: PiAiModule | undefined;

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * `<dir>/node_modules/<name>` at `from` and at every ancestor, in node's own
 * order (a directory already named `node_modules` is not searched again), so a
 * nested install wins over the hoisted one exactly as it does for a real
 * `import`.
 */
function findPackageDir(name: string, from: string): string | undefined {
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		if (path.basename(dir) !== "node_modules") {
			const candidate = path.join(dir, "node_modules", name);
			if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}

/** The package directory a package directory or a module file lives in. */
function packageRootOf(target: string): string {
	if (isDirectory(target)) return target;
	for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		if (path.dirname(dir) === dir) return path.dirname(target);
	}
}

/** The install the extension under test runs in: the override, or this repo's host. */
function hostPackageDir(): string {
	const override = process.env[HOST_PACKAGE_ENV];
	if (override) return packageRootOf(path.resolve(override));
	const here = path.dirname(fileURLToPath(import.meta.url));
	const hostDir = findPackageDir(HOST_PACKAGE, here);
	if (hostDir === undefined)
		throw new Error(
			`pi-session: cannot find ${HOST_PACKAGE} from ${here}; set ${HOST_PACKAGE_ENV} to the host package's directory`,
		);
	return hostDir;
}

/** The `import` entry a package's own `package.json` declares. */
function packageEntry(packageDir: string): string {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
	) as { exports?: Record<string, unknown>; main?: string };
	const root = manifest.exports?.["."];
	const declared =
		root && typeof root === "object"
			? (root as { import?: unknown }).import
			: undefined;
	const target = typeof declared === "string" ? declared : manifest.main;
	if (typeof target !== "string")
		throw new Error(
			`pi-session: ${packageDir}/package.json declares no import entry`,
		);
	return path.join(packageDir, target);
}

/**
 * The host's own scripted provider, loaded once per file at RUNTIME. Fails
 * loudly rather than skipping: a host that stopped exporting `fauxProvider`
 * makes every case in this tier meaningless, and a quiet fallback would report
 * that as a green run.
 */
export function piAiModule(): PiAiModule {
	if (loadedPiAi) return loadedPiAi;
	const hostDir = hostPackageDir();
	const piAiDir = findPackageDir(PI_AI_PACKAGE, hostDir);
	if (piAiDir === undefined)
		throw new Error(
			`pi-session: the host install at ${hostDir} carries no ${PI_AI_PACKAGE}; ${HOST_PACKAGE_ENV} must name one that does`,
		);
	const entry = packageEntry(piAiDir);
	const loaded = nodeRequire(entry) as Partial<PiAiModule>;
	for (const name of [
		"fauxProvider",
		"fauxText",
		"fauxToolCall",
		"fauxAssistantMessage",
	] as const) {
		if (typeof loaded[name] !== "function")
			throw new Error(`pi-session: ${entry} does not export ${name}`);
	}
	loadedPiAi = loaded as PiAiModule;
	return loadedPiAi;
}

/** pi-ai's `fauxText`, through the host's own module (see `piAiModule`). */
export function fauxText(text: string): Record<string, unknown> {
	return piAiModule().fauxText(text);
}

/** pi-ai's `fauxToolCall`, through the host's own module (see `piAiModule`). */
export function fauxToolCall(
	name: string,
	arguments_: Record<string, unknown>,
	options?: { id?: string },
): Record<string, unknown> {
	return piAiModule().fauxToolCall(name, arguments_, options);
}

/** pi-ai's `fauxAssistantMessage`, through the host's own module (see `piAiModule`). */
export function fauxAssistantMessage(
	content: unknown,
	options?: Record<string, unknown>,
): Record<string, unknown> {
	return piAiModule().fauxAssistantMessage(content, options);
}

const TMP_PREFIX = "pi-lens-pi-session-";

const FAUX_MODEL: Record<string, unknown> = {
	id: "faux-1",
	name: "Faux",
	contextWindow: 200_000,
	maxTokens: 4_096,
};

/**
 * The flag set a case runs with unless it overrides it: the same six the
 * repo's other real-session drivers pin (`tests/index-3521-fork-tree-witness.test.ts`,
 * `tests/index-integration.test.ts`), plus `no-complexity`. The complexity
 * baseline is an analyzer pull fired by a `read`/`edit` tool call
 * (`clients/runtime-tool-call.ts`), i.e. asynchronous work this tier neither
 * observes nor can drain; a case that needs it deletes the flag.
 */
const DEFAULT_FLAGS: ReadonlyArray<[string, boolean]> = [
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
];

/** One provider request: the messages the model received, in order. */
export type PiProviderRequest = ReadonlyArray<PiMessage>;

export interface PiSessionOptions {
	/** Fixture root, created by `setupTestEnvironment(TMP_PREFIX)` below. */
	root: string;
	/** Scripted provider replies, one per expected request (the host's `fauxProvider`). */
	responses: readonly PiFauxReply[];
	/**
	 * Project directory the session runs in. Defaults to `<root>/proj`, which
	 * the helper marks with `.git`; passing this checkout would make every
	 * project-state write land in it. A second session may name any other
	 * directory UNDER `root` (that is how a multi-root case runs two roots); a
	 * second ROOT is refused — see `pinEnv`.
	 */
	cwd?: string;
	/** `pi.getFlag` values; defaults to {@link DEFAULT_FLAGS}. */
	flags?: ReadonlyMap<string, boolean | string>;
	/** Session store. Defaults to `<root>/sessions`. */
	sessionsDir?: string;
	/**
	 * Startup shape pinned through `PI_LENS_STARTUP_MODE`, which is also the
	 * `mode` a `session_start_total` row reports. `"full"` (the default) settles
	 * the start inside `bindExtensions`; `"quick"` is the shape a real process's
	 * first `session_start` takes, with the warmup timer opted out — see the
	 * header, point 3.
	 */
	startupMode?: "full" | "quick";
}

export interface PiSession {
	/** pi's real session. Its `extensionRunner` is the loaded copy's host. */
	readonly session: AgentSession;
	/** Absolute project directory the session runs in. */
	readonly cwd: string;
	/** Every provider request, in order, deep-cloned as pi sent it. */
	readonly requests: PiProviderRequest[];
	/** Errors pi reported from an extension handler (`runner.onError`). */
	readonly errors: unknown[];
	/** The persisted session file, once pi has written one. */
	sessionFile(): string | undefined;
	/** Run one prompt to completion (tool calls included). */
	prompt(text: string): Promise<void>;
	/** Manual compaction, pi's `/compact` entry point. */
	compact(instructions?: string): Promise<unknown>;
	/**
	 * Reopen this session's persisted file in a NEW session with a new provider
	 * script — the resume path a restarted process takes.
	 */
	resume(responses: readonly PiFauxReply[]): Promise<PiSession>;
	/** Settle the loaded copy, dispose the session, drain. Idempotent. */
	dispose(): Promise<void>;
}

/** The values this file replaced, saved before the first pin (`afterAll` restores). */
const savedEnv: Record<string, string | undefined> = {};

/** The one fixture root this file pinned; a second root is refused (see below). */
let pinnedRoot: string | undefined;

/** Fixtures this file still owns; removed with the environment in `afterAll`. */
const liveFixtures: Array<() => void> = [];

/**
 * Every handle this file created and has not yet seen disposed. `afterEach`
 * below disposes them, so a case that fails between `startPiSession` and its
 * own `dispose()` cannot leave a live session behind for the next case
 * (#4664 M2: a leaked primary in another root declines the next start, which
 * turns one red assertion into a cascade).
 */
const liveHandles: PiSession[] = [];

const PINNED_KEYS = [
	"PI_LENS_HOME",
	"PILENS_DATA_DIR",
	"PI_LENS_TEST_MODE",
	"PI_LENS_STARTUP_MODE",
	"PI_LENS_COLD_START_QUICK",
] as const;

/** The one-root rule (see `startPiSession`): a second root cannot be observed. */
function assertOneRoot(root: string): void {
	// ONE ROOT PER FILE. A session started under a SECOND fixture root writes
	// into the FIRST root's home and nothing into its own: measured — the
	// second root's session put 78 `session_start` rows under the first
	// root's home against 0 under its own, whose `home/` directory it still
	// created. The seam that holds the copy to its first home was not
	// isolated, and `clients/probe-home-state.ts` is NOT it: that module
	// re-reads `PI_LENS_HOME` on every call (#4664 F4). So this guard states
	// the measurement, not a module. Sessions that need a different project
	// root pass a different `cwd` UNDER this root.
	if (pinnedRoot !== undefined && pinnedRoot !== root)
		throw new Error(
			`pi-session: one fixture root per test file — this file already pinned ${pinnedRoot}, so the loaded copy keeps that home and ${root} would observe nothing (pass a different cwd under ${pinnedRoot} instead)`,
		);
	pinnedRoot = root;
}

/** A model runtime whose only provider is the scripted one. */
async function buildModelRuntime(
	agentDir: string,
	responses: readonly PiFauxReply[],
	requests: PiProviderRequest[],
): Promise<{ modelRuntime: ModelRuntime; model: unknown }> {
	const faux = piAiModule().fauxProvider({ models: [FAUX_MODEL] });
	// Every scripted step is wrapped so the request it answered is recorded
	// before the reply is produced: `requests.length` is then the count of
	// provider round trips pi actually made.
	faux.setResponses(
		responses.map(
			(step): PiFauxReplyFactory =>
				(context, options, state, model) => {
					requests.push(
						context.messages.map((message) => structuredClone(message)),
					);
					return typeof step === "function"
						? step(context, options, state, model)
						: structuredClone(step);
				},
		),
	);
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		authPath: path.join(agentDir, "auth.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider as never);
	const model = modelRuntime.getModel("faux", FAUX_MODEL.id as string);
	if (!model) throw new Error("the faux provider registered no model");
	return { modelRuntime, model };
}

/**
 * Build one session against the pinned environment. `sessionManager` decides
 * whether this is a new session (`SessionManager.create`) or a resume
 * (`SessionManager.open`).
 */
async function buildSession(args: {
	root: string;
	cwd: string;
	agentDir: string;
	responses: readonly PiFauxReply[];
	flags: ReadonlyMap<string, boolean | string>;
	sessionManager: () => SessionManager;
}): Promise<PiSession> {
	const requests: PiProviderRequest[] = [];
	const { modelRuntime, model } = await buildModelRuntime(
		args.agentDir,
		args.responses,
		requests,
	);
	const services = await withFixtureTmpdir(args.root, () =>
		createAgentSessionServices({
			cwd: args.cwd,
			agentDir: args.agentDir,
			modelRuntime,
			extensionFlagValues: new Map(args.flags),
			resourceLoaderOptions: {
				additionalExtensionPaths: [EXTENSION_ENTRY],
			},
		}),
	);
	const loadErrors = services.resourceLoader.getExtensions().errors;
	if (loadErrors.length > 0) {
		throw new Error(
			`pi failed to load ${EXTENSION_ENTRY}: ${JSON.stringify(loadErrors.map((entry) => String(entry.error)))}`,
		);
	}
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: args.sessionManager(),
		model: model as never,
	});
	const errors: unknown[] = [];
	await session.bindExtensions({
		onError: (error: unknown) => errors.push(error),
	});
	let disposed = false;
	const handle: PiSession = {
		session,
		cwd: args.cwd,
		requests,
		errors,
		sessionFile: () => session.sessionManager.getSessionFile(),
		async prompt(text) {
			await session.prompt(text);
		},
		async compact(instructions) {
			return session.compact(instructions);
		},
		async resume(responses) {
			const file = session.sessionManager.getSessionFile();
			if (!file || !fs.existsSync(file))
				throw new Error(
					`pi-session: nothing to resume — the session wrote no file under ${args.root}/sessions`,
				);
			await handle.dispose();
			return buildSession({
				...args,
				responses,
				sessionManager: () => SessionManager.open(file, path.dirname(file)),
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			// pi awaits every handler it emits, so this runs the LOADED copy's
			// own `session_shutdown` handler: its primary release, its registry
			// deregistration, and its writer drain (the handler returns
			// `bounded(flushAllNdjsonWriters(), …)`).
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			} as never);
			session.dispose();
			// The same process-global writer map the loaded copy registered into:
			// a second, test-side settle of the same sinks. It writes the same
			// rows whether or not the emit above ran, so it is a belt, never the
			// proof that the handler did (a case that proves the emit asserts a
			// handler effect, not a log row).
			await flushAllNdjsonWriters();
			await drainBackgroundWritesForTests();
			// Join the copy's queued registry mutations AND the sink rows those
			// mutations log. #2146 keys the tail on `globalThis`, so this import
			// joins the copy's own queue; without the join the deregistration
			// write lands after `dispose()` returns and re-creates the removed
			// fixture root — measured on this host, warm process: 5 of 5 runs,
			// 5–8 ms after the removal, carrying `instances.json.locks/…`,
			// `cascade.log` and `latency.log` (#4664 F7).
			//
			// TWO rounds, because a round joins only what is queued when it is
			// called: the deregistration mutation logs its own sink rows, and the
			// registry read taken inside it can queue the next mutation (the
			// dead-pid prune). Measured the same way: one round still re-created
			// the root in 1 of 5 runs, two rounds in 0 of 6.
			for (let round = 0; round < 2; round += 1) {
				await _settleRegistryMutationsForTests();
				await flushAllNdjsonWriters();
			}
		},
	};
	// Registered the moment the session exists, BEFORE any assertion the case
	// makes: `afterEach` disposes whatever is still live, so a failing case
	// cannot leave a primary session behind for the next one (#4664 M2).
	liveHandles.push(handle);
	return handle;
}

/**
 * Start a real session over the built extension for one fixture. Call it once
 * per test file and keep the handle: the fixture, the load (~0.2 s) and the
 * session belong to the file, and `afterAll` below removes them.
 */
export async function startPiSession(
	options: PiSessionOptions,
): Promise<PiSession> {
	const cwd = options.cwd ?? path.join(options.root, "proj");
	const agentDir = path.join(options.root, "agent");
	const sessionsDir =
		options.sessionsDir ?? path.join(options.root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	assertOneRoot(options.root);
	// Save before pinning: the loaded copy reads these at its own load, so the
	// pin must precede `createAgentSessionServices`.
	for (const key of PINNED_KEYS) {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_HOME = path.join(options.root, "home");
	process.env.PILENS_DATA_DIR = path.join(options.root, "data");
	process.env.PI_LENS_TEST_MODE = "0";
	const startupMode = options.startupMode ?? "full";
	process.env.PI_LENS_STARTUP_MODE = startupMode;
	// A quick start is the production FIRST-session shape, and it arms pi-lens's
	// cold-start warmup timer. That timer's project-snapshot persist is
	// module-scope in the loaded copy with no test-side drain (the `p3` residual
	// in the PR body), so it lands after this fixture root is removed and
	// re-creates it. The documented opt-out drops the TIMER only: the quick
	// start branch — the skipped work and the `mode: "quick"` row — still runs.
	if (startupMode === "quick") process.env.PI_LENS_COLD_START_QUICK = "0";
	else delete process.env.PI_LENS_COLD_START_QUICK;
	return buildSession({
		root: options.root,
		cwd,
		agentDir,
		responses: options.responses,
		flags: options.flags ?? new Map(DEFAULT_FLAGS),
		sessionManager: () => SessionManager.create(cwd, sessionsDir),
	});
}

/**
 * Create the file's fixture root. The caller owns the handle for the file's
 * lifetime; `afterAll` below removes it after the drain.
 *
 * This call PINS the file's one root. The guard therefore fires even when no
 * case has started a session yet, which makes it independent of case order: a
 * second `piSessionFixture()` — or a `startPiSession` under another root —
 * fails at creation instead of quietly starting a session that observes
 * nothing (#4664 M1).
 */
export function piSessionFixture(): { root: string; cleanup: () => void } {
	const fixture = setupTestEnvironment(TMP_PREFIX);
	assertOneRoot(fixture.tmpDir);
	liveFixtures.push(fixture.cleanup);
	return { root: fixture.tmpDir, cleanup: fixture.cleanup };
}

/**
 * Dispose every handle this file created that is still live: the per-case
 * teardown, and the reason a failing assertion cannot cascade into the next
 * case (#4664 M2). `dispose()` is idempotent, so a case that disposes its own
 * handle is a no-op here.
 */
afterEach(async () => {
	for (const handle of liveHandles.splice(0)) await handle.dispose();
});

/**
 * Settle, put the environment back, then remove every fixture root this file
 * owns. `afterEach` above already disposed each case's handles; this pass is
 * the backstop for a case that threw before its first `await`, plus the
 * settle/removal order. The copy's module-scope persist queues stay
 * unreachable (header, point 6).
 */
afterAll(async () => {
	for (const handle of liveHandles.splice(0)) await handle.dispose();
	await drainBackgroundWritesForTests();
	await _settleRegistryMutationsForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const cleanup of liveFixtures.splice(0)) cleanup();
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});
