import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
let warmAttached = false;
const tryWarmAttachedDiagnostics = vi.fn();

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));
vi.mock("../../../clients/warm-attach.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/warm-attach.js")>()),
	isWarmAttached: () => warmAttached,
	tryWarmAttachedDiagnostics,
}));

function diagnostic(message: string) {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function makeServer() {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics warm attach sweeps (#822)", () => {
	let tmp: string;

	beforeEach(async () => {
		vi.resetModules();
		(await import("../../../clients/lsp/config.js"))._setServersForFileForTests(
			getServersForFileWithConfig,
		);
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tryWarmAttachedDiagnostics.mockReset();
		warmAttached = true;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-warm-attach-"));
		const server = makeServer();
		getServersForFileWithConfig.mockImplementation((filePath: string) =>
			filePath.endsWith(".ts") ? [server] : [],
		);
	});

	afterEach(() => removeTempDirSync(tmp));

	it("uses incumbent diagnostics without spawning or warming a local client", async () => {
		const files = ["a.ts", "b.ts"].map((name) => path.join(tmp, name));
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => ({
			available: true,
			response: {
				binding: { boundToCurrentDisk: true },
				diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
			},
		}));

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const warmup = vi.spyOn(service, "ensureWarmForSweep");
		const results = await service.runWorkspaceDiagnostics(tmp, { files });

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"attached:b.ts",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledWith(
			files[0],
			"const x = 1;\n",
			15_000,
			"sweep",
		);
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(warmup).not.toHaveBeenCalled();
	});

	// #1470: the sweep's own honesty gate. The incumbent touches with
	// `clientScope: "with-auxiliary"`, so it is the one route into this sweep
	// that can produce a coverage gap today. A partially covered answer must
	// never be persisted as a confirmed clean and replayed on every later sweep.
	//
	// #1549 remapped HOW the gap is carried, not WHETHER it blocks the cache.
	// Before, the gap collapsed the whole file to `timedOut: true`, which also
	// discarded the primary's usable answer. #1470's own "suggested direction"
	// rejects that collapse: a primary that answered stays trustworthy when only
	// an auxiliary was cut off. The gap now rides on `unconfirmedServerIds`, the
	// sweep's cache write requires an empty `unconfirmedServerIds` as well as
	// `!timedOut`, and `timedOut` is reserved for primary-scoped failures. This
	// test asserts the same protection through the new state: the uncovered lane
	// is named on the result, and the file stays out of the cache.
	it("does not cache a sweep result whose auxiliary the incumbent could not cover (#1470)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				binding: { boundToCurrentDisk: true },
				diagnostics: [],
				confirmation: "partial",
				unconfirmedServerIds: ["typos"],
			},
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files: [file],
		});

		expect(results[0]?.unconfirmedServerIds).toEqual(["typos"]);
		const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		expect(
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)],
		).toBeUndefined();
	});

	// #2300 C1 (verify round): `runWorkspaceDiagnostics`'s own `record` call
	// (`clients/lsp/index.ts`) wires `scannedSizeByFile.get(result.filePath)`
	// as the `sizeBytes` argument. A unit test against the cache primitive
	// alone (`workspace-diagnostics-cache.test.ts`) cannot see this wiring —
	// it calls `ctx.record` directly with a hand-supplied size, so neutering
	// the PRODUCTION argument to `undefined` would leave that test green.
	// This drives the real sweep end to end and reads the persisted entry
	// back through the cache's own load API.
	it("persists the swept file's real byte size into the cache entry (#2300)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: { diagnostics: [], binding: { boundToCurrentDisk: true } },
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp, { files: [file] });

		const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)];
		expect(entry?.sizeBytes).toBe(fs.statSync(file).size);
	});

	// #4645: the incumbent sends the server's raw rows and its own answer to the
	// membership probe this process cannot send. The sweep records its rows
	// into the workspace cache, and a later replay in this attached process has
	// no live tsserver to re-ask, so the verdict is applied on receipt and kept
	// in the entry; without it the replay re-cements an inferred-project file as
	// blocking (the #1645 F3 contract). The environment rule stays a render-time
	// rule, so nothing here bakes it.
	it("keeps the incumbent's membership verdict in the swept rows and their cache entry (#4645)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "orphan.ts");
		fs.writeFileSync(file, "export const x: string = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				binding: { boundToCurrentDisk: true },
				diagnostics: [
					{
						...diagnostic("Type 'number' is not assignable to type 'string'."),
						source: "typescript",
						code: 2322,
						serverId: "typescript",
					},
				],
				projectIdentity: { projectKind: "inferred", association: "associated" },
			},
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { INFERRED_PROJECT_MARKER } =
			await import("../../../clients/lsp/inferred-project.js");
		const [result] = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files: [file],
		});

		expect(result?.diagnostics[0]?.severity).toBe(2);
		expect(result?.diagnostics[0]?.message).toContain(INFERRED_PROJECT_MARKER);
		const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)];
		expect(entry?.diagnostics[0]?.severity).toBe(2);
		expect(entry?.diagnostics[0]?.message).toContain(INFERRED_PROJECT_MARKER);
	});

	// #5030: the incumbent's content binding, read by the sweep. Recurrence: the
	// DTO dropped it, so a stale-bound answer (rows about older bytes) was
	// swept in as a result for the current bytes, with no `boundToCurrentDisk`
	// for `lens_diagnostics` to classify it by, and no fingerprint for the
	// workspace cache to gate a replay on. The answer comes from the REAL
	// producer through a JSON round trip. An incumbent built before #5030 sends
	// no binding, and that reads as not current.
	describe("incumbent binding (#5030)", () => {
		const servedAnswer = async (
			file: string,
			incumbentTouch: Record<string, unknown>,
			edit: (response: Record<string, unknown>) => void = () => undefined,
		) => {
			const { installLspServiceDouble } =
				await import("../../support/lsp-service-seam.js");
			await installLspServiceDouble({
				touchFile: vi.fn(async () => incumbentTouch),
			});
			const { _serveWarmRequestForTests } =
				await import("../../../clients/warm-attach.js");
			const { contentHash, WARM_DIAGNOSTICS_SCHEMA_VERSION } =
				await import("../../../clients/mcp/ipc.js");
			const content = fs.readFileSync(file, "utf-8");
			const served = await _serveWarmRequestForTests({
				route: "diagnostics",
				version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
				file,
				cwd: path.dirname(file),
				content,
				contentHash: contentHash(content),
				deadlineAt: Date.now() + 60_000,
			});
			const response = JSON.parse(JSON.stringify(served.result));
			edit(response);
			return { available: true, response };
		};
		const sweepOne = async (
			incumbentTouch: Record<string, unknown>,
			edit?: (response: Record<string, unknown>) => void,
		) => {
			fs.mkdirSync(path.join(tmp, ".pi-lens"), { recursive: true });
			const file = path.join(tmp, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			tryWarmAttachedDiagnostics.mockResolvedValue(
				await servedAnswer(file, incumbentTouch, edit),
			);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const [result] = await new LSPService().runWorkspaceDiagnostics(tmp, {
				files: [file],
			});
			const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
				await import("../../../clients/lsp/workspace-diagnostics-cache.js");
			return {
				bound: result?.boundToCurrentDisk,
				contentHash: result?.contentHash,
				cached: loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)],
			};
		};
		const touch = (binding: Record<string, unknown>) => ({
			diags: [{ ...diagnostic("older bytes"), serverId: "typescript" }],
			confirmation: "confirmed",
			binding,
		});

		it.each([false, true, "unknown"] as const)(
			"reads an incumbent answer bound %s as that verdict and keeps its fingerprint",
			async (bound) => {
				const swept = await sweepOne(
					touch({ contentHash: "fp-of-sent-bytes", boundToCurrentDisk: bound }),
				);

				expect(swept.bound).toBe(bound);
				expect(swept.contentHash).toBe("fp-of-sent-bytes");
				// The fingerprint rides into the cache entry, so a replay is
				// disk-gated exactly like a local touch's.
				expect(swept.cached?.contentHash).toBe("fp-of-sent-bytes");
			},
		);

		it.each([
			["an older incumbent's answer (no binding field)", undefined],
			["a null binding", null],
			["a binding that is not an object", "yes"],
			["a binding with no verdict", {}],
			["a binding with an unrecognised verdict", { boundToCurrentDisk: "yes" }],
		] as const)(
			"reads %s as not current and does not cache it",
			async (_label, wire) => {
				const swept = await sweepOne(
					touch({ boundToCurrentDisk: true }),
					(response) => {
						if (wire === undefined) delete response.binding;
						else response.binding = wire;
					},
				);

				expect(swept.bound).toBe(false);
				// No fingerprint, so a replay could not be disk-gated: the entry
				// would serve the withheld rows as the file's current answer.
				expect(swept.cached).toBeUndefined();
			},
		);
	});

	it("promotes after an IPC failure and completes that file and the remainder locally", async () => {
		const files = ["a.ts", "b.ts", "c.ts"].map((name) => path.join(tmp, name));
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		let attachedCalls = 0;
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => {
			attachedCalls += 1;
			if (attachedCalls === 1) {
				return {
					available: true,
					response: {
						diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
					},
				};
			}
			warmAttached = false;
			return { available: false, reason: "ipc-error" };
		});
		const localDiagnostic = diagnostic("local");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: {
				announceCreated: () => undefined,
				open: vi.fn(async () => {}),
			},
			waitForDiagnostics: vi.fn(async () => undefined),
			getDiagnostics: vi.fn(() => [localDiagnostic]),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files,
		});

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"local",
			"local",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(warmAttached).toBe(false);
	});

	// Recurrence (#4944 review F2): the sweep's exclusion reached only the local
	// touch. A warm incumbent answers every auxiliary, so its ast-grep rows were
	// recorded under a scope key that claimed ast-grep was excluded.
	it("drops a switched-off auxiliary's warm-attached rows and keeps the others (#4944)", async () => {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				binding: { boundToCurrentDisk: true },
				diagnostics: [
					{
						...diagnostic("ts finding"),
						source: "typescript",
						serverId: "typescript",
					},
					{
						...diagnostic("ast-grep finding"),
						source: "ast-grep",
						serverId: "ast-grep",
					},
					// No serverId: mapped through its source.
					{ ...diagnostic("ast-grep sourced finding"), source: "ast-grep" },
				],
			},
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const [result] = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files: [file],
			excludeServerIds: new Set(["ast-grep"]),
		});

		expect(result?.diagnostics.map((d) => d.message)).toEqual(["ts finding"]);
	});

	// Recurrence (#4947 r2 verify N1): the receipt dropped a switched-off
	// server's rows but kept its id in the incumbent's coverage gap, so the
	// sweep reported "ast-grep did not answer" for a scanner it never asked, and
	// never cached the file. The #584 baseline (opengrep) is the same shape.
	it("drops a switched-off auxiliary from the incumbent's coverage gap and keeps the others (#4944)", async () => {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				binding: { boundToCurrentDisk: true },
				diagnostics: [],
				confirmation: "partial",
				unconfirmedServerIds: ["ast-grep", "opengrep", "typos"],
			},
		});
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const gap = async (excludeServerIds?: ReadonlySet<string>) =>
			(
				await new LSPService().runWorkspaceDiagnostics(tmp, {
					files: [file],
					...(excludeServerIds && { excludeServerIds }),
				})
			)[0]?.unconfirmedServerIds;

		// The control: with nothing switched off only the #584 baseline goes.
		expect(await gap()).toEqual(["ast-grep", "typos"]);
		expect(await gap(new Set(["ast-grep"]))).toEqual(["typos"]);
	});

	// Recurrence (#4944 review F3): removing the caller's ids from the sweep's
	// scope key survived every test, so an entry swept with ast-grep on could be
	// replayed to a sweep with it switched off. The entry is seeded under the key
	// a sweep with no exclusion writes, as the cache's other suites do.
	it("does not replay a sweep's cached entry to a sweep with another exclusion set (#4944)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		const cache =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const session =
			await import("../../../clients/lsp/workspace-diagnostics-session.js");
		// Inside the session and the age ceiling, so only the key decides.
		session.resetWorkspaceDiagnosticsCacheSession(Date.now() - 60 * 60_000);
		cache.saveWorkspaceDiagnosticsCache(tmp, {
			version: cache.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cache.cacheKeyFor(file)]: {
					diagnostics: [
						{
							...diagnostic("cached ast-grep finding"),
							severity: 1 as const,
							source: "ast-grep",
							serverId: "ast-grep",
						},
					],
					count: 1,
					mtimeMs: fs.statSync(file).mtimeMs,
					scannedAt: Date.now() - 60_000,
					scopeKey: cache.buildScopeKey("all", ["opengrep"]),
				},
			},
		});
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: { diagnostics: [], binding: { boundToCurrentDisk: true } },
		});
		const { LSPService } = await import("../../../clients/lsp/index.js");

		// No `files` option: a scoped sweep has no dependency claim for the entry.
		// The control: the same exclusion set is served from the cache.
		const [on] = await new LSPService().runWorkspaceDiagnostics(tmp);
		expect(on?.diagnostics.map((d) => d.message)).toEqual([
			"cached ast-grep finding",
		]);
		expect(tryWarmAttachedDiagnostics).not.toHaveBeenCalled();

		const [off] = await new LSPService().runWorkspaceDiagnostics(tmp, {
			excludeServerIds: new Set(["ast-grep"]),
		});
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(1);
		expect(off?.diagnostics).toEqual([]);
	});
});
