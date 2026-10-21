/**
 * #3405: `LSPService.touchFile`'s `saved` option is what reaches the client.
 *
 * Recurrence this file prevents: a save flag that stops at the service boundary.
 * The client-side gate (`tests/clients/lsp/did-save-notification.test.ts`) can be
 * perfect and the fix still inert if `touchFile` never forwards the caller's
 * declaration to `notify.open` — the wrong-layer half of the same seam. These
 * cases drive the REAL `LSPService.touchFile` with the exact option object the
 * post-write sync (`clients/pipeline.ts`, `source: "lsp_sync"`) issues and read
 * the argument the client was handed.
 *
 * Screens: the only doubles are `createLSPClient` and the server registry, both
 * true process/config boundaries — the service, its per-server notify loop and
 * its debounce bookkeeping are real. Not a **loose bound**: the sixth argument
 * is pinned to the exact boolean in both directions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ROOT = "C:/repo";

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
		pid: 4343,
	};
}

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident",
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeClient(
	serverId: string,
	open: ReturnType<typeof vi.fn>,
	saveOptions?: { includeText: boolean },
) {
	// #4532 gap 9: the double answers the touch gate the way a real client does
	// — with the record of the payloads its own `notify.open` took — and queues
	// nothing. Without the record the gate fails closed and every touch pushes,
	// which is not the seam these cases pin.
	const sent = new Map<
		string,
		{ hash: string; savedHash?: string | undefined }
	>();
	// Every argument is forwarded: these cases pin the sixth one (`saved`).
	const recorded = vi.fn(
		async (filePath: string, content: string, ...rest: unknown[]) => {
			const result = await (
				open as unknown as (...args: unknown[]) => Promise<unknown>
			)(filePath, content, ...rest);
			if (result !== false) {
				const hash = hashDiagnosticContent(content);
				sent.set(filePath, {
					hash,
					savedHash:
						rest[3] === true && saveOptions
							? hash
							: sent.get(filePath)?.savedHash,
				});
			}
			return result;
		},
	);
	return {
		serverId,
		getSaveOptions: () => saveOptions,
		getSentContent: (filePath: string) => sent.get(filePath),
		hasNotifyInFlight: () => false,
		root: ROOT,
		customServer: false,
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			announceCreated: () => undefined,
			open: recorded,
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(async () => {}),
	};
}

/** Exactly the options `clients/pipeline.ts`'s `resyncLspFile` issues, minus
 *  the flag under test. */
const POST_WRITE_TOUCH = {
	diagnostics: "none" as const,
	source: "lsp_sync",
	clientScope: "primary" as const,
	maxClientWaitMs: 5000,
};

async function touchWith(
	options: Record<string, unknown>,
): Promise<unknown[] | undefined> {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	const open = vi.fn(async () => {});
	getServersForFileWithConfig.mockReturnValue([
		makeServer("typescript", ".ts"),
	]);
	createLSPClient.mockResolvedValue(makeClient("typescript", open));
	const file = `${ROOT}/saved.ts`;
	await service.getClientsForFile(file);
	await service.touchFile(file, "const x = 1;\n", {
		...POST_WRITE_TOUCH,
		...options,
	});
	return open.mock.calls[0];
}

describe("#3405 — touchFile forwards the caller's save declaration", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hands notify.open saved=true for the post-write sync's own options", async () => {
		const call = await touchWith({ saved: true });
		expect(call?.[5]).toBe(true);
	});

	it("hands notify.open saved=false when the caller declared no save", async () => {
		// Every warm-up, cascade and sweep caller lands here. `false`, never
		// `undefined`: the client's parameter default is what a partial double
		// would fall back to, so the service states the answer explicitly.
		const call = await touchWith({});
		expect(call?.[5]).toBe(false);
	});
});

/**
 * Touches of the same bytes inside the debounce window, on one service and one
 * client; returns every `notify.open` and `notify.save` call the client got.
 */
async function touchSameBytes(
	touches: Record<string, unknown>[],
	saveOptions: { includeText: boolean } | undefined,
): Promise<{ opens: unknown[][]; saves: unknown[][] }> {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	const open = vi.fn(async () => {});
	const client = makeClient("typescript", open, saveOptions);
	const save = vi.fn(async (filePath: string, _onlyIfOwed?: boolean) => {
		const record = client.getSentContent(filePath);
		if (record) record.savedHash = record.hash;
		return true;
	});
	Object.assign(client.notify, { save });
	getServersForFileWithConfig.mockReturnValue([
		makeServer("typescript", ".ts"),
	]);
	createLSPClient.mockResolvedValue(client);
	const file = `${ROOT}/saved.ts`;
	await service.getClientsForFile(file);
	for (const options of touches) {
		const { content = "const x = 1;\n", ...rest } = options as {
			content?: string;
		};
		await service.touchFile(file, content, rest);
	}
	return { opens: open.mock.calls, saves: save.mock.calls };
}

/**
 * #3405 r1: the save rides on the content push, and the debounce skips a push
 * of bytes the server already holds — so a save declared on a touch that
 * follows an UNSAVED push of the same bytes was dropped with the push.
 *
 * Recurrence this block prevents, measured through the real MCP server and a
 * real clangd 22.1.0 (`--input-mirror-file`): a cold `lsp_diagnostics` query
 * runs its sweep warm-up first (`source: "lsp_sweep_warmup"`, unsaved), then
 * its own `saved: true` touch 6 ms later; the second touch was debounced, so
 * clangd received didOpen and never didSave. A save-triggered server (Expert)
 * then answers nothing for the query. The push itself stays debounced: a
 * re-push cleared the cache and clangd, which does not republish identical
 * bytes, left the query inconclusive.
 */
describe("#3405 — a save is not debounced away with the push it rides on", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const file = `${ROOT}/saved.ts`;

	// The explicit query's touch (document) and the post-write sync's (none)
	// reach the debounce through two sites: the per-server skip set and the
	// whole-call short-circuit.
	it.each(["document", "none"] as const)(
		"sends only the save for a saved touch over an unsaved push of the same bytes (%s)",
		async (diagnostics) => {
			const { opens, saves } = await touchSameBytes(
				[
					{ ...POST_WRITE_TOUCH, diagnostics },
					{ ...POST_WRITE_TOUCH, diagnostics, saved: true },
				],
				{ includeText: false },
			);
			expect(opens).toHaveLength(1);
			expect(opens[0]?.[5]).toBe(false);
			expect(saves).toEqual([[file, true]]);
		},
	);

	it("sends no save to a server that declared none", async () => {
		const { opens, saves } = await touchSameBytes(
			[
				{ ...POST_WRITE_TOUCH, diagnostics: "document" },
				{ ...POST_WRITE_TOUCH, diagnostics: "document", saved: true },
			],
			undefined,
		);
		expect(opens).toHaveLength(1);
		expect(saves).toEqual([]);
	});

	it("sends no second save for a saved touch over a saved push of the same bytes", async () => {
		// One save per bytes: a second save would make Expert schedule a second
		// whole-project compile for content it already compiled.
		const { opens, saves } = await touchSameBytes(
			[
				{ ...POST_WRITE_TOUCH, saved: true },
				{ ...POST_WRITE_TOUCH, saved: true },
			],
			{ includeText: false },
		);
		expect(opens).toHaveLength(1);
		expect(opens[0]?.[5]).toBe(true);
		expect(saves).toEqual([]);
	});

	it("sends no save for an unsaved touch over an unsaved push of the same bytes", async () => {
		// #3405 r2 (review F2a): only a caller that declared a save is owed one.
		// A warm-up or cascade touch debounced over another unsaved push must
		// stay silent: Expert schedules a whole-project compile per didSave.
		const { opens, saves } = await touchSameBytes(
			[{ ...POST_WRITE_TOUCH }, { ...POST_WRITE_TOUCH }],
			{ includeText: false },
		);
		expect(opens).toHaveLength(1);
		expect(saves).toEqual([]);
	});

	it("sends one save for a saved touch of new bytes after an unsaved push of old bytes", async () => {
		// #3405 r2 (review F2b): the save-alone path is for a server whose push
		// was skipped. A server that gets the new bytes carries the save on that
		// push; a second, separate save for the same write would make Expert
		// compile twice.
		const { opens, saves } = await touchSameBytes(
			[
				{ ...POST_WRITE_TOUCH },
				{ ...POST_WRITE_TOUCH, saved: true, content: "const x = 2;\n" },
			],
			{ includeText: false },
		);
		expect(opens).toHaveLength(2);
		expect(opens[1]?.[5]).toBe(true);
		expect(saves).toEqual([]);
	});

	it("debounces a with-auxiliary touch over a primary push of the same bytes", async () => {
		// #3405 r2 (review F1): the post-write sync and the MCP analysis push
		// with scope "primary", then the dispatch runner touches the same bytes
		// with scope "with-auxiliary" (on by default). The debounce key carried
		// the scope, so the runner re-pushed the primary server the bytes it
		// held, clearing the finding a save-only server had published for the
		// save. The entry is per server; the scope says nothing about what that
		// server holds.
		const { opens, saves } = await touchSameBytes(
			[
				{ ...POST_WRITE_TOUCH, saved: true },
				{
					...POST_WRITE_TOUCH,
					clientScope: "with-auxiliary",
					source: "dispatch-lsp-runner",
				},
			],
			{ includeText: false },
		);
		expect(opens).toHaveLength(1);
		expect(opens[0]?.[5]).toBe(true);
		expect(saves).toEqual([]);
	});

	it("sends one save for two saved touches over one unsaved push", async () => {
		const { saves } = await touchSameBytes(
			[
				{ ...POST_WRITE_TOUCH },
				{ ...POST_WRITE_TOUCH, saved: true },
				{ ...POST_WRITE_TOUCH, saved: true },
			],
			{ includeText: false },
		);
		expect(saves).toEqual([[file, true]]);
	});
});
