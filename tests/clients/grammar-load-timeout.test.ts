/**
 * #4224: a `Language.load` that never settles.
 *
 * `loadLanguage` awaited the loader with no bound, so a hung wasm load held
 * its caller for good, and `compileQueryBatch` kept that caller's build as the
 * in-flight record every later caller for the same rule set joined. The rule
 * set for that language then stayed stuck for the whole process. The loader is
 * bounded now: a timeout takes the existing `Language.load` failure path, so
 * the build settles, its record clears, and the grammar's cooldown stops each
 * later call from waiting out the bound again.
 *
 * web-tree-sitter gives `Language.load` no abort, so the abandoned load keeps
 * running and settles later. The late settle is observed, not dropped: an
 * Emscripten abort that arrives after the bound still kills the wasm runtime
 * and latches it (AGENTS.md shape 60), any other late failure leaves one
 * bounded record against the grammar, and a late success changes nothing.
 *
 * The loader is the only fake in the code under test. `loadLanguage`,
 * `compileQueryBatch`, the logger, the failure record and the cooldown are the
 * production code, the user notifier is the real seam wired to a recorder, and
 * the bound is the shared constant, so a bound that only looks right on a short
 * fake clock cannot pass. The cases that assert a log record read it back out
 * of the real `tree-sitter.log` rather than a spy on the logger: a spy replaces
 * the seam, so it proves what the client handed over, not what reached the sink.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_setGrammarManifestForTests,
	GRAMMAR_LOAD_TIMEOUT_MS,
} from "../../clients/grammar-source.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import * as treeSitterLogger from "../../clients/tree-sitter-logger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/** A valid wasm preamble under a real grammar filename: `resolveGrammarFile`
 * vouches for it, and the faked loader decides what happens next. */
const WASM_HEADER = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
/** The same preamble with a different length: the file a re-download leaves. */
const REPLACEMENT_WASM = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad,
]);
const GRAMMAR_FILE = "tree-sitter-python.wasm";

/** The shape `tree-sitter.log` holds, as read back from disk below. */
type SinkRow = {
	phase?: string;
	filePath?: string;
	status?: string;
	reason?: string;
	metadata?: Record<string, unknown>;
};

/** Every row `tree-sitter.log` holds right now. The sink binds its directory at
 * module load (`getGlobalPiLensLogDir`), so the path is read from the logger
 * itself: it is this worker's own `PI_LENS_HOME`, never the maintainer's. */
function readTreeSitterRows(): SinkRow[] {
	const file = treeSitterLogger.getTreeSitterLogPath();
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SinkRow);
}

/** Row count to compare a case's own writes against. The flush keeps a row a
 * previous case left queued from landing after the baseline is taken. */
async function treeSitterRowCount(): Promise<number> {
	await treeSitterLogger.flushTreeSitterLog();
	return readTreeSitterRows().length;
}

/** The rows the sink gained since `baseline`. The flush is the LAST await before
 * the read: a read that races the writer's own queue counts late bytes on the
 * wrong side of its window (AGENTS.md shape 67). */
async function treeSitterRowsSince(baseline: number): Promise<SinkRow[]> {
	await treeSitterLogger.flushTreeSitterLog();
	return readTreeSitterRows().slice(baseline);
}

/** The row `outcome` names, e.g. `load-failed` or `late-load-failed`. */
const rowWithOutcome = (
	rows: SinkRow[],
	outcome: string,
): SinkRow | undefined => rows.find((row) => row.metadata?.outcome === outcome);

type LoadClient = {
	loadLanguage(languageId: string): Promise<unknown>;
	resolveGrammarFile(file: string): string | undefined;
	compileQueryBatch(
		queryDefs: TreeSitterQuery[],
		languageId: string,
	): Promise<unknown>;
	queryBatchBuilds: Map<string, unknown>;
	grammarSourceDirs(): string[];
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
	ParserClass: unknown;
	LanguageLoader: { load: (path: string) => Promise<unknown> };
	languages: Map<string, unknown>;
	queryBatchCache: { size: number };
	wasmAborted: boolean;
	onWasmAbort: (() => void) | undefined;
};

const rule: TreeSitterQuery = {
	id: "r1",
	name: "r1",
	severity: "warning",
	category: "test",
	language: "python",
	message: "r1",
	query: "(function_definition) @fn",
	metavars: ["fn"],
	has_fix: false,
	filePath: "",
};

/** Loads that stay pending until teardown releases them. */
const stuckLoads: Array<() => void> = [];

/** A load that does not settle while the test runs: the shape #4224 reports.
 * Teardown settles whatever is left, so no promise outlives its test. */
const stuckLoad = (): Promise<unknown> =>
	new Promise((resolve) => {
		stuckLoads.push(() => resolve(undefined));
	});

/** A load the test settles by hand, after the bound has passed. Teardown
 * resolves whatever is left, so no promise outlives its test. */
function lateLoad(): {
	load: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	stuckLoads.push(() => resolve(undefined));
	return { load: () => promise, resolve, reject };
}

/** The error an Emscripten `abort()` throws out of the wasm runtime. */
const abortError = (): Error =>
	new Error("Aborted(native code called abort())");

/** A wasm runtime trap: the runtime lives on, and the grammar is charged. */
const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trapError = (): Error =>
	new WebAssembly.RuntimeError("memory access out of bounds");

/** A decode failure that is not abort-shaped, as a truncated download gives. */
const decodeError = (): Error =>
	new Error(
		"CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f @+0",
	);

describe("Language.load bound (#4224)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let notices: Array<{ message: string; level?: string }>;
	/** `PI_LENS_TEST_MODE` as the environment had it before a case opted in. */
	let priorTestMode: string | undefined;

	beforeEach(() => {
		priorTestMode = process.env.PI_LENS_TEST_MODE;
		resetDegradationLedger();
		notices = [];
		wireUserNotifier(() => (message, level) => {
			notices.push({ message, level });
		});
		// The fixture file's bytes are not the real grammar's, so an empty
		// manifest keeps the pinned-hash check from rejecting them.
		_setGrammarManifestForTests({
			package: "tree-sitter-wasms",
			version: "0.0.0-test",
			grammars: {},
		});
		env = setupTestEnvironment("pi-lens-grammar-load-timeout-");
		fs.writeFileSync(path.join(env.tmpDir, GRAMMAR_FILE), WASM_HEADER);
	});

	afterEach(() => {
		for (const release of stuckLoads.splice(0)) release();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (priorTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = priorTestMode;
		resetUserNotifier();
		_setGrammarManifestForTests(undefined);
		removeTempDirSync(env.tmpDir);
	});

	/** Let `logTreeSitter` run for real, so the record reaches the sink instead of
	 * being dropped by the vitest early return in `isTestMode()`. */
	function writeRealLog(): void {
		process.env.PI_LENS_TEST_MODE = "0";
	}

	async function makeClient(
		load: (path: string) => Promise<unknown>,
	): Promise<{ client: LoadClient; load: ReturnType<typeof vi.fn> }> {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as LoadClient;
		client.grammarsDir = env.tmpDir;
		vi.spyOn(client, "grammarSourceDirs").mockReturnValue([env.tmpDir]);
		vi.spyOn(client, "grammarsWriteDir").mockReturnValue(env.tmpDir);
		client.ParserClass = {};
		const loader = vi.fn(load);
		client.LanguageLoader = { load: loader };
		return { client, load: loader };
	}

	const waiting = Symbol("waiting");
	/** `waiting` while `pending` has not settled; its value once it has. A
	 * pending promise loses a race against an already-resolved one. */
	const peek = <T>(pending: Promise<T>): Promise<T | typeof waiting> =>
		Promise.race([pending, Promise.resolve(waiting)]);

	const grammarLedgerReason = (): string | undefined =>
		getDegradationSummary()
			.find((group) => group.kind === "grammar-blocked")
			?.latestReasons.find((entry) => entry.subject === GRAMMAR_FILE)?.reason;

	/** Events the ledger counted under `kind`. */
	const ledgerCount = (kind: string): number =>
		getDegradationSummary().find((group) => group.kind === kind)?.count ?? 0;

	/** Retained ledger entries under `kind` that name the python grammar. */
	const grammarEntries = (kind: string): string[] =>
		(
			getDegradationSummary().find((group) => group.kind === kind)
				?.latestReasons ?? []
		)
			.filter((entry) => entry.subject === GRAMMAR_FILE)
			.map((entry) => entry.reason);

	// Recurrence: master awaited the loader with no bound, so this call never
	// returned.
	it("returns null at the bound and records the timeout against the grammar", async () => {
		const { client } = await makeClient(stuckLoad);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS - 1);
		expect(await peek(pending)).toBe(waiting);

		await vi.advanceTimersByTimeAsync(1);
		expect(await peek(pending)).toBeNull();

		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		expect(grammarLedgerReason()).toContain("Language.load failed");
		expect(grammarLedgerReason()).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
	});

	// Recurrence: the issue's probe. The second caller joined the first
	// caller's build, and the record never cleared.
	it("settles every coalesced batch caller and clears the in-flight record", async () => {
		const { client, load } = await makeClient(stuckLoad);
		vi.useFakeTimers();

		const first = client.compileQueryBatch([rule], "python");
		const second = client.compileQueryBatch([rule], "python");
		await Promise.resolve();
		expect(client.queryBatchBuilds.size).toBe(1);

		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(first)).toBeNull();
		expect(await peek(second)).toBeNull();
		expect(client.queryBatchBuilds.size).toBe(0);
		expect(load).toHaveBeenCalledTimes(1);
	});

	// Recurrence: a caller after the timeout must get its own answer rather
	// than join the abandoned build, and must not wait out the bound again.
	it("answers a later batch call at once, without re-entering the stuck loader", async () => {
		const { client, load } = await makeClient(stuckLoad);
		// The failed load un-vouches the file, so the next demand asks to re-fetch
		// it; inside the cooldown that must not reach the network.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("unexpected network call");
		});
		vi.useFakeTimers();
		const stuck = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(stuck)).toBeNull();

		// No clock advance: a zero-length tick only lets the microtasks run.
		const later = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(later)).toBeNull();
		expect(client.queryBatchBuilds.size).toBe(0);
		expect(load).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(notices).toHaveLength(1);
	});

	// Done when (#4224): a later call can retry. The timeout stops vouching for
	// the file, as any failed load does, so the retry waits for the file's
	// re-download and then loads it.
	it("lets a later call load the language once the grammar file is replaced", async () => {
		const { client } = await makeClient(stuckLoad);
		vi.useFakeTimers();
		const timedOut = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(timedOut)).toBeNull();
		expect(client.resolveGrammarFile(GRAMMAR_FILE)).toBeUndefined();

		fs.writeFileSync(path.join(env.tmpDir, GRAMMAR_FILE), REPLACEMENT_WASM);
		const language = { name: "python" };
		client.LanguageLoader = { load: vi.fn().mockResolvedValue(language) };

		expect(await client.loadLanguage("python")).toBe(language);
	});

	// Control: the bound must not fire early. A load that settles on the last
	// tick before it is a healthy load, not a failure.
	it("leaves a load that settles inside the bound alone", async () => {
		const language = { name: "python" };
		const { client } = await makeClient(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve(language), GRAMMAR_LOAD_TIMEOUT_MS - 1),
				),
		);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS - 1);

		expect(await peek(pending)).toBe(language);
		expect(
			getDegradationSummary().find((g) => g.kind === "grammar-blocked"),
		).toBeUndefined();
		expect(notices).toEqual([]);
	});

	// Recurrence: the abandoned load keeps running, and `withDeadline` handed its
	// late rejection to a silent catch. An Emscripten abort that lands after the
	// bound therefore never reached the runtime-death latch, and the ledger kept
	// the timeout as the only record.
	it("latches the wasm runtime when the abandoned load aborts after the bound", async () => {
		const late = lateLoad();
		const { client } = await makeClient(late.load);
		const onWasmAbort = vi.fn();
		client.onWasmAbort = onWasmAbort;
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(pending)).toBeNull();
		// At the bound it is a timeout and nothing more.
		expect(client.wasmAborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		late.reject(abortError());
		await vi.advanceTimersByTimeAsync(0);

		expect(client.wasmAborted).toBe(true);
		expect(onWasmAbort).toHaveBeenCalledTimes(1);
		expect(ledgerCount("wasm-abort")).toBe(1);
		expect(
			getDegradationSummary()
				.find((group) => group.kind === "wasm-abort")
				?.latestReasons.map((entry) => entry.reason),
		).toEqual(["Aborted(native code called abort())"]);
		// The timeout's own record stays; the abort adds to it, it does not replace it.
		expect(ledgerCount("grammar-blocked")).toBe(1);
	});

	// Control: the late-settle watch must not turn a late success into state.
	// The caller already got null and the grammar is on its cooldown, so the
	// language reaches neither `languages` nor the batch cache, and nothing is
	// recorded for a load that worked.
	it("ignores a load that succeeds after the bound", async () => {
		const late = lateLoad();
		const { client } = await makeClient(late.load);
		vi.useFakeTimers();

		const batch = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(batch)).toBeNull();
		const ledgerAtBound = JSON.stringify(getDegradationSummary());

		late.resolve({ name: "python" });
		await vi.advanceTimersByTimeAsync(0);

		expect(client.languages.has("python")).toBe(false);
		expect(client.queryBatchCache.size).toBe(0);
		expect(JSON.stringify(getDegradationSummary())).toBe(ledgerAtBound);
		expect(notices).toHaveLength(1);
		expect(await client.loadLanguage("python")).toBeNull();
	});

	// A late failure that is not an abort says something the timeout did not:
	// the load did not hang for ever, it failed. It gets one bounded record
	// naming the grammar and the failure, and nothing else: the user was told at
	// the bound, and the cooldown ladder is not climbed twice for one load.
	it("records a late decode failure once against the grammar, without a second notice", async () => {
		const late = lateLoad();
		const { client } = await makeClient(late.load);
		writeRealLog();
		const baseline = await treeSitterRowCount();
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(pending)).toBeNull();
		expect(ledgerCount("grammar-blocked")).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);
		late.reject(decodeError());
		await vi.advanceTimersByTimeAsync(0);

		// The real sink names the late failure for whoever reads tree-sitter.log.
		const lateLogged = (await treeSitterRowsSince(baseline)).filter(
			(row) => row.metadata?.outcome === "late-load-failed",
		);
		expect(lateLogged).toHaveLength(1);
		expect(lateLogged[0]?.reason).toContain("settled after its");
		expect(lateLogged[0]?.reason).toContain("expected magic word");
		expect(lateLogged[0]?.metadata).toMatchObject({
			grammarFile: GRAMMAR_FILE,
		});
		expect(client.wasmAborted).toBe(false);
		expect(ledgerCount("wasm-abort")).toBe(0);
		// Two events, one retained slot for the grammar: bounded.
		expect(ledgerCount("grammar-blocked")).toBe(2);
		expect(grammarEntries("grammar-blocked")).toHaveLength(1);
		expect(grammarLedgerReason()).toContain("expected magic word");
		expect(grammarLedgerReason()).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
		expect(notices).toHaveLength(1);
	});

	// A trap inside the grammar's own module is charged to the grammar and not
	// to the runtime's trap budget (#3605). A late trap is the same trap.
	it("charges a late wasm trap to the grammar, not to the runtime", async () => {
		const late = lateLoad();
		const { client } = await makeClient(late.load);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(pending)).toBeNull();

		late.reject(trapError());
		await vi.advanceTimersByTimeAsync(0);

		expect(client.wasmAborted).toBe(false);
		expect(ledgerCount("wasm-trap")).toBe(0);
		expect(ledgerCount("grammar-blocked")).toBe(2);
	});

	// One record per load that settles late, not one per caller. Two callers
	// join one build, the build starts one load, so one late settle is one
	// record however many callers were waiting on it.
	it("records one late settle once however many callers waited on the build", async () => {
		const late = lateLoad();
		const { client, load } = await makeClient(late.load);
		vi.useFakeTimers();

		const first = client.compileQueryBatch([rule], "python");
		const second = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(first)).toBeNull();
		expect(await peek(second)).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
		expect(ledgerCount("grammar-blocked")).toBe(1);

		late.reject(decodeError());
		await vi.advanceTimersByTimeAsync(0);

		// The timeout and the late failure: two events, not three.
		expect(ledgerCount("grammar-blocked")).toBe(2);
		expect(grammarEntries("grammar-blocked")).toHaveLength(1);
	});

	// Control: a load that fails inside the bound is already handled by the
	// failure path. It is not an abandoned load, so there is nothing late to
	// watch and it must not be recorded a second time.
	it("does not watch a load that fails inside the bound", async () => {
		const { client } = await makeClient(
			() =>
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(decodeError()), GRAMMAR_LOAD_TIMEOUT_MS - 1),
				),
		);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS - 1);
		expect(await peek(pending)).toBeNull();
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);

		expect(ledgerCount("grammar-blocked")).toBe(1);
		expect(notices).toHaveLength(1);
	});

	// F2: the failure log and the user notice named a truncated download and
	// sent the user to build scripts and the network. A load that hangs on a
	// file already on disk is neither.
	it("words the timeout as a local hang, not a truncated download", async () => {
		const { client } = await makeClient(stuckLoad);
		writeRealLog();
		const baseline = await treeSitterRowCount();
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(pending)).toBeNull();

		// Both rows are read out of the real sink: the diagnosis a bug report
		// greps for lives there, not in anything the client handed to a spy.
		const records = await treeSitterRowsSince(baseline);
		const loadFailed = rowWithOutcome(records, "load-failed");
		const unavailable = rowWithOutcome(records, "unavailable");
		expect(loadFailed?.reason).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
		expect(loadFailed?.reason).toContain("hang in the local load");
		expect(loadFailed?.reason).not.toContain(
			"most likely a truncated download",
		);
		expect(loadFailed?.metadata).toMatchObject({ grammarFile: GRAMMAR_FILE });
		expect(unavailable?.metadata).toMatchObject({ cause: "load-timed-out" });
		expect(unavailable?.reason).toContain("local hang");
		// The remedy names what to attach; the notice already names the grammar it
		// is about, so it does not ask for the name a second time.
		expect(unavailable?.reason).toContain("attach the tree-sitter log");
		expect(unavailable?.reason).not.toContain("this grammar name");
		expect(notices[0]?.message).toContain("local hang");
		expect(notices[0]?.message).not.toMatch(
			/approve-builds|trustedDependencies|network/,
		);
		// The ledger is what a bug report shows, so it must not say "download" either.
		expect(grammarLedgerReason()).toContain("grammar load timed out");
		expect(grammarLedgerReason()).not.toContain("download");
	});

	// Control: only a timeout takes the new wording. A load that fails inside
	// the bound is the #1564 shape, and keeps its own message and remedy.
	it("keeps the truncated-download wording for a load that fails inside the bound", async () => {
		const { client } = await makeClient(() => Promise.reject(decodeError()));
		writeRealLog();
		const baseline = await treeSitterRowCount();
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(pending)).toBeNull();

		const records = await treeSitterRowsSince(baseline);
		const loadFailed = rowWithOutcome(records, "load-failed");
		const unavailable = rowWithOutcome(records, "unavailable");
		expect(loadFailed?.reason).toContain("most likely a truncated download");
		expect(unavailable?.metadata).not.toHaveProperty("cause");
		expect(notices[0]?.message).toContain("approve-builds");
		expect(grammarLedgerReason()).toContain("runtime grammar download failed");
	});

	// The watch's own handler runs where no caller can catch a throw. A late
	// abort reaches the host's `onWasmAbort`, and a host callback that throws
	// rejects the promise `.then` returns, which nothing holds. Under Node's
	// default `--unhandled-rejections=throw` that ends the process, a worse
	// outcome than the latch the watch exists to reach. On time the same throw
	// goes to the caller of `loadLanguage`; late it has no caller, so it is
	// logged, not swallowed. The record is read out of the real `tree-sitter.log`,
	// like the other log cases here: a spy would only prove what the client handed
	// to the logger.
	it("logs a throw from the late-abort latch rather than leaving an unhandled rejection", async () => {
		const late = lateLoad();
		const { client } = await makeClient(late.load);
		const onWasmAbort = vi.fn(() => {
			throw new Error("host callback failed");
		});
		client.onWasmAbort = onWasmAbort;
		writeRealLog();
		const baseline = await treeSitterRowCount();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		vi.useFakeTimers();
		try {
			const pending = client.loadLanguage("python");
			await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
			expect(await peek(pending)).toBeNull();

			late.reject(abortError());
			await vi.advanceTimersByTimeAsync(0);
			// The throw must have happened for the guard to mean anything: a
			// callback that never ran would pass the checks below vacuously.
			expect(onWasmAbort).toHaveBeenCalledTimes(1);

			// Node delivers `unhandledRejection` on a real macrotask; fake timers
			// never fire it, so drain one real tick.
			vi.useRealTimers();
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled.map(String)).toEqual([]);
		const handlerFailed = (await treeSitterRowsSince(baseline)).filter(
			(row) => row.metadata?.outcome === "late-load-handler-failed",
		);
		expect(handlerFailed).toHaveLength(1);
		expect(handlerFailed[0]?.status).toBe("warn");
		expect(handlerFailed[0]?.reason).toContain("host callback failed");
		expect(handlerFailed[0]?.reason).toContain(GRAMMAR_FILE);
		expect(handlerFailed[0]?.metadata).toMatchObject({
			grammarFile: GRAMMAR_FILE,
		});
		// The latch was set before the callback ran, so the throw cost it nothing.
		expect(client.wasmAborted).toBe(true);
	});
});
