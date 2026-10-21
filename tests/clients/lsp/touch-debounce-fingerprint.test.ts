/**
 * #3480: the touch debounce must tell two long documents apart when they
 * differ only in the middle.
 *
 * Recurrence this file prevents: `shouldSkipNotify` compared a length + first
 * 48 + last 48 chars fingerprint, so a same-length middle edit of a >96-char
 * file inside the 1500 ms debounce window was skipped with nothing recorded,
 * and the server kept answering from the previous content.
 *
 * Production chain: the REAL `LSPService.touchFile` -> the REAL
 * `handleNotifyOpen` notify queue -> a mock `MessageConnection` (the process
 * boundary). Only the server registry and client construction are doubled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fc from "fast-check";
import path from "node:path";
import * as clientModule from "../../../clients/lsp/client.js";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { fingerprintDocumentContent } from "../../../clients/lsp/document-drift.js";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL } from "../../../clients/lsp/sync-kind.js";
import { flushAllNdjsonWriters } from "../../../clients/ndjson-logger.js";
import { getGlobalPiLensLogDir } from "../../../clients/probe-home-state.js";
import { waitFor } from "../interleaving-kit.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
// #3480 round 1: count the fingerprints `touchFile` computes. Wrapped, not
// replaced: every other export is the real module.
vi.mock("../../../clients/lsp/document-drift.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/lsp/document-drift.js")
		>();
	return {
		...actual,
		fingerprintDocumentContent: vi.fn(actual.fingerprintDocumentContent),
	};
});
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ROOT = "/repo";
const FILE = "/repo/long.ts";
const HEAD = `// ${"h".repeat(60)}\n`;
const TAIL = `// ${"t".repeat(60)}\n`;
const A = `${HEAD}const x = 1;\n${TAIL}`;
const B = `${HEAD}const x = 2;\n${TAIL}`;

/**
 * One event-loop tick. The notify queue advances on this loop's microtask
 * chain once a held send is released, which is the safe custom yield
 * `tests/clients/interleaving-kit.ts` documents for `waitFor` (never a worker
 * or child process, which `setImmediate` cannot observe).
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wait for a path's notify queue to drain through its promise chain. */
const queueDrained = (state: ReturnType<typeof createMockState>) =>
	waitFor(
		() => state.notifyChangeQueues.size,
		(size) => size === 0,
		{ timeoutMs: 2_000, yieldControl: tick },
	);

/**
 * The DURABLE half of a degradation record (#4532 gap 9 round 6 F4). The ledger
 * writes through `logLatency`, so the row reaches `latency.log` only after a
 * flush: reading the sink while one of its writes is queued counts late bytes
 * on the wrong side of the window (shape 67).
 */
async function durableDegradations(): Promise<string[]> {
	await flushAllNdjsonWriters();
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line) as {
					metadata?: { kind?: unknown; subject?: unknown };
				};
				const kind = row.metadata?.kind;
				const subject = row.metadata?.subject;
				return typeof kind === "string" && typeof subject === "string"
					? [`${subject}:${kind}`]
					: [];
			} catch {
				return [];
			}
		});
}

/**
 * `reportRecord: false` builds the client shape #4532 gap 9 F3 is about: one
 * that cannot say what it holds. `reportQueue: false` is the other unanswerable
 * question — a record but no word on whether a send for the path is still to
 * come. Production has neither, so a double is the only way to reach either
 * branch, and the gate must fail CLOSED on both.
 */
async function setup(
	options: {
		reportRecord?: boolean;
		reportQueue?: boolean;
		serverId?: string;
	} = {},
) {
	const serverId = options.serverId ?? "typescript";
	const state = createMockState({ root: ROOT, serverId });
	// The server declared `save`, so a standalone `notify.save` reaches the wire
	// and the save mark means something (#3405).
	state.saveOptions = { includeText: false };
	const client = {
		serverId,
		root: ROOT,
		customServer: false,
		isAlive: () => true,
		wasShutdownIntentional: () => true,
		getExitedAt: () => undefined,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getSaveOptions: () => ({ includeText: false }),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		// #4532: the real readers over this double's real state, so the gate's
		// evidence is the queue and record the fixture actually drives. Omitting
		// both is the F3 shape: a client that cannot report a record.
		...(options.reportRecord === false
			? {}
			: {
					getSentContent: (filePath: string) => {
						// Use the client's own reader over the fixture's real state.
						return clientModule.sentContentFor(state, filePath);
					},
				}),
		...(options.reportQueue === false
			? {}
			: {
					hasNotifyInFlight: (filePath: string) =>
						clientModule.hasNotifyInFlightFor(state, filePath),
				}),
		notify: {
			announceCreated: () => undefined,
			save: (filePath: string, onlyIfOwed?: boolean) =>
				clientModule.handleNotifySave(state, filePath, onlyIfOwed),
			open: (
				filePath: string,
				content: string,
				languageId: string,
				preserveDiagnostics?: boolean,
				silent?: boolean,
				saved?: boolean,
			) =>
				clientModule.handleNotifyOpen(
					state,
					filePath,
					content,
					languageId,
					preserveDiagnostics,
					silent,
					saved,
				),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(async () => {}),
	};
	getServersForFileWithConfig.mockReturnValue([
		{
			id: serverId,
			name: "typescript",
			extensions: [".ts"],
			idleEviction: "resident",
			root: async () => ROOT,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
	createLSPClient.mockResolvedValue(client);
	const service = new LSPService();
	const texts = () =>
		vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter(([method]) =>
				/^textDocument\/(didOpen|didChange)$/.test(String(method)),
			)
			.map(([method, params]) => {
				const p = params as {
					textDocument?: { text?: string };
					contentChanges?: Array<{ text: string }>;
				};
				return `${String(method).replace("textDocument/", "")}:${
					p.textDocument?.text ?? p.contentChanges?.at(-1)?.text
				}`;
			});
	return { service, texts, state, client };
}

describe("#3480 — touch debounce fingerprint covers the whole document", () => {
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a same-length middle edit of a long file inside the debounce window", async () => {
		expect(B.length).toBe(A.length);
		expect(A.length).toBeGreaterThan(96);
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${B}`]);
	});

	// #3480 round 1 N1: one whole-content hash per touch, not one per debounce
	// check and per mark (each a sha256 of up to the whole file).
	it("fingerprints the content once per touch", async () => {
		const { service } = await setup();
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		const fingerprint = vi.mocked(fingerprintDocumentContent);
		fingerprint.mockClear();

		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(fingerprint.mock.calls.filter(([c]) => c === B)).toHaveLength(1);
	});

	it("still skips a repeat touch of identical long content inside the window", async () => {
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`]);
	});

	// #4532 gap 9 F3: a client that cannot report its record has an UNKNOWN
	// final state, and the pre-#4532 window gate that used to decide for it is
	// the one `GateWindowReopen` proves can leave a server holding no document
	// at all (`formal/lsp-server-content`). So it pushes, every time.
	it("always pushes a client that cannot report the record it holds", async () => {
		const { service, texts } = await setup({ reportRecord: false });

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${A}`]);
	});

	// The queue half of the same rule: a record answers what LANDED, and an
	// unknown queue is unknown finality, so it cannot license a skip either.
	it("pushes when a client can report its record but not its queue", async () => {
		const { service, texts } = await setup({ reportQueue: false });

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${A}`]);
	});
});

/**
 * #4532 gap 9 F1: the record reports what LANDED. A send of other bytes that
 * the path's queue is still writing lands after a skip, so the server ends on
 * bytes the touch never named — off disk, until the next drift sweep.
 *
 * A real stdio wire cannot be paused, so the transport here is the mock
 * connection (a process boundary) and everything above it is real: the real
 * `LSPService.touchFile`, the real per-document queue, the real notify path.
 * The hold makes "in flight" a fact at the instant the gate reads it, which no
 * socket-based case can promise.
 */
describe("#4532 gap 9 — a skip needs the path's notify queue idle", () => {
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("pushes a touch while a send of other bytes is still in flight", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		expect(texts()).toEqual([`didOpen:${A}`]);

		// Only B waits at the transport, so its send stays in
		// flight for as long as the case needs it to.
		const held: Array<() => void> = [];
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string, params: unknown) => {
				if (
					String(method) === "textDocument/didChange" &&
					JSON.stringify(params).includes("const x = 2;")
				) {
					await new Promise<void>((resolve) => {
						held.push(resolve);
					});
				}
				return undefined;
			},
		);
		// The touch that follows waits on the queue behind B; a short write budget
		// keeps that wait bounded (its own verdict is not what this case asserts).
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		const entry = await service.getClientForFile(FILE);
		expect(
			entry?.client,
			"the case needs the file's live client",
		).toBeDefined();
		const sendingB = entry!.client.notify.open(
			FILE,
			B,
			"typescript",
			undefined,
			true,
		);

		await service.touchFile(FILE, A, touch);

		for (const resolve of held.splice(0)) resolve();
		await sendingB;
		await queueDrained(state);

		// The queue is idle and the server holds the bytes the last touch named.
		expect(texts().at(-1)).toBe(`didChange:${A}`);
		expect(state.documentContentHashes.get(FILE)?.hash).toBe(
			hashDiagnosticContent(A),
		);
		expect(held).toHaveLength(0);
	});

	// R4 P1: a standalone save must preserve the cached content and diagnostics.
	it("skips identical content while a save-only send is slow", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		state.pushDiagnostics.set(FILE, []);
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (method === "textDocument/didSave") await gate;
			},
		);
		try {
			await service.touchFile(FILE, A, { ...touch, saved: true });
			await waitFor(
				() =>
					vi
						.mocked(state.connection.sendNotification)
						.mock.calls.some(([method]) => method === "textDocument/didSave"),
				(sent) => sent,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			await service.touchFile(FILE, A, touch);
		} finally {
			release();
			await queueDrained(state);
		}
		expect(texts()).toEqual([`didOpen:${A}`]);
		expect(state.pushDiagnostics.has(FILE)).toBe(true);
	});

	// R4: the kind belongs to the run an entry RETAINS, not to the caller that
	// arrived last. A save coalesced onto a content entry still carries that
	// entry's content (the server ends on those bytes); a content entry
	// coalesced onto a save carries content too. Only a run that sends the save
	// alone leaves the landed record final.
	const pendingWork = async (
		order: "save" | "content-save" | "save-content",
	) => {
		const { service, state, texts } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		const sends: Promise<boolean>[] = [];
		for (const kind of order.split("-")) {
			sends.push(
				kind === "save"
					? clientModule.handleNotifySave(state, FILE)
					: clientModule.handleNotifyOpen(
							state,
							FILE,
							B,
							"typescript",
							undefined,
							true,
						),
			);
		}
		// Read before the runner starts, which is the state the gate reads a
		// pending entry in.
		const contentBearing = clientModule.hasNotifyInFlightFor(state, FILE);
		await service.touchFile(FILE, A, touch);
		await Promise.all(sends);
		await queueDrained(state);
		return {
			contentBearing,
			hash: state.documentContentHashes.get(FILE)?.hash,
			last: texts().at(-1),
		};
	};

	it("reports a pending save as not content-bearing", async () => {
		const observed = await pendingWork("save");
		expect(observed.contentBearing).toBe(false);
		expect(observed.hash).toBe(hashDiagnosticContent(A));
		expect(observed.last).toBe(`didOpen:${A}`);
	});

	it("reports a save merged onto content as content-bearing", async () => {
		const observed = await pendingWork("content-save");
		expect(observed.contentBearing).toBe(true);
		expect(observed.hash).toBe(hashDiagnosticContent(A));
		expect(observed.last).toBe(`didChange:${A}`);
	});

	it("reports content merged onto a save as content-bearing", async () => {
		const observed = await pendingWork("save-content");
		expect(observed.contentBearing).toBe(true);
		expect(observed.hash).toBe(hashDiagnosticContent(A));
		expect(observed.last).toBe(`didChange:${A}`);
	});

	// R4 P3: overflow removes oldest evidence; re-pushing refreshes its order.
	it("bounds touch evidence at 800 and evicts the oldest unrefreshed entry", async () => {
		const { service, texts } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		const file = (n: number) => `/repo/cap-${n}.ts`;
		for (let n = 0; n < 800; n++) await service.touchFile(file(n), A, touch);
		const count = texts().length;
		await service.touchFile(file(0), A, touch);
		await service.touchFile(file(799), A, touch);
		expect(texts()).toHaveLength(count);
		// A changed push refreshes 0 without changing the population.
		await service.touchFile(file(0), B, touch);
		await service.touchFile(file(800), A, touch);
		const overflow = texts().length;
		await service.touchFile(file(0), B, touch);
		await service.touchFile(file(2), A, touch);
		expect(texts()).toHaveLength(overflow);
		await service.touchFile(file(1), A, touch);
		expect(texts()).toHaveLength(overflow + 1);
	});

	// R4 F4: a didClose is NOT save-only. Removing the document is the
	// strongest change a send can make to it, so a skip may never be taken
	// while one is queued. The harm is unreachable today — a touch enqueued
	// behind a close resolves `false` (`queue.closing`), so skipping and
	// pushing leave the same server state — which is why only this reader can
	// pin the claim.
	it("counts a queued close as content-bearing", async () => {
		const { state } = await setup();
		await clientModule.handleNotifyOpen(state, FILE, A, "typescript");
		await queueDrained(state);
		expect(clientModule.hasNotifyInFlightFor(state, FILE)).toBe(false);

		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) === "textDocument/didClose") await held;
				return undefined;
			},
		);
		const closing = clientModule.closeDocument(state, FILE);
		await waitFor(
			() =>
				vi
					.mocked(state.connection.sendNotification)
					.mock.calls.some(
						([method]) => String(method) === "textDocument/didClose",
					),
			(seen) => seen,
			{ timeoutMs: 2_000, yieldControl: tick },
		);
		expect(clientModule.hasNotifyInFlightFor(state, FILE)).toBe(true);
		release();
		await closing;
		await queueDrained(state);
	});

	// R5 F3: the standalone save a skip owes can fail. The mark the queue takes
	// before sending then covers bytes the server never heard a save for, and a
	// saved touch that arrived during the flight marked nothing of its own, so
	// the failure leaves no didSave at all — the server answers nothing for a
	// save-triggered project. A failed send leaves no landed mark, and one
	// bounded retry re-queues the save.
	it("retries a standalone save whose notification failed", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		expect(texts()).toEqual([`didOpen:${A}`]);

		const attempts: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) !== "textDocument/didSave") return undefined;
				attempts.push(String(method));
				// The first attempt hangs, then fails the way a rejected write does.
				if (attempts.length === 1) {
					await held;
					throw new Error("stream write failed");
				}
				return undefined;
			},
		);
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		try {
			// The skipped saved touch queues the standalone save it owes.
			await service.touchFile(FILE, A, { ...touch, saved: true });
			await waitFor(
				() => attempts.length,
				(sent) => sent >= 1,
				{
					timeoutMs: 2_000,
					yieldControl: tick,
				},
			);
			// A second saved touch of the same bytes arrives while that save is
			// still on the wire: it skips, and owes a save of its own only if the
			// mark stops covering a save the server never received.
			await service.touchFile(FILE, A, { ...touch, saved: true });
			release();
			await waitFor(
				() => attempts.length,
				(sent) => sent >= 2,
				{
					timeoutMs: 2_000,
					yieldControl: tick,
				},
			);
		} finally {
			release();
			await queueDrained(state);
		}
		// The recovery is a save, never the redundant content push round 3 sent.
		expect(texts()).toEqual([`didOpen:${A}`]);
		expect(attempts).toHaveLength(2);
	});

	// R5 F3, second half: the one retry can fail too. The mark must not outlive
	// either failure, or the next saved touch of these bytes owes nothing and
	// the server never hears a save for content it holds.
	it("owes the save again after the retry failed too", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		const attempts: string[] = [];
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) !== "textDocument/didSave") return undefined;
				attempts.push(String(method));
				// The send and its one retry fail; the next saved touch's lands.
				if (attempts.length < 3) throw new Error("stream write failed");
				return undefined;
			},
		);
		await service.touchFile(FILE, A, { ...touch, saved: true });
		await waitFor(
			() => attempts.length,
			(sent) => sent >= 2,
			{
				timeoutMs: 2_000,
				yieldControl: tick,
			},
		);
		await queueDrained(state);
		// Two failed saves left no mark, so this touch owes the save again.
		await service.touchFile(FILE, A, { ...touch, saved: true });
		await waitFor(
			() => attempts.length,
			(sent) => sent >= 3,
			{
				timeoutMs: 2_000,
				yieldControl: tick,
			},
		);
		await queueDrained(state);
		expect(texts()).toEqual([`didOpen:${A}`]);
		expect(attempts).toHaveLength(3);
	});

	// R6 F4 (Greptile 4304348418, shape 31): a failed standalone save and the
	// recovery's own last attempt each leave one bounded record, once per server
	// per session. `lsp_touch_file` is written BEFORE the save finishes, so
	// without these rows "the save was queued" and "the save never landed" read
	// the same, and a save-triggered server's silence has no trace at all.
	// `PI_LENS_TEST_MODE=0` is the only way to read the DURABLE half: the log
	// sink drops every write in test mode, and this case asserts the sink.
	it("records a failed save and the recovery it exhausted", async () => {
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		// The ledger's once-per-kind latch is SESSION state, and the cases above
		// already spent it for these two kinds (in test mode, so without a durable
		// row). Start a session, through the seam `session_start` calls, so the
		// rows this case reads are the ones it drove.
		resetDegradationLedger();
		try {
			const { service, texts, state } = await setup();
			const touch = { diagnostics: "none" as const, source: "test" };
			await service.touchFile(FILE, A, touch);
			const attempts: string[] = [];
			vi.mocked(state.connection.sendNotification).mockImplementation(
				async (method: string) => {
					if (String(method) !== "textDocument/didSave") return undefined;
					attempts.push(String(method));
					// Two failures, then anything else the bound lets through lands,
					// so an unbounded retry terminates and reports its real count.
					if (attempts.length > 2) return undefined;
					throw new Error("stream write failed");
				},
			);
			await service.touchFile(FILE, A, { ...touch, saved: true });
			await waitFor(
				() => attempts.length,
				(sent) => sent >= 2,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			await queueDrained(state);
			expect(texts()).toEqual([`didOpen:${A}`]);
			expect(attempts).toHaveLength(2);
			const kinds = getDegradationSummary().map((group) => group.kind);
			expect(kinds, "the failed attempt left no record").toContain(
				"lsp-did-save-send-failed",
			);
			expect(kinds, "the exhausted recovery left no record").toContain(
				"lsp-did-save-recovery-exhausted",
			);
			const durable = await durableDegradations();
			expect(durable, "the failed attempt never reached the sink").toContain(
				`${state.serverId}:lsp-did-save-send-failed`,
			);
			expect(
				durable,
				"the exhausted-recovery record never reached the sink",
			).toContain("typescript:lsp-did-save-recovery-exhausted");
		} finally {
			if (previousTestMode === undefined) {
				delete process.env.PI_LENS_TEST_MODE;
			} else {
				process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		}
	});

	// R6 F3 (Greptile 4304348416): the recovery is ONE retry. The bound is the
	// last argument `saveDebouncedPush` passes to its own recursion; without it
	// every failure re-queues the next save inside one microtask chain, so the
	// bytes still get no save and nothing else on the event loop runs. The mock
	// lands the sixtieth attempt so this case TERMINATES either way: an unbounded
	// retry reaches it and reports 60 attempts instead of the test hanging.
	it(
		"stops after one retry on a persistently failing save",
		{ timeout: 20_000 },
		async () => {
			const { service, texts, state } = await setup();
			const touch = { diagnostics: "none" as const, source: "test" };
			await service.touchFile(FILE, A, touch);
			const attempts: string[] = [];
			vi.mocked(state.connection.sendNotification).mockImplementation(
				async (method: string) => {
					if (String(method) !== "textDocument/didSave") return undefined;
					attempts.push(String(method));
					// A macrotask between attempts, so a runaway retry yields to the
					// event loop instead of starving this test's own timer.
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (attempts.length < 60) throw new Error("stream write failed");
					return undefined;
				},
			);
			await service.touchFile(FILE, A, { ...touch, saved: true });
			await waitFor(
				() => attempts.length,
				(sent) => sent >= 2,
				{ timeoutMs: 3_000, yieldControl: tick },
			);
			await queueDrained(state);
			expect(texts()).toEqual([`didOpen:${A}`]);
			expect(attempts, "the recovery retried more than once").toHaveLength(2);
		},
	);

	// R6 F2 (Greptile 4304348412): a failed save's retry sends for whatever the
	// client holds when its queue entry runs, and a content push queued behind
	// the failure advances that document. The mark must therefore name the
	// content the send COVERED; when it named the bytes the skip read, the retry
	// saved B under a mark saying A, and the saved touch A needs sent nothing.
	it("sends the save a failed save's retry did not cover", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		const saved = { ...touch, saved: true };
		await service.touchFile(FILE, A, touch);
		expect(texts()).toEqual([`didOpen:${A}`]);

		const saves: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) !== "textDocument/didSave") return undefined;
				saves.push(String(method));
				// The first attempt hangs at the transport, then fails the way a
				// rejected write does. Anything after it lands.
				if (saves.length === 1) {
					await held;
					throw new Error("stream write failed");
				}
				return undefined;
			},
		);
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		try {
			// The skipped saved touch queues the standalone save it owes.
			await service.touchFile(FILE, A, saved);
			await waitFor(
				() => saves.length,
				(sent) => sent >= 1,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			// A content push of OTHER bytes sits behind that save. It lands while the
			// failure's retry is still to come, so the retry saves THESE bytes.
			const pushing = service.openFile(FILE, B);
			await waitFor(
				() => state.notifyChangeQueues.get(normalizeMapKey(FILE))?.pending,
				(queued) => queued !== undefined,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			release();
			await pushing;
			await waitFor(
				() => saves.length,
				(sent) => sent >= 2,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			await queueDrained(state);
			// A second writer (the resync route) advances the record back to A
			// without marking a touch, exactly as the resync does in production.
			await service.openFile(FILE, A);
			await queueDrained(state);
		} finally {
			release();
		}
		const before = saves.length;
		// The saved touch A needs: the server holds A and no didSave covered it.
		await service.touchFile(FILE, A, saved);
		await waitFor(
			() => saves.length,
			(sent) => sent > before,
			{ timeoutMs: 2_000, yieldControl: tick },
		);
		await queueDrained(state);
		// The content the two `openFile` pushes carried, and no re-push of A: the
		// recovery is a save, never the redundant content push round 3 sent.
		expect(texts()).toEqual([
			`didOpen:${A}`,
			`didChange:${B}`,
			`didChange:${A}`,
		]);
		expect(saves).toHaveLength(3);
	});

	// R7: a second saved touch can queue while the first runs. Its run checks
	// landed evidence and sends nothing if the first succeeded.
	it("queues no second save for a saved touch that arrives mid-send", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		const saved = { ...touch, saved: true };
		await service.touchFile(FILE, A, touch);
		const saves: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) !== "textDocument/didSave") return undefined;
				saves.push(String(method));
				// The first save stays on the wire for the whole case.
				await held;
				return undefined;
			},
		);
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		try {
			await service.touchFile(FILE, A, saved);
			await waitFor(
				() => saves.length,
				(sent) => sent >= 1,
				{ timeoutMs: 2_000, yieldControl: tick },
			);
			// The same saved touch again, while that save is still in flight.
			await service.touchFile(FILE, A, saved);
		} finally {
			release();
			await queueDrained(state);
		}
		expect(texts()).toEqual([`didOpen:${A}`]);
		expect(
			saves,
			"a second save went out for bytes already being saved",
		).toHaveLength(1);
	});
	// R7 P6 / shape 31: carried saves fail independently of their content push.
	it.each(["stream write failed", "unexpected connection failure"])(
		"owes a carried save after %s and records its failure",
		async (message) => {
			const { service, state } = await setup({ serverId: "opengrep" });
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const touch = { diagnostics: "none" as const, source: "test" };
			await service.touchFile(FILE, A, touch);
			resetDegradationLedger();
			const durableStart = (await durableDegradations()).length;
			let saves = 0;
			vi.mocked(state.connection.sendNotification).mockImplementation(
				async (method: string) => {
					if (method === "textDocument/didSave" && ++saves === 1)
						throw new Error(message);
				},
			);
			await service.touchFile(FILE, B, { ...touch, saved: true });
			await queueDrained(state);
			expect(
				getDegradationSummary().map((row) => row.kind),
				"carried failure left no record",
			).toContain("lsp-did-save-send-failed");
			expect((await durableDegradations()).slice(durableStart)).toContain(
				`${state.serverId}:lsp-did-save-send-failed`,
			);
			expect(
				state.expectedPublicationsBeyondSends?.get(FILE) ?? 0,
				"failed save must give back its rescan expectation",
			).toBe(0);
			await service.touchFile(FILE, B, { ...touch, saved: true });
			await queueDrained(state);
			expect(
				saves,
				"a carried save that failed still owes the next saved touch",
			).toBe(2);
		},
	);

	// R7 P5: a waiter's own input need not be what its replacement saved.
	it("saves the bytes skipped by a coalesced saved content push", async () => {
		const { service, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let opened = false;
		let saves = 0;
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (method === "textDocument/didOpen") {
					opened = true;
					await held;
				}
				if (method === "textDocument/didSave") saves++;
			},
		);
		const opening = service.openFile(FILE, A);
		await waitFor(() => opened, Boolean, {
			timeoutMs: 2_000,
			yieldControl: tick,
		});
		const savedTouch = service.touchFile(FILE, A, { ...touch, saved: true });
		await waitFor(
			() => state.notifyChangeQueues.get(FILE)?.pending?.saved === true,
			Boolean,
			{ timeoutMs: 2_000, yieldControl: tick },
		);
		const replacement = service.openFile(FILE, B);
		await waitFor(
			() => state.notifyChangeQueues.get(FILE)?.pending?.coalescedCount ?? 0,
			(n) => n > 0,
			{ timeoutMs: 2_000, yieldControl: tick },
		);
		release();
		await Promise.all([opening, savedTouch, replacement]);
		await queueDrained(state);
		expect(saves).toBe(1);
		await service.openFile(FILE, A);
		await service.touchFile(FILE, A, { ...touch, saved: true });
		await queueDrained(state);
		expect(saves, "the replacement saved B, so A still owes its save").toBe(2);
	});

	// Greptile 4304576861: a late old-client save must not touch new evidence.
	it("keeps an old client's late save out of its replacement", async () => {
		const { service, state, client } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let saving = false;
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (method === "textDocument/didSave") {
					saving = true;
					await held;
				}
			},
		);
		await service.touchFile(FILE, A, { ...touch, saved: true });
		await waitFor(() => saving, Boolean, {
			timeoutMs: 2_000,
			yieldControl: tick,
		});
		vi.spyOn(client, "isAlive").mockReturnValue(false);
		const replacement = await setup();
		await service.touchFile(FILE, B, touch);
		release();
		await queueDrained(state);
		await service.openFile(FILE, A);
		await service.touchFile(FILE, A, { ...touch, saved: true });
		await queueDrained(replacement.state);
		expect(
			vi
				.mocked(replacement.state.connection.sendNotification)
				.mock.calls.filter(([method]) => method === "textDocument/didSave"),
		).toHaveLength(1);
	});

	// R7: explore coalescing and save completion order instead of one replay.
	it("keeps save evidence aligned with wire bytes under scheduled pushes", async () => {
		await fc.assert(
			fc.asyncProperty(fc.scheduler(), async (scheduler) => {
				const { service, state, client } = await setup();
				const touch = { diagnostics: "none" as const, source: "test" };
				await service.touchFile(FILE, A, touch);
				let wireContent = A;
				let savedContent: string | undefined;
				vi.mocked(state.connection.sendNotification).mockImplementation(
					async (method: string, params: unknown) => {
						await scheduler.schedule(Promise.resolve(), method);
						const p = params as { contentChanges?: Array<{ text: string }> };
						if (method === "textDocument/didChange")
							wireContent = p.contentChanges!.at(-1)!.text;
						if (method === "textDocument/didSave") savedContent = wireContent;
					},
				);
				await scheduler.waitFor(
					Promise.all([
						service.touchFile(FILE, A, { ...touch, saved: true }),
						service.openFile(FILE, B),
						service.touchFile(FILE, B, { ...touch, saved: true }),
					]),
				);
				await scheduler.waitFor(queueDrained(state));
				await scheduler.waitFor(service.openFile(FILE, A));
				await scheduler.waitFor(
					service.touchFile(FILE, A, { ...touch, saved: true }),
				);
				await scheduler.waitFor(queueDrained(state));
				expect(
					savedContent,
					"the final saved touch must reach the wire for A",
				).toBe(A);
				expect(
					client.getSentContent?.(FILE)?.savedHash,
					"save evidence must name the wire save's bytes",
				).toBe(hashDiagnosticContent(savedContent!));
			}),
			{ seed: 4532, numRuns: 40 },
		);
	});
	// R7 writer census: record replacement carries existing save evidence.
	it("keeps a landed save across an unsaved push of the same bytes", async () => {
		const { service, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test", saved: true };
		await service.touchFile(FILE, A, touch);
		await service.openFile(FILE, A);
		await service.touchFile(FILE, A, touch);
		await queueDrained(state);
		expect(
			vi
				.mocked(state.connection.sendNotification)
				.mock.calls.filter(([method]) => method === "textDocument/didSave"),
		).toHaveLength(1);
	});

	// R8 N1 (Greptile 4304769101, shape 55): Incremental's text budget strips a
	// record's payload by REBUILDING it, and the rebuild used to write a fresh
	// entry without `savedHash`. After 128 text-bearing documents the record no
	// longer said the save landed, so the next saved touch of the same bytes
	// sent a second didSave — on a save-triggered whole-project server, another
	// project check for bytes already saved.
	it("keeps a landed save's evidence when text eviction strips the record", async () => {
		const { service, state } = await setup();
		state.syncKind = TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL;
		const touch = { diagnostics: "none" as const, source: "test" };
		const saved = { ...touch, saved: true };
		const saves = () =>
			vi
				.mocked(state.connection.sendNotification)
				.mock.calls.filter(([method]) => method === "textDocument/didSave");
		await service.touchFile(FILE, A, saved);
		await queueDrained(state);
		expect(saves(), "the first saved touch must save once").toHaveLength(1);
		// Other documents fill the text budget; the oldest (FILE) is what the
		// eviction rebuild strips.
		for (
			let index = 0;
			index < clientModule.MAX_INCREMENTAL_TEXT_RETAINED_ENTRIES;
			index++
		) {
			await service.openFile(`/repo/evict-${index}.ts`, `text-${index}`);
		}
		const stripped = state.documentContentHashes.get(normalizeMapKey(FILE));
		expect(
			stripped?.text,
			"the fixture must have stripped the payload",
		).toBeUndefined();
		expect(
			stripped?.savedHash,
			"the rebuilt record must carry the save evidence the record held",
		).toBe(hashDiagnosticContent(A));
		await service.touchFile(FILE, A, saved);
		await queueDrained(state);
		expect(
			saves(),
			"a stripped record must not owe a second save for bytes already saved",
		).toHaveLength(1);
	});

	// R8 N2 (shape 55): the save mark belongs to the record the send COVERED,
	// never to whatever the map holds when the send settles. Another path's push
	// evicting this record mid-flight installs a fresh entry; stamping THAT one
	// would claim a save for bytes no didSave covered and suppress the save they
	// still owe.
	it("keeps a save that lands late out of the record that replaced it", async () => {
		const { service, state } = await setup();
		state.syncKind = TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL;
		const touch = { diagnostics: "none" as const, source: "test" };
		const key = normalizeMapKey(FILE);
		await service.touchFile(FILE, A, touch);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let saving = false;
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (method === "textDocument/didSave") {
					saving = true;
					await held;
				}
			},
		);
		const savedTouch = service.touchFile(FILE, A, { ...touch, saved: true });
		await waitFor(() => saving, Boolean, {
			timeoutMs: 2_000,
			yieldControl: tick,
		});
		// A different path's send runs on its own queue, so it evicts FILE's
		// record while FILE's save is still on the wire.
		for (
			let index = 0;
			index < clientModule.MAX_INCREMENTAL_TEXT_RETAINED_ENTRIES;
			index++
		) {
			await service.openFile(`/repo/evict-late-${index}.ts`, `text-${index}`);
		}
		const replacement = state.documentContentHashes.get(key);
		expect(
			replacement?.hash,
			"the replacement must still name this document's bytes",
		).toBe(hashDiagnosticContent(A));
		expect(
			replacement?.text,
			"the eviction must have rebuilt the record mid-flight",
		).toBeUndefined();
		release();
		await savedTouch;
		await queueDrained(state);
		const after = state.documentContentHashes.get(key);
		expect(after, "the record must survive the save's completion").toBe(
			replacement,
		);
		expect(
			after?.savedHash,
			"the late completion stamped the replacement record",
		).toBeUndefined();
	});
});
