/**
 * #2657 / #4242 item 3: the CLASS decides what a session registers.
 *
 * Recurrence it prevents: the `tool_call` seam registered `path.dirname(
 * filePath)` — a raw directory answer, not an ownership one — and the #4532
 * shape that replaced it registered the resolved analysis root for EVERY
 * class. An adopted project therefore became a registered SESSION root, which
 * launders `adopted` into `session` for `ClientRegistry.analysisRootModeForFile`
 * (`clients/lsp/client-registry.ts`), skips the `admitAdoptedRoot` gate
 * (cap 2, 60 s idle, project-local-binary refusal) and spends the FIFO(128)
 * session budget instead. A linked worktree has the opposite requirement: it is
 * its own workspace with its own `.pi-lens.json`, and `resolveServerRoot`'s
 * #2052 gate refuses a file outside every registered root, so it MUST be
 * registered — as the worktree root, never as the edited file's directory.
 *
 * Real: `handleToolCall` (the production call site), `resolveSessionConfigRoot`,
 * the real `initLSPConfig` loader and its session-root registry, the real
 * `ClientRegistry` that answers `analysisRootModeForFile` and gates
 * `admitAdoptedRoot`. No module is mocked and no language server is spawned.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	resolveAnalysisRoot,
	resolveAnalysisRootPath,
	resolveSessionConfigRoot,
} from "../../../clients/analysis-root.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { ClientRegistry } from "../../../clients/lsp/client-registry.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	disabledPrimaries,
	getSessionRootsForTelemetry,
	isSessionRootRegistered,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import { resolveGitCheckout } from "../../../clients/review-graph/git-identity.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { resetSessionScopedState } from "../../../clients/runtime-session.js";
import { handleToolCall } from "../../../clients/runtime-tool-call.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../../clients/lsp/service-singleton.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { runHandlerExpectingNoThrow } from "../../support/handler-verdict.js";
import {
	createPathIdentityFixture,
	type PathIdentityFixture,
	pinFixtureHome,
	plantOtherWorktree,
	plantUnrelatedRepo,
	setupTestEnvironment,
	writeLinkedWorktree,
} from "../test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let runtime: RuntimeCoordinator;

/** index.ts's per-cwd memo, without its registry re-check (same effect here). */
const initialized = new Set<string>();
async function memoizedInit(cwd: string): Promise<void> {
	const key = path.resolve(cwd);
	if (initialized.has(key)) return;
	await initLSPConfig(key);
	initialized.add(key);
}

/** One `tool_call` for `filePath`, through the production handler. */
async function readCall(
	filePath: string,
	cwd: string,
	index: number,
): Promise<void> {
	const deps = {
		event: {
			toolName: "read",
			toolCallId: `class-2657-${index}`,
			input: { path: filePath },
		},
		ctx: { cwd },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: memoizedInit,
		updateLspStatus: () => {},
		resetLSPService: () => {},
		sessionId: "pi-lens-class-2657-probe",
	} as unknown as Parameters<typeof handleToolCall>[0];
	await runHandlerExpectingNoThrow(() => handleToolCall(deps));
}

/** The registry's answer, on a real ClientRegistry whose session is `cwd`. */
function registryFor(cwd: string): ClientRegistry {
	return new ClientRegistry(
		{
			releaseNotifyWrite: () => {},
			forgetReadiness: () => {},
			forgetNotifyBacklog: () => {},
			clearStallDemotion: () => {},
			rearmFirstContact: () => {},
			noteDiagnosticsPublished: () => {},
		},
		undefined,
		cwd,
	);
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2657-registration-class-");
	// The shared per-case session reset (AGENTS.md), which also drops the
	// directory-marker index the registration walk reads; the LSP config and
	// session-root stores below are owner resets it does not cover.
	resetSessionScopedState();
	resetLSPConfigStateForTests();
	resetSessionRootsForTests();
	resetDegradationLedger();
	initialized.clear();
	// The language server is the process boundary: a service double keeps this a
	// measurement of the registration rule, not of a spawn.
	resetLSPService();
	const service = makeLspServiceDouble({ supportsLSP: () => false });
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service as Record<string, unknown>,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-class-2657-probe" });
	runtime.beginTurn();
});

afterEach(() => {
	resetLSPService();
	resetLSPConfigStateForTests();
	resetSessionRootsForTests();
	env.cleanup();
});

describe("the analysis-root class decides what a session registers (#2657, #4242)", () => {
	it("registers nothing for an adopted project and keeps it adopted (#4242 item 3)", async () => {
		// A fixture whose own marker makes it eligible to be adopted needs its
		// OWN home, so the $HOME ceiling is the fixture's, not the runner's
		// (#4230 D1: siblings below $HOME are adopted; $HOME and above are
		// refused). `pinFixtureHome` restores it even when setup throws.
		const { home, restore } = pinFixtureHome("analysis-root-class-home");
		const session = path.join(home, "code", "a");
		const adopted = path.join(home, "code", "b");
		fs.mkdirSync(path.join(session, "src"), { recursive: true });
		fs.mkdirSync(path.join(adopted, "src"), { recursive: true });
		fs.writeFileSync(path.join(session, "package.json"), "{}\n");
		fs.writeFileSync(path.join(adopted, "package.json"), "{}\n");
		const adoptedFile = path.join(adopted, "src", "foreign.ts");
		try {
			runtime.projectRoot = session;
			await initLSPConfig(session);
			const before = getSessionRootsForTelemetry(200);
			expect(before).toEqual([session]);
			// The classification this case is about, before any edit.
			expect(resolveAnalysisRoot(adoptedFile, session)).toBe("adopted");

			await readCall(adoptedFile, session, 1);

			// 1. The session registered NOTHING for the adopted project …
			expect(getSessionRootsForTelemetry(200)).toEqual(before);
			expect(isSessionRootRegistered(adopted)).toBe(false);
			// … 2. so the file's class is unchanged for the LSP …
			const registry = registryFor(session);
			expect(registry.analysisRootModeForFile(adoptedFile)).toBe("adopted");
			// … 3. which is exactly the gate `ClientRegistry.admitAdoptedRoot`
			// opens: it declines any file whose mode is not `adopted`. On the
			// #4532 registration shape this returns false because the adopted
			// root was registered as a session root and the mode read `session`.
			const adoptedRoot = resolveAnalysisRootPath(adoptedFile, session);
			expect(adoptedRoot).toBe(adopted);
			expect(
				(
					registry as unknown as {
						admitAdoptedRoot(root: string, filePath: string): boolean;
					}
				).admitAdoptedRoot(adoptedRoot as string, adoptedFile),
			).toBe(true);
			// The adopted class is not a session-bookkeeping population either.
			expect(
				getDegradationSummary().some(
					(group) => group.kind === "lsp-session-root-evicted",
				),
			).toBe(false);
		} finally {
			restore();
		}
	});

	it("registers the worktree root for a linked-worktree file, never its directory", async () => {
		// A linked worktree of the session's checkout, written as the metadata git
		// itself writes (#2657): the worktree's `.git` is a FILE naming a
		// worktree-private gitdir, and that gitdir's `commondir` points at the
		// shared `.git`. No child process is needed, and the class assertion
		// below reds if the fixture ever stops resolving as a worktree. The
		// checkout is a DIRECT child of the temp root with no `pi-lens-` prefix:
		// a pi-owned temp path is refused as an analysis root, which is the
		// intended-skip class and not what this case measures (#4560).
		const checkoutRoot = path.join(
			env.tmpDir,
			"..",
			`capture-2657-worktree-${process.pid}`,
		);
		const { repo, worktree } = writeLinkedWorktree(checkoutRoot);
		const worktreeFile = path.join(worktree, "src", "sibling.ts");
		fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
		fs.writeFileSync(worktreeFile, "export const value = 1;\n");

		try {
			runtime.projectRoot = repo;
			await initLSPConfig(repo);
			expect(getSessionRootsForTelemetry(200)).toEqual([repo]);
			expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");

			await readCall(worktreeFile, repo, 2);

			// Exactly two roots: the session's own, and the worktree's.
			expect([...getSessionRootsForTelemetry(200)].sort()).toEqual(
				[repo, worktree].sort(),
			);
			expect(isSessionRootRegistered(worktree)).toBe(true);
			// The edited file's own directory is NOT a root: that was the #2657
			// population (one registration per directory touched).
			expect(isSessionRootRegistered(path.dirname(worktreeFile))).toBe(false);
			// The class survives registration, so dispatch, the writers and the
			// delivery rung keep treating it as a linked worktree.
			expect(registryFor(repo).analysisRootModeForFile(worktreeFile)).toBe(
				"linked-worktree",
			);
			// Nothing was evicted: the population is workspaces, not directories.
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "lsp-session-root-evicted",
				),
			).toHaveLength(0);
		} finally {
			fs.rmSync(checkoutRoot, { recursive: true, force: true });
		}
	});
});

/**
 * #4689 item 7: the class and the registration compare path IDENTITIES on both
 * sides, and the registration is spelled on the FILE's side.
 *
 * Recurrence it prevents: `classifyAnalysisRoot` compared the real-path root
 * `resolveAnalysisRootPath` returns against `nodePath.resolve(sessionRoot)`, so
 * a symlink-spelled session root classified every in-root file as `adopted`
 * (#4689 rows h and h2) and `resolveSessionConfigRoot` registered nothing for
 * it. The registration walk compared spellings too, so a file spelled through
 * an alias of a real session root registered the session's spelling, which the
 * session-root registry (`clients/lsp/session-roots.ts`, lexical containment)
 * never matches to the file: the #2052 gate then declined the file and its
 * `lsp.disabledServers` denial stopped applying. Rows are the state table in
 * the PR body.
 */
describe("the class and the registration read path identity (#4689 item 7)", () => {
	type Cell = {
		row: string;
		session: (fx: PathIdentityFixture) => string;
		file: (fx: PathIdentityFixture) => string;
		mode: "session" | "none";
		register: (fx: PathIdentityFixture) => string | undefined;
	};
	const real = (fx: PathIdentityFixture, ...rest: string[]) =>
		path.join(fx.repo, ...rest);
	const alias = (fx: PathIdentityFixture, ...rest: string[]) =>
		path.join(fx.aliasRoot, ...rest);
	const none = () => undefined;
	const cells: Cell[] = [
		{
			row: "1 real root, real file",
			session: (fx) => real(fx),
			file: (fx) => real(fx, "src", "real.ts"),
			mode: "session",
			register: (fx) => real(fx),
		},
		{
			row: "2 real root, alias file",
			session: (fx) => real(fx),
			file: (fx) => alias(fx, "src", "real.ts"),
			mode: "session",
			register: (fx) => alias(fx),
		},
		{
			row: "3 real root, alias file under a nested config",
			session: (fx) => real(fx),
			file: (fx) => alias(fx, "pkg", "a.ts"),
			mode: "session",
			register: (fx) => alias(fx, "pkg"),
		},
		{
			row: "4 real root, outside file",
			session: (fx) => real(fx),
			file: (fx) => fx.outsideFile,
			mode: "none",
			register: none,
		},
		{
			row: "5 real root, in-root link out of the root",
			session: (fx) => real(fx),
			file: (fx) => fx.outLink,
			mode: "none",
			register: none,
		},
		{
			row: "6 (h) alias root, real file",
			session: (fx) => alias(fx),
			file: (fx) => real(fx, "src", "real.ts"),
			mode: "session",
			register: (fx) => real(fx),
		},
		{
			row: "7 (h2) alias root, alias file",
			session: (fx) => alias(fx),
			file: (fx) => alias(fx, "src", "real.ts"),
			mode: "session",
			register: (fx) => alias(fx),
		},
		{
			row: "8 alias root, real file under a nested config",
			session: (fx) => alias(fx),
			file: (fx) => real(fx, "pkg", "a.ts"),
			mode: "session",
			register: (fx) => real(fx, "pkg"),
		},
		{
			row: "9 alias root, outside file",
			session: (fx) => alias(fx),
			file: (fx) => fx.outsideFile,
			mode: "none",
			register: none,
		},
		{
			row: "10 missing alias root, real file",
			session: (fx) => alias(fx, "gone"),
			file: (fx) => real(fx, "gone", "src", "a.ts"),
			mode: "session",
			register: (fx) => real(fx, "gone"),
		},
		{
			row: "11 missing alias root, alias file",
			session: (fx) => alias(fx, "gone"),
			file: (fx) => alias(fx, "gone", "src", "a.ts"),
			mode: "session",
			register: (fx) => alias(fx, "gone"),
		},
		{
			row: "12 missing real root, real file",
			session: (fx) => real(fx, "gone"),
			file: (fx) => real(fx, "gone", "src", "a.ts"),
			mode: "session",
			register: (fx) => real(fx, "gone"),
		},
		{
			row: "13 missing alias root, outside file",
			session: (fx) => alias(fx, "gone"),
			file: (fx) => fx.outsideFile,
			mode: "none",
			register: none,
		},
	];

	it.for(cells)("row $row", async (cell, ctx) => {
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		// The operator's denial at the root: the registered root must carry it
		// to the file, whatever spelling either side uses.
		fs.writeFileSync(
			real(fx, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["typescript"] } }),
		);
		fs.mkdirSync(real(fx, "pkg"), { recursive: true });
		fs.writeFileSync(real(fx, "pkg", ".pi-lens.json"), "{}\n");
		fs.writeFileSync(real(fx, "pkg", "a.ts"), "export const a = 1;\n");
		const session = cell.session(fx);
		const file = cell.file(fx);
		const expected = cell.register(fx);
		runtime.projectRoot = session;
		// session_start registers the session root as the host spelled it.
		await initLSPConfig(session);

		expect(resolveAnalysisRoot(file, session)).toBe(cell.mode);
		expect(resolveSessionConfigRoot(file, session)).toEqual({
			register: expected,
			mode: cell.mode,
		});

		await readCall(file, session, 4689);

		const registry = registryFor(session);
		if (expected === undefined) {
			expect(getSessionRootsForTelemetry(200)).toEqual([session]);
			return;
		}
		expect(isSessionRootRegistered(expected)).toBe(true);
		// The #2052 gate serves the file, so its root's denial reaches it, and
		// the LSP keeps the session class for it.
		expect(registry.fileIsOutsideRegisteredRoots(file)).toBe(false);
		expect(disabledPrimaries(file).disabledServerIds).toContain("typescript");
		expect(registry.analysisRootModeForFile(file)).toBe("session");
		// Never the edited file's own directory (the #2657 population).
		if (path.dirname(file) !== expected)
			expect(isSessionRootRegistered(path.dirname(file))).toBe(false);
	});

	it("row 15 a link from outside into the root registers the link's entry, never the dir outside", async (ctx) => {
		// No ancestor of `ext/in/deep/real.ts` is the session root, so the walk
		// stops at `ext`, which is outside it, and never registers the config
		// owner there: every file under `ext` would then read as a session file.
		// It registers `ext/in`, the outermost ancestor whose identity is inside
		// the root, so the #2052 gate serves the file. Recurrence: #4734
		// Sourcery thread 1; the host-spelling fallback declined this file,
		// which master's dirname registration served.
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const ext = path.join(env.tmpDir, "ext");
		fs.mkdirSync(ext, { recursive: true });
		fs.writeFileSync(path.join(ext, ".pi-lens.json"), "{}\n");
		fs.symlinkSync(path.join("..", "repo", "src"), path.join(ext, "in"), "dir");
		fs.mkdirSync(real(fx, "src", "deep"), { recursive: true });
		const entry = path.join(ext, "in");
		const file = path.join(entry, "deep", "real.ts");
		const session = fx.aliasRoot;
		runtime.projectRoot = session;
		await initLSPConfig(session);

		expect(resolveSessionConfigRoot(file, session)).toEqual({
			register: entry,
			mode: "session",
		});
		await readCall(file, session, 4691);
		expect([...getSessionRootsForTelemetry(200)].sort()).toEqual(
			[session, entry].sort(),
		);
		const registry = registryFor(session);
		expect(registry.fileIsOutsideRegisteredRoots(file)).toBe(false);
		expect(registry.analysisRootModeForFile(file)).toBe("session");

		// A FILE link from outside has no ancestor inside the root: the session
		// root's identity (item 7: the register is never the host's spelling),
		// and never `ext`.
		const fileLink = path.join(ext, "f.ts");
		fs.symlinkSync(real(fx, "src", "real.ts"), fileLink);
		expect(resolveSessionConfigRoot(fileLink, session)).toEqual({
			register: fx.repo,
			mode: "session",
		});
	});

	it("row 17 a file link from outside registers the session root's identity, through a link-spelled root", async (ctx) => {
		// Recurrence it prevents: `resolveSessionConfigRoot` fell back to
		// `nodePath.resolve(sessionRoot)` when no ancestor of the file's
		// spelling is inside the root (#4689 item 7, probe row h), so the host
		// handed `ensureLSPConfigInitialized` the link spelling of the session
		// root while every classification above it compared identities. The
		// register is the session root's identity, whatever the host spelled.
		const fx = createPathIdentityFixture(env.tmpDir);
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const ext = path.join(env.tmpDir, "ext");
		fs.mkdirSync(ext, { recursive: true });
		const fileLink = path.join(ext, "f.ts");
		fs.symlinkSync(real(fx, "src", "real.ts"), fileLink);
		runtime.projectRoot = fx.aliasRoot;
		await initLSPConfig(fx.aliasRoot);

		expect(resolveAnalysisRoot(fileLink, fx.aliasRoot)).toBe("session");
		expect(resolveSessionConfigRoot(fileLink, fx.aliasRoot)).toEqual({
			register: fx.repo,
			mode: "session",
		});
		await readCall(fileLink, fx.aliasRoot, 4693);
		expect([...getSessionRootsForTelemetry(200)].sort()).toEqual(
			[fx.aliasRoot, fx.repo].sort(),
		);
		expect(isSessionRootRegistered(ext)).toBe(false);
	});

	it("row 18 a file link into another worktree of the checkout reads linked-worktree and registers the worktree root", async (ctx) => {
		// The other-worktree member of the #4689 fixture family. Recurrence it
		// prevents: the link is spelled under the session root but owned by a
		// linked worktree, so a class or registration decided from the spelling
		// reads `session` and registers a root that never holds the worktree's
		// file. The identity reads `linked-worktree`; no ancestor of the link's
		// spelling is inside the worktree, so the registration falls back to the
		// owning root the class resolved, the worktree root, which the #2052 gate
		// needs to admit the file (#4957 review F1). Beside the temp root for
		// #4560.
		const base = path.join(
			env.tmpDir,
			"..",
			`capture-4689-other-worktree-${process.pid}`,
		);
		try {
			const fx = createPathIdentityFixture(base);
			const wt = plantOtherWorktree(base);
			if (fx.skipReason || wt.skipReason)
				return ctx.skip(fx.skipReason ?? wt.skipReason);
			runtime.projectRoot = fx.repo;
			await initLSPConfig(fx.repo);

			expect(resolveAnalysisRoot(wt.worktreeLink, fx.repo)).toBe(
				"linked-worktree",
			);
			expect(resolveSessionConfigRoot(wt.worktreeLink, fx.repo)).toEqual({
				register: wt.worktree,
				mode: "linked-worktree",
			});
			// The control: the worktree's own spelling registers the worktree.
			expect(resolveSessionConfigRoot(wt.worktreeFile, fx.repo)).toEqual({
				register: wt.worktree,
				mode: "linked-worktree",
			});
			// The delta across the call, not the total: `initLSPConfig` above
			// already registered `fx.repo`, so a neutered production register
			// leaves a total unchanged (#4957 review F3).
			const before = new Set(getSessionRootsForTelemetry(200));
			await readCall(wt.worktreeLink, fx.repo, 4694);
			expect(
				getSessionRootsForTelemetry(200).filter((root) => !before.has(root)),
			).toEqual([wt.worktree]);
			// The #2052 gate admits the file the class resolved.
			expect(
				registryFor(fx.repo).fileIsOutsideRegisteredRoots(wt.worktreeFile),
			).toBe(false);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	it("row 19 a file link into an unrelated repository reads adopted and registers nothing", async (ctx) => {
		// The unrelated-repository member of the #4689 fixture family. Recurrence
		// it prevents: a link spelled under the session root whose identity is a
		// foreign project was read as the session's own file, so the session
		// registered a root for it and the foreign project skipped every
		// adopted-root rule (#2657 shape 3). `base` has no `pi-lens-` prefix, so
		// the foreign project reads `adopted` and not the pi-owned `none` (#4560).
		const base = path.join(
			env.tmpDir,
			"..",
			`capture-4689-unrelated-${process.pid}`,
		);
		try {
			const fx = createPathIdentityFixture(base);
			const other = plantUnrelatedRepo(base);
			if (fx.skipReason || other.skipReason)
				return ctx.skip(fx.skipReason ?? other.skipReason);
			runtime.projectRoot = fx.repo;
			await initLSPConfig(fx.repo);

			// Two checkouts, so the cell reaches the same-checkout rule and not
			// "the session has no checkout" (#4957 review F4).
			expect(resolveGitCheckout(fx.repo)).not.toBeNull();
			expect(resolveGitCheckout(other.unrelatedRepo)).not.toBeNull();
			expect(resolveAnalysisRoot(other.unrelatedLink, fx.repo)).toBe("adopted");
			expect(resolveSessionConfigRoot(other.unrelatedLink, fx.repo)).toEqual({
				register: undefined,
				mode: "adopted",
			});
			const before = [...getSessionRootsForTelemetry(200)];
			await readCall(other.unrelatedLink, fx.repo, 4695);
			expect(getSessionRootsForTelemetry(200)).toEqual(before);
			expect(before).toEqual([fx.repo]);
			expect(isSessionRootRegistered(other.unrelatedRepo)).toBe(false);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	it("row 16 a linked worktree registers its nested config owner", async () => {
		// The loader layers upward from the registered root, so a worktree
		// registered at its top never reads `pkg/.pi-lens.json`: the nested owner
		// is registered for a worktree file exactly as for a session file.
		const checkoutRoot = path.join(
			env.tmpDir,
			"..",
			`capture-4689-nested-${process.pid}`,
		);
		try {
			const { repo, worktree } = writeLinkedWorktree(checkoutRoot);
			const nested = path.join(worktree, "pkg");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(nested, ".pi-lens.json"),
				JSON.stringify({ lsp: { disabledServers: ["typescript"] } }),
			);
			const file = path.join(nested, "a.ts");
			fs.writeFileSync(file, "export const a = 1;\n");
			runtime.projectRoot = repo;
			await initLSPConfig(repo);

			expect(resolveSessionConfigRoot(file, repo)).toEqual({
				register: nested,
				mode: "linked-worktree",
			});
			await readCall(file, repo, 4692);
			expect(isSessionRootRegistered(nested)).toBe(true);
			expect(disabledPrimaries(file).disabledServerIds).toContain("typescript");
		} finally {
			fs.rmSync(checkoutRoot, { recursive: true, force: true });
		}
	});

	it("row 14 linked worktree spelled through an alias registers the alias", async (ctx) => {
		// The worktree branch takes the same rule: the class resolves the owner
		// by identity, and the registration must hold the file as spelled. The
		// checkout sits beside the temp root for the reason the linked-worktree
		// cell above gives (#4560).
		const checkoutRoot = path.join(
			env.tmpDir,
			"..",
			`capture-4689-worktree-${process.pid}`,
		);
		try {
			const { repo, worktree } = writeLinkedWorktree(checkoutRoot);
			const worktreeAlias = path.join(checkoutRoot, "repo-wt-alias");
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(worktree, "src", "sibling.ts"),
				"export const value = 1;\n",
			);
			try {
				fs.symlinkSync("repo-wt", worktreeAlias, "dir");
			} catch (err) {
				return ctx.skip(`cannot create symlinks here: ${String(err)}`);
			}
			const file = path.join(worktreeAlias, "src", "sibling.ts");
			runtime.projectRoot = repo;
			await initLSPConfig(repo);

			expect(resolveSessionConfigRoot(file, repo)).toEqual({
				register: worktreeAlias,
				mode: "linked-worktree",
			});

			await readCall(file, repo, 4690);

			expect([...getSessionRootsForTelemetry(200)].sort()).toEqual(
				[repo, worktreeAlias].sort(),
			);
			const registry = registryFor(repo);
			expect(registry.fileIsOutsideRegisteredRoots(file)).toBe(false);
			expect(registry.analysisRootModeForFile(file)).toBe("linked-worktree");
		} finally {
			fs.rmSync(checkoutRoot, { recursive: true, force: true });
		}
	});
});

/**
 * The registration walk stops at every file the config loader layers, not
 * only at `.pi-lens.json`: the loader reads each `PROJECT_CONFIG_LOCATIONS`
 * entry in each directory upward from the registered root, so a root above a
 * directory that holds only a legacy LSP file never applies it.
 *
 * Recurrence: #4734 Greptile "Nested LSP settings disappear". The walk asked
 * `findPiLensConfigInDir`, which knows only the two pi-lens basenames, so
 * `pkg/pi-lsp.json` and `pkg/.pi-lens/lsp.json` stopped applying; master's
 * dirname registration started below them and read them.
 */
describe("the registration walk stops at every config location the loader reads", () => {
	it.for([
		{
			row: "legacy pi-lsp.json, TypeScript",
			config: "pi-lsp.json",
			body: { disabledServers: ["typescript"] },
			file: "a.ts",
			server: "typescript",
		},
		{
			row: "legacy .pi-lens/lsp.json, TypeScript",
			config: path.join(".pi-lens", "lsp.json"),
			body: { disabledServers: ["typescript"] },
			file: "a.ts",
			server: "typescript",
		},
		{
			// AGENTS.md shape 42: the rule is language-neutral, so a non-TypeScript
			// row (Greptile "Other languages lack a test").
			row: "canonical .pi-lens.json, Python",
			config: ".pi-lens.json",
			body: { lsp: { disabledServers: ["python"] } },
			file: "a.py",
			server: "python",
		},
	])("$row", async (cell) => {
		const repo = path.join(env.tmpDir, "repo");
		const pkg = path.join(repo, "pkg");
		fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
		fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
		fs.mkdirSync(path.dirname(path.join(pkg, cell.config)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(pkg, cell.config), JSON.stringify(cell.body));
		const file = path.join(pkg, "src", cell.file);
		fs.writeFileSync(file, "\n");
		runtime.projectRoot = repo;
		await initLSPConfig(repo);

		expect(resolveSessionConfigRoot(file, repo)).toEqual({
			register: pkg,
			mode: "session",
		});
		await readCall(file, repo, 4734);
		expect(isSessionRootRegistered(pkg)).toBe(true);
		expect(registryFor(repo).fileIsOutsideRegisteredRoots(file)).toBe(false);
		expect(disabledPrimaries(file).disabledServerIds).toContain(cell.server);
	});
});
