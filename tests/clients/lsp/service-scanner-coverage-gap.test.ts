/**
 * #1459 — a cascade sweep must not drive a scanner into the notify-write
 * breaker, and a scanner's silence must never read as a clean verdict.
 *
 * Before this fix a `clientScope: "all"` sweep fanned a full-text `didOpen`
 * resync at opengrep for every neighbour inside a few milliseconds. Its stdin
 * stopped draining, three per-server write deadlines expired, and the #743
 * breaker opened for 15 s. Every touch inside that window then skipped the
 * scanner and still resolved `confirmation: "confirmed"` — a security blackout
 * that read as scanned-clean.
 *
 * These tests verify:
 *  1. A burst of concurrent resyncs at an auxiliary issues ONE write (the rest
 *     defer), so the breaker never trips, and the deferred touches report the
 *     scanner as uncovered.
 *  2. A write that lands after its deadline retracts the timeout it was charged
 *     for — slow is not broken.
 *  3. A write nothing accepts for the whole wedge window still demotes the
 *     server, so the gate cannot defer a dead input path forever.
 *  4. A touch that skipped a scanner because its breaker was open resolves
 *     `"partial"` and names the scanner, not `"confirmed"`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const ROOT = "C:/repo";
const NOTIFY_BUDGET_MS = 100;
const AUX_KEY_PREFIX = `opengrep:${normalizeMapKey(ROOT)}`;

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

function makeServer(id: string, role?: "auxiliary") {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role !== undefined && { role }),
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	};
}

/**
 * A fake client. `writeMs` is how long its `didOpen` takes to be accepted:
 * `undefined` means it never lands (a wedged stdin), 0 means immediately.
 *
 * `publishes` models the diagnostics wait. `"never"` is the production profile
 * for a scanner that was not sent this content: its version cannot advance, so a
 * wait on it can only expire. A test that resolves this instantly would let the
 * touch reach `"partial"` on a timing profile production never has.
 *
 * #1533: `"immediately"` must ALSO advance `diagnosticsVersion`, because that is
 * what a real client's early resolve MEANS — the wait settles when a publication
 * lands (client.ts). A double that resolved without the bump modelled a client
 * production does not have, and the `"all"`-scope evidence check reads it as a
 * silent scanner (shape 7: the fixture, not the code, decided the verdict).
 * `diagnosticsVersion` is therefore a GETTER; a caller that spreads this object
 * (`{...makeClient(...)}`) freezes the value at spread time and must not rely on
 * later bumps.
 */
function makeClient(
	serverId: string,
	writeMs: number | undefined,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	publishes: "immediately" | "never" = "immediately",
) {
	// Concurrency instrumentation. Call COUNT cannot see the defect the gate
	// exists to prevent: N writes issued back-to-back and N issued simultaneously
	// are the same count. `maxInFlight` is the invariant — one outstanding resync
	// per auxiliary — and `openOffsets` shows the flood shape when it breaks.
	const startedAt = Date.now();
	let inFlight = 0;
	let version = 0;
	const stats = { maxInFlight: 0, openOffsets: [] as number[] };
	const stampsByPath = new Map<string, number>();
	return {
		stats,
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		// #1531: production decides freshness and aux evidence from the PER-PATH
		// publication stamp, not the client-global counter, so the double answers on
		// that axis too — an accessor-less double would silently exercise only the
		// fail-closed branch and never the real read.
		//
		// #1533 merge: the `"never"` profile still stamps nothing, so every read is an
		// honest 0 and its silence is modelled rather than inferred. The
		// `"immediately"` profile DOES stamp the path it published for, because that is
		// what an early-resolving wait means for a notified push-only auxiliary — and
		// the per-path stamp is now the axis the evidence check reads, so stamping only
		// the global counter would leave a publishing scanner looking silent.
		stampsByPath,
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => diags),
		notify: {
			open: vi.fn(() => {
				inFlight += 1;
				stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
				stats.openOffsets.push(Date.now() - startedAt);
				return new Promise<void>((resolve) => {
					if (writeMs === undefined) return;
					setTimeout(() => {
						inFlight -= 1;
						resolve();
					}, writeMs);
				});
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		// A real client resolves this on its OWN timeout and never rejects, so the
		// silent profile must resolve at `timeoutMs` WITHOUT advancing
		// `diagnosticsVersion` — a promise that never settles would model a client
		// production does not have.
		waitForDiagnostics: vi.fn(
			(filePath: string, timeoutMs?: number) =>
				new Promise<void>((resolve) => {
					if (publishes === "never") setTimeout(resolve, timeoutMs ?? 1000);
					else {
						// A publication landing is what resolves a real wait early. Stamp
						// BOTH axes exactly as `client.ts` does: the global counter advances
						// and the per-path stamp records that counter's value for this file
						// (#1531). Bumping only the global counter would leave the evidence
						// check — which reads per-path — seeing a silent scanner.
						version += 1;
						stampsByPath.set(filePath, version);
						resolve();
					}
				}),
		),
	};
}

function phases(): string[] {
	return logLatency.mock.calls.map(([entry]) => entry?.phase);
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

function brokenKeys(service: unknown): string[] {
	return [
		...(
			service as { state: { broken: Map<string, number> } }
		).state.broken.keys(),
	];
}

function streakKeys(service: unknown): string[] {
	return [
		...(
			service as { notifyWriteBackpressureStreak: Map<string, number> }
		).notifyWriteBackpressureStreak.keys(),
	];
}

async function touchAll(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<unknown>;
	},
	files: string[],
) {
	return Promise.all(
		files.map((file) =>
			service.touchFile(file, `content of ${file}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			}),
		),
	);
}

describe("#1459 — sweep fan-out must not black out a scanner silently", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("a burst of resyncs issues one write, defers the rest, and never trips the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner is slow (3x the write budget) but healthy — its write lands.
		// It never publishes for the files it was not sent, which is what makes the
		// "deferred servers are not waited on" half of the fix load-bearing: a wait
		// on this client could only expire, flipping the touch to `inconclusive`.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3, [], "never");
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => `${ROOT}/${f}`);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			| {
					diags: unknown[];
					confirmation?: string;
					inconclusive?: boolean;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		// The gate let exactly one resync through; the other three deferred.
		expect(aux.notify.open).toHaveBeenCalledTimes(1);
		expect(aux.stats.maxInFlight).toBe(1);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(3);

		// The breaker never opened, and no streak survived the late landing.
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
		expect(streakKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);

		// Every deferred touch says so: the scanner never saw that content.
		const deferred = results.filter((r) =>
			r?.unconfirmedServerIds?.includes("opengrep"),
		);
		expect(deferred).toHaveLength(3);
		for (const result of deferred) {
			// Narrowed, not collapsed: the primary's answer stands, and the deferred
			// scanner is not waited on, so nothing flips the touch to inconclusive.
			expect(result?.confirmation).toBe("partial");
			expect(result?.inconclusive).toBeUndefined();
			expect(result?.diags).toHaveLength(1);
		}
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(3);
		expect(gapRows[0]?.metadata).toMatchObject({
			deferredResyncServerIds: ["opengrep"],
			source: "cascade",
		});
	});

	it("a write that lands after its deadline retracts the timeout it was charged for", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		// Three sequential slow-but-landing writes. Pre-#1459 each one charged a
		// timeout and the third opened the breaker.
		for (const content of ["one", "two", "three"]) {
			const pending = service.touchFile(`${ROOT}/a.ts`, content, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 10);
			await pending;
		}

		expect(aux.notify.open).toHaveBeenCalledTimes(3);
		expect(rowsFor("lsp_notify_write_late_landed")).toHaveLength(3);
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
	});

	it("a write nothing accepts for the wedge window still demotes the server", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Wedged: the write never lands.
		const aux = makeClient("opengrep", undefined);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		const first = service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 8);
		await first;

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS);
		await second;

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(
			(demotions[0]?.metadata as { outstandingMs?: number } | undefined)
				?.outstandingMs,
		).toBeGreaterThanOrEqual(NOTIFY_BUDGET_MS * 5);
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	});

	it("a scanner skipped for an open breaker makes the touch partial, not confirmed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(primary);

		// The scanner is mid-cooldown, exactly as a #743 demotion leaves it.
		(
			service as unknown as { state: { broken: Map<string, number> } }
		).state.broken.set(AUX_KEY_PREFIX, Date.now() + 15_000);

		const pending = service.touchFile(`${ROOT}/a.ts`, "content", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 20);
		const result = (await pending) as
			| { confirmation?: string; unconfirmedServerIds?: string[] }
			| undefined;

		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(1);
		expect(gapRows[0]?.metadata).toMatchObject({
			brokenSkippedServerIds: ["opengrep"],
		});
	});

	// #1533 makes the "still confirmed" half load-bearing on this scope too: `"all"`
	// now derives auxiliary coverage evidence from post-wait state, so a scanner that
	// publishes for every file must keep every touch unqualified. This is the
	// overcorrection guard for the aggregate path.
	//
	// The load-bearing concurrency assertion, and the negative control in one.
	// The gate is a QUEUE, not a drop: a healthy scanner accepts each write in
	// milliseconds, so all SIX concurrent touches still get scanned and every touch
	// still claims full confirmation — but they go through ONE AT A TIME.
	//
	// Call count alone cannot see the defect: a version of the gate that checked
	// the slot and then let each caller insert its own record after an `await`
	// passed a count assertion while measuring maxInFlight 5 (one write, then a
	// five-wide flood one budget later) — #1459's own root cause rebuilt inside the
	// fix. `writeMs` must be NONZERO for the probe to have anything to overlap.
	it("a healthy scanner gets every file, one resync at a time, still confirmed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", 10);
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map(
			(f) => `${ROOT}/${f}`,
		);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			{ confirmation?: string; unconfirmedServerIds?: string[] } | undefined
		>;

		expect(aux.stats.maxInFlight).toBe(1);
		expect(aux.notify.open).toHaveBeenCalledTimes(6);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(0);
		expect(rowsFor("lsp_scanner_coverage_gap")).toHaveLength(0);
		for (const result of results) {
			expect(result?.confirmation).toBe("confirmed");
			expect(result?.unconfirmedServerIds).toBeUndefined();
		}
	});

	it("a wedged scanner is demoted by its own write's wedge timer, without a later touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Wedged: the write never lands, and NOTHING touches this server again.
		const aux = makeClient("opengrep", undefined);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		const pending = service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await pending;

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	});

	it("a queued resync never waits longer than the caller's own budget", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner holds its write far past any budget, so the second touch can
		// only queue — and its caller allowed a total of a THIRD of the write budget.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 50, [], "never");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(1);

		const callerCapMs = Math.floor(NOTIFY_BUDGET_MS / 3);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
			maxClientWaitMs: callerCapMs,
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		const deferrals = rowsFor("lsp_notify_resync_deferred");
		expect(deferrals).toHaveLength(1);
		const row = deferrals[0] as { metadata?: Record<string, unknown> };
		// The queue wait was capped by the caller's own budget, not by the flat
		// write budget — a caller that asked for less must not be taxed more.
		expect(row.metadata?.queueWaitMs).toBeLessThanOrEqual(callerCapMs);
		// And the queued touch never pushed a second, overlapping resync.
		expect(aux.stats.openOffsets).toHaveLength(1);
	});

	it("a queued touch does not write to a client that was evicted while it waited", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The holder's write settles INSIDE the queue budget, so the waiter really
		// reaches the claim — a write that outlasts the budget would make the waiter
		// time out first and never exercise the guard at all (shape 7).
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS / 2, [], "never");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(aux.notify.open).toHaveBeenCalledTimes(1);

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		// Evict the client while the second touch is queued behind its write. An
		// eviction DELETES the registry entry, which is exactly the shape a guard
		// that exempted "no entry" waved through: the waiter would take the freed
		// slot, write to the corpse, and `markTouched` would record this content as
		// delivered (#1253 laundering).
		await vi.advanceTimersByTimeAsync(1);
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.delete(AUX_KEY_PREFIX);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		// No second write, and the retired generation earned no debounce entry.
		expect(aux.notify.open).toHaveBeenCalledTimes(1);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
		const touched = (
			service as unknown as { recentTouches: Map<string, unknown> }
		).recentTouches;
		expect([...touched.keys()].some((k) => k.includes("b.ts"))).toBe(false);
	});

	it("a deferred auxiliary records a `deferred` aux-wait outcome, never `silent`", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The with-auxiliary path, i.e. the `waitShape: "aux_grace"` producer. Since
		// #1533 the `"all"` scope emits `lsp_aux_wait_outcome` too, so this probe pins
		// the grace producer specifically; the aggregate producer's deferral row is
		// pinned by its own test below.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 50, [], "never");
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "opengrep" ? aux : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const first = service.touchFile(`${ROOT}/a.ts`, "one", touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await Promise.all([first, second]);

		const outcomes = rowsFor("lsp_aux_wait_outcome").flatMap(
			(row) =>
				(row.metadata as { outcomes?: Array<{ serverId: string; outcome: string }> })
					?.outcomes ?? [],
		);
		const opengrepOutcomes = outcomes
			.filter((entry) => entry.serverId === "opengrep")
			.map((entry) => entry.outcome);
		// #1493 boundary: `silent` stays reserved for a scanner that HAD the content
		// and published nothing. A deferral must never be recorded there.
		expect(opengrepOutcomes).toContain("deferred");
		expect(opengrepOutcomes).not.toContain("silent");
	});

	it("a deferred scanner's stale findings are not merged as this touch's answer", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner still holds the PREVIOUS content's finding: the resync that
		// would have cleared its cache is the one the gate deferred.
		const aux = makeClient(
			"opengrep",
			NOTIFY_BUDGET_MS * 3,
			[makeDiagnostic("stale scanner finding")],
			"never",
		);
		const primary = makeClient("typescript", 0);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts"].map((f) => `${ROOT}/${f}`);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			| {
					diags: unknown[];
					confirmation?: string;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		const deferred = results.find((r) =>
			r?.unconfirmedServerIds?.includes("opengrep"),
		);
		expect(deferred).toBeDefined();
		expect(deferred?.diags).toEqual([]);
	});

	// #1493 integration: the content-hash exemption outranks the deferral. A
	// scanner that already published for EXACTLY these bytes has reported on this
	// file, so the gate skipping its resync withholds nothing — and its stored
	// findings must still reach the result. Fail this and the merge either
	// overclaims (drops findings while saying "confirmed") or underclaims (reports
	// a gap for a file the scanner demonstrably covered).
	it("a deferred scanner that already published these exact bytes stays covered", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } = await import(
			"../../../clients/lsp/diagnostic-binding.js"
		);
		const service = new LSPService();

		const storedFinding = makeDiagnostic("stored scanner finding");
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3, [], "never");
		// Its stored publication is bound to the SECOND file's exact content.
		const auxWithBinding = {
			...aux,
			getDiagnostics: vi.fn((filePath: string) =>
				filePath.endsWith("b.ts") ? [storedFinding] : [],
			),
			getDiagnosticBinding: vi.fn((filePath: string) =>
				filePath.endsWith("b.ts")
					? { contentHash: hashDiagnosticContent("two"), boundToCurrentDisk: true }
					: undefined,
			),
		};
		const primary = makeClient("typescript", 0);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "opengrep" ? auxWithBinding : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const first = service.touchFile(`${ROOT}/a.ts`, "one", touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const [, result] = (await Promise.all([first, second])) as Array<
			| {
					diags: Array<{ message: string }>;
					confirmation?: string;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		// Deferred, so the resync never went out …
		expect(rowsFor("lsp_notify_resync_deferred")).not.toHaveLength(0);
		// … but the scanner had already spoken for these bytes, so no gap …
		expect(result?.unconfirmedServerIds ?? []).not.toContain("opengrep");
		expect(result?.confirmation).toBe("confirmed");
		// … and its stored findings still reach the caller.
		expect(result?.diags.map((d) => d.message)).toContain(
			"stored scanner finding",
		);
	});
});
