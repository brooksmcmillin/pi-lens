// flake-shape: in-process-mock — createLSPClient spawns a language-server process; the client it returns here runs the real wait, publish handler and clear over a real state, and a real server cannot be made to publish twice and take a refresh clear inside one quiet window on demand
// flake-shape: service-double — a language-server client is a spawned process; only its publish order and the mid-wait clear are scripted (#4785 F4)
/**
 * #4785 round 3 (verify F4): a touch whose only answer a clear removed must
 * not report a confirmed clean.
 *
 * Recurrence this file prevents: round 2 let a deferred diagnostics wait (a
 * stored answer plus a later receipt in the quiet window) finish at once when
 * `clearDiagnosticsForPath` cancelled that receipt. The clear had removed the
 * stored answer too, and the touch decides "no answer" only when its wait ran
 * to the budget (`waitedMs + 20 >= timeoutMs`, clients/lsp/index.ts). So a
 * 50 ms wait with nothing stored read as `confirmation: "confirmed"` with no
 * findings: a phantom clean, for a file the server had reported a finding on.
 *
 * Production chain: the REAL `LSPService.touchFile`, the REAL
 * `clientWaitForDiagnostics`, the REAL `publishDiagnostics` handler and the
 * REAL `clearDiagnosticsForPath`, over `createMockState`. Only the client
 * factory and the server list are doubles (the process boundary). The touch's
 * own write lands, the server answers (stored), publishes again (pending in its
 * quiet window), and a `workspace/diagnostic/refresh` clear lands mid-wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPClientState } from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const h = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient: h.createLSPClient,
}));

const FILE = "/project/src/main.ts";
const URI = `file://${FILE}`;
const WAIT_MS = 2_000;

const finding = (message: string) => ({
	severity: 1 as const,
	message,
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
});

function makeServer(id: string) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => "/project",
		spawn: vi.fn(async () => ({
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
			source: "test",
		})),
	};
}

type Publish = (params: {
	uri: string;
	diagnostics: ReturnType<typeof finding>[];
	version?: number;
}) => void;

/** A client over a real state, and the refresh clear for its path. */
async function realClient() {
	const real = await import("../../../clients/lsp/client.js");
	const state: LSPClientState = createMockState();
	const key = FILE;
	state.openDocuments.add(key);
	state.openDocumentUris?.set(key, URI);
	state.documentVersions.set(key, 1);
	real.setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, Publish]>;
	const publish = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1] as Publish;
	const client = {
		serverId: "ts-primary",
		customServer: false,
		root: "/project",
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
		get diagnosticsVersion() {
			return state.diagnosticsVersion;
		},
		// The per-path publication stamp: the touch's primary evidence signal
		// (`readPathVersion`), read through the production accessor.
		getDiagnosticsVersionForPath: (p: string) =>
			real.diagnosticsVersionForPath(state, normalizeMapKey(p)),
		getDiagnostics: (p: string) => state.pushDiagnostics.get(p) ?? [],
		getAllDiagnostics: () => state.pushDiagnostics,
		getDiagnosticBinding: () => undefined,
		notify: {
			announceCreated: () => undefined,
			// The touch's write lands; the server answers it (stored) and
			// publishes again, so that receipt is pending when the wait starts.
			open: async () => {
				publish({ uri: URI, diagnostics: [finding("STOP-v1")], version: 1 });
				vi.advanceTimersByTime(150);
				publish({ uri: URI, diagnostics: [finding("STOP-v2")], version: 1 });
			},
			change: async () => {},
			close: async () => {},
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: (
			p: string,
			timeoutMs: number,
			options?: Parameters<typeof real.clientWaitForDiagnostics>[3],
		) => real.clientWaitForDiagnostics(state, p, timeoutMs, options),
	};
	// workspace/diagnostic/refresh drops every open document's state.
	const clear = () => real.clearDiagnosticsForPath(state, key);
	return { client, clear };
}

async function touch(client: Awaited<ReturnType<typeof realClient>>["client"]) {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	h.getServersForFileWithConfig.mockReturnValue([makeServer(client.serverId)]);
	h.createLSPClient.mockResolvedValue(client);
	const run = service.touchFile(FILE, "const x = 1;", {
		clientScope: "primary",
		collectDiagnostics: true,
		diagnostics: "document",
		maxClientWaitMs: 1_000,
		maxDiagnosticsWaitMs: WAIT_MS,
		source: "test",
	});
	await vi.advanceTimersByTimeAsync(9_000);
	const result = await run;
	return {
		confirmation: result?.confirmation ?? null,
		inconclusive: result?.inconclusive ?? null,
		diags: (result?.diags ?? []).map((d) => d.message),
	};
}

describe("#4785 F4: a cleared deferred wait is not a confirmed clean", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		(await import("../../../clients/lsp/config.js"))._setServersForFileForTests(
			h.getServersForFileWithConfig,
		);
		h.getServersForFileWithConfig.mockReset();
		h.createLSPClient.mockReset();
	});

	// Recurrence: #4785 verify F4, the phantom clean (round 2 read
	// `confirmed` with `[]` at 50 ms).
	it("reports no confirmed clean when a clear removes the only answer mid-wait", async () => {
		const { client, clear } = await realClient();
		setTimeout(clear, 200);
		const verdict = await touch(client);

		expect(verdict.confirmation).not.toBe("confirmed");
		expect(verdict.inconclusive).toBe(true);
	});

	// Recurrence: the control for the case above; a fix that refused every
	// deferred wait would lose the server's newest answer.
	it("reports the newest answer when no clear lands", async () => {
		const { client } = await realClient();
		const verdict = await touch(client);

		expect(verdict).toMatchObject({
			confirmation: "confirmed",
			diags: ["STOP-v2"],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
});
