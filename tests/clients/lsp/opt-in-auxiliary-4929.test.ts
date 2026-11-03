// flake-shape: in-process-mock — the child launcher (clients/lsp/launch) and the JSON-RPC transport (clients/lsp/client) are the process boundary and the installer (clients/installer) the network boundary; the registry, the config selection, the file-to-server match, the project-trust gate and LSPService acquisition are real
// flake-shape: service-double — the client handed back by the transport double stands in for a running language server; the acquisition under test (which ids start, and whether an untrusted project may) is real, and the real-server proof is the PR's verify-pi-lens scenario
/**
 * #4929: fallow-lsp, the first OPT-IN, LANGUAGE-SCOPED auxiliary server.
 *
 * REAL registry, REAL config selection and REAL LSPService acquisition; only
 * the two external boundaries are doubled, the child launcher
 * (`clients/lsp/launch.js`) and the JSON-RPC transport (`clients/lsp/client.js`),
 * as in docker-official-fallback.test.ts. The real-server proof (a fallow
 * diagnostic through the production touch path) is the PR's probe, not a mock.
 *
 * Recurrences named per case:
 *  - scope: an auxiliary row whose extensions widen past its language would
 *    start the JS/TS analyzer on every Python or Markdown file (the shipped
 *    cross-cutting auxiliaries attach everywhere, so a copy-paste row would).
 *  - aggregate door: `clientScope: "all"` takes its exclusions from the caller;
 *    a caller with no flag access (`tools/lsp-diagnostics.ts` without
 *    `getFlag`) started every auxiliary, which for an opt-in server means a
 *    download and a process the operator never asked for.
 *  - trust: an untrusted project must neither launch nor install the server.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launchMock = vi.hoisted(() => vi.fn());
const createLSPClientMock = vi.hoisted(() => vi.fn());
const findManagedToolBinaryMock = vi.hoisted(() => vi.fn());
const ensureToolMock = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP: launchMock,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	findManagedToolBinary: findManagedToolBinaryMock,
	ensureTool: ensureToolMock,
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient: createLSPClientMock,
}));

function toolNotFound() {
	return Object.assign(new Error("ENOENT: command not found"), {
		kind: "tool-not-found" as const,
	});
}

function fakeProcess() {
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
		pid: 4242,
		command: "test",
		args: [] as string[],
	};
}

function makeClient(serverId: string) {
	return {
		serverId,
		root: "/proj",
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => false),
		wasShutdownIntentional: vi.fn(() => true),
		shutdown: vi.fn(async () => undefined),
		getProcessPid: () => 4242,
		recentStderr: () => "",
		checkAlive: () => undefined,
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
			announceCreated: vi.fn(),
		},
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getTrackedDiagnosticPaths: vi.fn(() => []),
		pruneDiagnostics: vi.fn(() => 0),
		getDiagnosticBinding: vi.fn(() => undefined),
		diagnosticsVersion: 1,
		getDiagnosticsVersionForPath: vi.fn(() => 1),
		waitForDiagnostics: vi.fn(async () => undefined),
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "unavailable" as const,
		})),
		getOperationSupport: vi.fn(() => ({})),
		getMalformedFileOperationRegistrations: () => new Set(),
	};
}

const TS_FILE = "/proj/src/a.ts";

function launchedCommands(): string[] {
	return launchMock.mock.calls.map(([command]) => String(command));
}

beforeEach(() => {
	launchMock.mockReset();
	createLSPClientMock.mockReset();
	findManagedToolBinaryMock.mockReset();
	ensureToolMock.mockReset();
	findManagedToolBinaryMock.mockResolvedValue(undefined);
	ensureToolMock.mockResolvedValue(false);
	// Every binary is "installed": the launcher double succeeds for any command.
	launchMock.mockImplementation(async () => fakeProcess());
	createLSPClientMock.mockImplementation(async (args: { serverId: string }) =>
		makeClient(args.serverId),
	);
	vi.stubEnv("PI_LENS_DISABLE_LSP_INSTALL", undefined);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	const { resetSessionRootsForTests } =
		await import("../../../clients/lsp/session-roots.js");
	resetSessionRootsForTests();
	const { resetProjectTrust } =
		await import("../../../clients/project-trust.js");
	resetProjectTrust();
});

describe("fallow language scope: beside the primary, never in its place (#4929)", () => {
	const SCOPED = [
		"/proj/a.ts",
		"/proj/a.tsx",
		"/proj/a.mts",
		"/proj/a.cts",
		"/proj/a.js",
		"/proj/a.jsx",
		"/proj/a.mjs",
		"/proj/a.cjs",
	];
	const UNSCOPED = [
		"/proj/a.py",
		"/proj/a.go",
		"/proj/a.rs",
		"/proj/README.md",
		"/proj/ci.yml",
		"/proj/data.json",
		"/proj/style.css",
		"/proj/App.vue",
		"/proj/App.svelte",
		"/proj/Dockerfile",
	];

	it.each(SCOPED)(
		"%s attaches fallow as an auxiliary beside typescript",
		async (file) => {
			const { getServersForFileWithConfig, primaryServerId } =
				await import("../../../clients/lsp/config.js");
			const servers = getServersForFileWithConfig(file);
			expect(servers.map((s) => s.id)).toContain("fallow");
			// The primary is the language server, and fallow is not it.
			expect(primaryServerId(file)).toBe("typescript");
			expect(servers.find((s) => s.id === "fallow")?.role).toBe("auxiliary");
		},
	);

	it.each(UNSCOPED)("%s never attaches fallow", async (file) => {
		const { getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
		expect(getServersForFileWithConfig(file).map((s) => s.id)).not.toContain(
			"fallow",
		);
	});

	it("a non-JS/TS file asked for fallow by id still launches nothing", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const spawned = await service.getAuxiliaryClientsForFile(
			"/proj/src/a.py",
			new Set(["fallow"]),
		);
		expect(spawned).toEqual([]);
		expect(launchedCommands()).not.toContain("fallow-lsp");
		await service.shutdown();
	});
});

describe("fallow opt-in doors (#4929)", () => {
	it("the aggregate all-server door never starts it, with or without exclusions", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const { clients } = await service.getClientsForFile(TS_FILE);
		// Positive control: the door is not vacuous, a default-on auxiliary starts.
		expect(clients.map((entry) => entry.info.id)).toContain("typos");
		expect(clients.map((entry) => entry.info.id)).not.toContain("fallow");
		expect(launchedCommands()).not.toContain("fallow-lsp");
		expect(ensureToolMock).not.toHaveBeenCalledWith("fallow-lsp");
		await service.shutdown();
	});

	it("the with-auxiliary door starts it only for an id on its enabled list", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const withoutIt = await service.getAuxiliaryClientsForFile(
			TS_FILE,
			new Set(["typos"]),
		);
		expect(withoutIt.map((entry) => entry.info.id)).toEqual(["typos"]);
		expect(launchedCommands()).not.toContain("fallow-lsp");

		const withIt = await service.getAuxiliaryClientsForFile(
			TS_FILE,
			new Set(["fallow"]),
		);
		expect(withIt.map((entry) => entry.info.id)).toEqual(["fallow"]);
		// Spawned as the bare stdio server: no subcommand, no flags.
		const call = launchMock.mock.calls.find(
			([command]) => String(command) === "fallow-lsp",
		);
		expect(call?.[1]).toEqual([]);
		await service.shutdown();
	});
});

describe("fallow launch and install go through the project-trust seam (#4929)", () => {
	it("an untrusted project launches nothing and installs nothing", async () => {
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		// The server is not on PATH, so a trusted run would reach the installer.
		launchMock.mockImplementation(async () => {
			throw toolNotFound();
		});
		setProjectTrustState("untrusted");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const spawned = await service.getAuxiliaryClientsForFile(
			TS_FILE,
			new Set(["fallow"]),
		);
		expect(spawned).toEqual([]);
		expect(launchedCommands()).not.toContain("fallow-lsp");
		expect(ensureToolMock).not.toHaveBeenCalled();
		await service.shutdown();
	});

	it("a trusted project that lacks the binary reaches the installer for fallow-lsp", async () => {
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		launchMock.mockImplementation(async () => {
			throw toolNotFound();
		});
		setProjectTrustState("trusted");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.getAuxiliaryClientsForFile(TS_FILE, new Set(["fallow"]));
		expect(ensureToolMock).toHaveBeenCalledWith("fallow-lsp");
		await service.shutdown();
	});
});

/**
 * #4956 F1. Recurrence: fallow joined every JS/TS candidate list whether or not
 * the operator turned it on, and eight per-file readers resolve a root per
 * listed server (a `NearestRoot` walk whose negatives are never cached), so a
 * default-off server cost every user a walk per touch (+0.3 ms/file in a git
 * repo, +2.1 ms/file with no .git). The shipped workaround, listing fallow in
 * the head-move fixture's `disabledServers`, hid the cost instead of removing it.
 */
describe("a default-off fallow adds no per-file root resolution (#4956 F1)", () => {
	type RegistryProbe = {
		clientRegistry: {
			resolveServerRoot: (
				server: { id: string },
				filePath: string,
			) => Promise<string | undefined>;
		};
	};
	type Service = InstanceType<
		typeof import("../../../clients/lsp/index.js").LSPService
	>;

	async function watch() {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
		const service = new LSPService();
		const resolved: string[] = [];
		const registry = (service as unknown as RegistryProbe).clientRegistry;
		const original = registry.resolveServerRoot.bind(registry);
		registry.resolveServerRoot = (server, filePath) => {
			resolved.push(server.id);
			return original(server, filePath);
		};
		const row = getServersForFileWithConfig(TS_FILE).find(
			(server) => server.id === "fallow",
		)!;
		const rootWalks: string[] = [];
		const originalRoot = row.root.bind(row);
		vi.spyOn(row, "root").mockImplementation((filePath: string) => {
			rootWalks.push(filePath);
			return originalRoot(filePath);
		});
		return { service, resolved, rootWalks };
	}

	async function runReaders(service: Service) {
		await service.getWarmClientForFile(TS_FILE);
		await service.notifyExternalFileChange(TS_FILE, 2);
		await service.executeReadOnlyCommandOnLiveClient(TS_FILE, "noop");
		await service.getCapabilitySnapshots(TS_FILE);
		await service.resyncGitChangedFiles([TS_FILE]);
		// The touch path: announceToSiblings and the outside-root decision.
		await service.touchFile(TS_FILE, "export const a = 1;\n", {
			diagnostics: "none",
		});
		await service.getDiagnostics(TS_FILE);
		// #4956 F6: the all-server door of a content sync (drift resync, open
		// import touch) may reach a held opt-in client, so it lists servers
		// through the same live-client gate; with none held it walks nothing.
		await service.touchFile(TS_FILE, "export const a = 2;\n", {
			diagnostics: "none",
			clientScope: "all",
		});
		// The unheld-document filter (the head-move and full-sweep touches) is
		// private and reached only with live documents, so it is called directly.
		await (
			service as unknown as {
				serverIdsNotHoldingDocument(file: string): Promise<Set<string>>;
			}
		).serverIdsNotHoldingDocument(TS_FILE);
	}

	it("no reader resolves a fallow root while the service holds no fallow client", async () => {
		const { service, resolved, rootWalks } = await watch();
		await runReaders(service);
		// Positive control: the readers ran and resolved the other servers.
		expect(resolved).toContain("typescript");
		expect(resolved).not.toContain("fallow");
		expect(rootWalks).toEqual([]);
		await service.shutdown();
	});

	it("the outside-root decision does not walk fallow for a file outside every session root", async () => {
		const { registerSessionRoot } =
			await import("../../../clients/lsp/session-roots.js");
		registerSessionRoot("/proj");
		const { service, rootWalks } = await watch();
		await service.getDiagnostics("/elsewhere/src/a.ts");
		expect(rootWalks).toEqual([]);
		await service.shutdown();
	});

	it("the readers walk fallow again once the service holds its client", async () => {
		const { service, resolved } = await watch();
		const started = await service.getAuxiliaryClientsForFile(
			TS_FILE,
			new Set(["fallow"]),
		);
		expect(started.map((entry) => entry.info.id)).toEqual(["fallow"]);
		resolved.length = 0;
		const warm = await service.getWarmClientForFile(TS_FILE);
		expect(warm?.info.id).toBe("fallow");
		expect(resolved).toContain("fallow");
		await service.shutdown();
	});

	/**
	 * #4956 F5. Recurrence: `skippedAuxiliaryServerIds` listed every unattached
	 * auxiliary of a collecting all-server touch, fallow included, and resolved
	 * its root to check the breaker, so the real sweep walked the default-off
	 * root once per swept file (verify probe: 6 files, 6 walks; master 0), up
	 * to the 5000-file cap. That door never admits fallow, so it is no gap.
	 */
	it("the real workspace sweep never walks a default-off fallow root", async () => {
		const { service, resolved, rootWalks } = await watch();
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-lens-4956-f5-"));
		try {
			writeFileSync(path.join(root, "package.json"), '{"name":"f5"}\n');
			const files = [0, 1, 2, 3].map((i) => {
				const file = path.join(root, `f${i}.ts`);
				writeFileSync(file, `export const v${i} = ${i};\n`);
				return file;
			});
			const results = await service.runWorkspaceDiagnostics(root, { files });
			// Positive control: the sweep touched every file through the primary.
			expect(results).toHaveLength(files.length);
			expect(resolved).toContain("typescript");
			expect(resolved.filter((id) => id === "fallow")).toEqual([]);
			expect(rootWalks).toEqual([]);
			expect(launchedCommands()).not.toContain("fallow-lsp");
		} finally {
			await service.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the collecting all-server door leaves even a held fallow client out", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const held = await service.getAuxiliaryClientsForFile(
			TS_FILE,
			new Set(["fallow"]),
		);
		expect(held.map((entry) => entry.info.id)).toEqual(["fallow"]);
		// The door every collecting check uses (`getDiagnostics`, the sweep's
		// per-file touch, `lsp_diagnostics`): it never names fallow, so a warm
		// client must not make its answer depend on an earlier edit.
		const { clients } = await service.getClientsForFile(TS_FILE);
		// Positive control: the door is not vacuous, a default-on auxiliary is in.
		expect(clients.map((entry) => entry.info.id)).toContain("typos");
		expect(clients.map((entry) => entry.info.id)).not.toContain("fallow");
		await service.shutdown();
	});

	it("the workspace sweep does not count it as a second server", async () => {
		const { groupFilesByPrimaryServer } =
			await import("../../../clients/lsp/grouping.js");
		const { _setServersForFileForTests, getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
		const both = getServersForFileWithConfig(TS_FILE).filter(
			(s) => s.id === "typescript" || s.id === "fallow",
		);
		expect(both.map((s) => s.id).sort()).toEqual(["fallow", "typescript"]);
		// Only these two are candidates: fallow is the one that could split a group.
		_setServersForFileForTests(() => both);
		try {
			expect(groupFilesByPrimaryServer([TS_FILE])).toEqual([
				{ files: [TS_FILE], multiServer: false },
			]);
		} finally {
			_setServersForFileForTests(undefined);
		}
	});
});
