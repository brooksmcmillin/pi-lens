/**
 * #4615 — the `[lsp-pub]` sink row names the DOCUMENT it is about.
 *
 * ## The recurrence this guards
 *
 * `probe-clean-signal.mjs` brackets each fixture phase with a byte offset in
 * `extension.log`, and that sink is a buffered async writer: a line enqueued by
 * an earlier fixture can flush after the next fixture's `reset()`. The drain
 * used to keep rows by `server` alone, and five typescript fixtures share that
 * server id with their clients alive in the same process — so another client's
 * late `diags=1` publish became `typescript-clean`'s first publish, and
 * `classifyFirstPublish` (order-only) read it as `direct`. That value fed the
 * nightly's `typescript` row.
 *
 * This file drives the production notification handler through the REAL
 * extension-log sink: a per-case `PI_LENS_TEST_MODE=0` window lets
 * `logExtension` write to this worker's own `extension.log`, the bytes are
 * captured right after `flushExtensionLog()`, and that window is drained
 * through the real `createPublishTraceDrainer` for one (server, document). No
 * in-process module double stands in for the sink (shape 66): the bytes are
 * the production writer's own. The plant is the real ordering: fixture B's own
 * empty answer, then fixture A's row arriving late.
 */
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `logExtension` is a no-op under Vitest (`isTestMode`) and the client reads
// `PILENS_PUB_DEBUG` once at module load, so the debug pin has to sit before
// the dynamic import below; no per-case hook can put it back after the module
// captured the flag. #4589: that module-lifetime pin is an admission —
// `tests/support/test-env-restore-admissions.ts`, mechanism `module-pin`.
process.env.PILENS_PUB_DEBUG = "1";
const { setupIncomingHandlers } =
	await import("../../../clients/lsp/client.js");
const { flushExtensionLog, getExtensionLogPath } =
	await import("../../../clients/extension-log.js");
const { createPublishTraceDrainer, classifyFirstPublish } =
	await import("../../../scripts/lib/clean-signal.mjs");
const { normalizeMapKey } = await import("../../../clients/path-utils.js");
const { createMockState } = await import("./mock-client-state.js");

// #4615 review F2: a drive-less `file:///proj/...` URL is invalid on win32 —
// `fileURLToPath` throws, `uriToPath` then treats the URL as a plain path, and
// the stamped key becomes `file:/proj/...`, so both cells would fail on a
// Windows host. Build the URL from a platform-shaped path instead; the key is
// whatever `normalizeMapKey` makes of it, and both sides of the drain use it.
const WIN32 = process.platform === "win32";
const DIRTY_FILE = WIN32
	? "C:\\proj\\fixtures\\typescript\\bad.ts"
	: "/proj/fixtures/typescript/bad.ts";
const CLEAN_FILE = WIN32
	? "C:\\proj\\fixtures\\typescript-clean\\clean.ts"
	: "/proj/fixtures/typescript-clean/clean.ts";
const DIRTY_URI = pathToFileURL(DIRTY_FILE).href;
const CLEAN_URI = pathToFileURL(CLEAN_FILE).href;
const FINDING = {
	severity: 1,
	message: "Type 'string' is not assignable to type 'number'.",
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 5 },
	},
};

/**
 * The real sink, off for the length of a case so `logExtension` writes
 * (test mode is read at call time), then put back exactly as found. The
 * precedent is `tests/scripts/latency-log-phases.test.ts`, and the sweep's
 * own classifier reads this save/restore pair as restored (#4589).
 */
let previousTestMode: string | undefined;
beforeEach(() => {
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
});
afterEach(() => {
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
});

/**
 * This worker's real `extension.log` bytes. Flushed immediately before the
 * read, with no other `await` in between (AGENTS.md shape 67): the writer
 * enqueues, so an unflushed read counts the phase's own row outside its
 * window.
 */
let sinkBytes = Buffer.alloc(0);

async function captureSink(): Promise<void> {
	await flushExtensionLog();
	sinkBytes = fs.existsSync(getExtensionLogPath())
		? fs.readFileSync(getExtensionLogPath())
		: Buffer.alloc(0);
}

/** One parsed `[lsp-pub]` row as the drainer pushes it into a phase sink. */
interface DrainedPublish {
	server: string;
	path?: string;
	pubVersion: string;
	diags: number;
	versioned: boolean;
}

type Publish = (params: {
	uri: string;
	diagnostics?: unknown[];
	version?: number;
}) => void;

/** Arm the production handler for one server id; return its publish entry. */
function armHandler(serverId: string): Publish {
	const state = createMockState({ serverId });
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const handler = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1];
	expect(handler).toBeDefined();
	return handler as Publish;
}

/** The rows the real sink gained since byte `offset`, JSON-parsed. */
function rowsSince(offset: number): Array<Record<string, unknown>> {
	return sinkBytes
		.subarray(offset)
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A drainer over the real sink snapshot, keyed exactly as the probe keys it. */
function drainer() {
	return createPublishTraceDrainer({
		readLog() {
			const bytes = sinkBytes;
			return {
				size: bytes.length,
				read(start: number) {
					return {
						chunk: bytes.subarray(start).toString("utf8"),
						bytesRead: bytes.length - start,
					};
				},
			};
		},
		documentPathKey: normalizeMapKey,
	});
}

describe("#4615 the publish trace names its document", () => {
	it("stamps the client's own document key into every [lsp-pub] row", async () => {
		await captureSink();
		const offset = sinkBytes.length;
		const publish = armHandler("typescript");
		publish({ uri: DIRTY_URI, diagnostics: [FINDING] });
		await captureSink();

		const rows = rowsSince(offset);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			subsystem: "lsp-pub",
			message: expect.stringContaining("diags=1"),
			metadata: { path: normalizeMapKey(DIRTY_FILE) },
		});
	});

	it("never attributes another live client's late publish to this fixture (#4615)", async () => {
		await captureSink();
		const drain = drainer();
		const publishDirty = armHandler("typescript");
		const publishClean = armHandler("typescript");

		// Fixture A (dirty): its own one-finding answer, the measured `direct`.
		drain.reset(sinkBytes.length);
		publishDirty({ uri: DIRTY_URI, diagnostics: [FINDING] });
		await captureSink();
		const dirtySink: DrainedPublish[] = [];
		drain(dirtySink, "typescript", DIRTY_FILE);
		expect(classifyFirstPublish(dirtySink).firstPublish).toBe("direct");

		// Fixture B (clean): its phase starts at the current sink size; its own
		// only publish is the empty settled answer...
		drain.reset(sinkBytes.length);
		publishClean({ uri: CLEAN_URI, diagnostics: [] });
		// ...and fixture A's client republishes AFTER that reset — the buffered
		// writer's late flush that landed three lines 1 ms apart in run
		// 39410536713.
		publishDirty({ uri: DIRTY_URI, diagnostics: [FINDING] });
		await captureSink();

		const cleanSink: DrainedPublish[] = [];
		drain(cleanSink, "typescript", CLEAN_FILE);
		expect(cleanSink.map((row) => row.diags)).toEqual([0]);
		expect(classifyFirstPublish(cleanSink).firstPublish).toBe("empty-only");
	});
});
