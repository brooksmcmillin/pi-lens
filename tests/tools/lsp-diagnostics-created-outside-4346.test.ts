/**
 * #4346: a module created outside pi-lens (a shell, `cp`, codegen) reached no
 * language server, because no tool result names it. A server that caches a
 * failed lookup (Pyrefly and pyright, measured) kept the importer's missing
 * import for its whole life when only the importer was diagnosed. A workspace
 * edit's resource operations (create, rename, delete) sent no watched-files
 * event either.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, LSPService, client and
 * workspace edit applier over a stdio JSON-RPC wire. The server is the shared
 * fake in its stale-lookup profile, configured as the project's server for
 * `.ts` files (the built-in one disabled), for `import "./name"` lines that
 * resolve to `name.ts`, which the review graph's extraction also reads.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4346-outside-");
const workspace = env.tmpDir;
const trace = path.join(workspace, "server.trace");

async function diagnose(
	args: { paths: string[] } | { path: string },
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4346",
		{ ...args, serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

/** #4346: how many documents the server was sent for `file` (open or change);
 * a cached answer sends none. */
function touchesOf(file: string): number {
	if (!fs.existsSync(trace)) return 0;
	const uri = pathToFileURL(file).href;
	return fs
		.readFileSync(trace, "utf8")
		.split("\n")
		.filter(
			(line) =>
				line === `recv textDocument/didOpen ${uri}` ||
				line === `recv textDocument/didChange ${uri}`,
		).length;
}

/**
 * #4346: when `file`'s persisted cache entry was scanned. A served entry keeps
 * it; a refused one is answered by the server and recorded again. A touch
 * count cannot show a refusal of a clean entry: the client sends nothing for
 * an open document whose bytes did not change.
 */
async function scannedAtOf(file: string): Promise<number | undefined> {
	const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
		await import("../../clients/lsp/workspace-diagnostics-cache.js");
	return loadWorkspaceDiagnosticsCache(workspace)?.entries[cacheKeyFor(file)]
		?.scannedAt;
}

function watchedLines(): string[] {
	if (!fs.existsSync(trace)) return [];
	return fs
		.readFileSync(trace, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("watched "));
}

/**
 * Diagnose a file no call has seen: the batch first sends any waiting Created
 * (`announceCreatedFiles` flushes the watch queue), and the touch is a round
 * trip to the server, which writes its trace line before it answers (stdio
 * keeps the order). So the trace is complete for every event sent before.
 */
let roundTrips = 0;
async function roundTrip(): Promise<void> {
	const probe = path.join(workspace, `round_trip_${roundTrips++}.ts`);
	fs.writeFileSync(probe, "export {};\n");
	await diagnose({ paths: [probe] });
}

let service: { shutdown: () => Promise<void> } | undefined;

beforeAll(async () => {
	// Host-boundary stub: a project-configured server needs pi's trust (#4248).
	setProjectTrustState("trusted");
	const shim = path.join(workspace, "stale-lookup-server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_EXT = ".ts";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	// #4346: the same profile for Go files, `import "./name"` resolving to
	// `name.go`, in a server of its own, as gopls is.
	const goShim = path.join(workspace, "stale-go-server.mjs");
	fs.writeFileSync(
		goShim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_EXT = ".go";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"outside","version":"0.0.0"}\n',
	);
	// Born before any server starts: an existing module, never Created.
	fs.writeFileSync(path.join(workspace, "old_module.ts"), "export {};\n");
	// Row 13: a module whose inode is older than the server, moved into place
	// later. `mv` keeps the inode and its birth time.
	fs.mkdirSync(path.join(workspace, "stash"));
	fs.writeFileSync(
		path.join(workspace, "stash", "moved_module.ts"),
		"export {};\n",
	);
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				"stale-ts": {
					name: "stale lookup server",
					extensions: [".ts", ".js"],
					command: process.execPath,
					args: [shim],
					rootMarkers: ["package.json"],
				},
				"stale-go": {
					name: "stale lookup server for Go",
					extensions: [".go"],
					command: process.execPath,
					args: [goShim],
					rootMarkers: ["package.json"],
				},
			},
			disabledServers: [
				"typescript",
				"deno",
				"go",
				"opengrep",
				"ast-grep",
				"typos",
			],
		}),
	);
	// Older than the client, which starts at the first diagnostics call.
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const lsp = await import("../../clients/lsp/index.js");
	service = lsp.getLSPService();
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained("pi-lens-4346-outside-", {
		beforeDrain: async () => {
			await service?.shutdown();
		},
	});
	resetProjectTrust();
});

describe("a module created outside pi-lens (#4346)", () => {
	it("clears the importer when only the importer is diagnosed after the module appears", async () => {
		const importer = path.join(workspace, "batch_user.ts");
		fs.writeFileSync(importer, 'import "./batch_module";\nexport {};\n');
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(1);

		// Outside pi-lens: no tool result, no pi write, no open of the module.
		const created = path.join(workspace, "batch_module.ts");
		fs.writeFileSync(created, "export {};\n");
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module batch_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);
	}, 30_000);

	it("clears the importer on the single-file route too", async () => {
		const importer = path.join(workspace, "scalar_user.ts");
		fs.writeFileSync(importer, 'import "./scalar_module";\nexport {};\n');
		expect((await diagnose({ path: importer })).text).toContain(
			"Cannot find module scalar_module",
		);

		fs.writeFileSync(path.join(workspace, "scalar_module.ts"), "export {};\n");
		const after = await diagnose({ path: importer });

		expect(after.text).not.toContain("Cannot find module scalar_module");
	}, 30_000);

	// Row 3b: codegen writes a gitignored module the sweep never lists, so
	// only the importer names it.
	it("clears the importer in a workspace sweep when the module is gitignored", async () => {
		fs.writeFileSync(path.join(workspace, ".gitignore"), "gen/\n");
		const importer = path.join(workspace, "swept_user.ts");
		fs.writeFileSync(importer, 'import "./gen/swept_gen";\nexport {};\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === importer)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		// The importer is itself new: its first open sent Created, which drops
		// the first sweep's entry. The second records the entry under test.
		expect(await sweep()).toBe(1);

		fs.mkdirSync(path.join(workspace, "gen"));
		fs.writeFileSync(
			path.join(workspace, "gen", "swept_gen.ts"),
			"export {};\n",
		);

		expect(await sweep()).toBe(0);
	}, 60_000);

	// Recurrence: #4368 r1 F1. pi's write hook touches the importer without
	// recording a cache entry, so a gate on cached findings skipped it, and the
	// first batch call after the module appeared replayed the server's stale
	// lookup (the single-file route already cleared on its first call).
	it("clears an importer pi's write hook touched, on the first batch call", async () => {
		const lsp = service as unknown as {
			touchFile: (
				filePath: string,
				content: string,
				options: { diagnostics: "document"; source: string },
			) => Promise<unknown>;
		};
		const importer = path.join(workspace, "hook_user.ts");
		const content = 'import "./hook_module";\nexport {};\n';
		fs.writeFileSync(importer, content);
		await lsp.touchFile(importer, content, {
			diagnostics: "document",
			source: "write-hook-4368",
		});

		fs.writeFileSync(path.join(workspace, "hook_module.ts"), "export {};\n");
		const first = await diagnose({ paths: [importer] });

		expect(first.text).not.toContain("Cannot find module hook_module");
		expect(first.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// Recurrence: #4368 r1 F1, the binding half of "a fresh clean entry". A
	// rewrite that keeps the size and mtime passes the stat check, and only
	// the content binding shows the bytes changed: the new import must still
	// be resolved, or the server's stale lookup for it is served on the
	// re-touch.
	it("resolves an importer whose clean entry no longer matches its bytes", async () => {
		fs.writeFileSync(path.join(workspace, "bind_a.ts"), "export {};\n");
		const importer = path.join(workspace, "bind_user.ts");
		fs.writeFileSync(importer, 'import "./bind_a";\nexport {};\n');
		// Whole seconds, so restoring the mtime later is exact.
		const pinned = Math.floor(Date.now() / 1000) - 30;
		fs.utimesSync(importer, pinned, pinned);
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(0);
		const { mtimeMs } = fs.statSync(importer);
		// The server learns that bind_b is missing through another file.
		const other = path.join(workspace, "bind_other.ts");
		fs.writeFileSync(other, 'import "./bind_b";\nexport {};\n');
		expect((await diagnose({ paths: [other] })).text).toContain(
			"Cannot find module bind_b",
		);

		fs.writeFileSync(path.join(workspace, "bind_b.ts"), "export {};\n");
		fs.writeFileSync(importer, 'import "./bind_b";\nexport {};\n');
		fs.utimesSync(importer, pinned, pinned);
		// Precondition: the stat check cannot see the rewrite.
		expect(fs.statSync(importer).mtimeMs).toBe(mtimeMs);
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module bind_b");
	}, 30_000);

	// Recurrence: #4368 r1 row 13. A module moved in with `mv` keeps its old
	// inode birth, so the birth rule sent Changed and the importer stayed stale
	// for the server's life. The resolver saw the import unresolved, then
	// resolved: the path appeared in between.
	it("announces a module moved in with an old inode as Created", async () => {
		const importer = path.join(workspace, "moved_user.ts");
		fs.writeFileSync(importer, 'import "./moved_module";\nexport {};\n');
		expect((await diagnose({ paths: [importer] })).text).toContain(
			"Cannot find module moved_module",
		);

		const moved = path.join(workspace, "moved_module.ts");
		fs.renameSync(path.join(workspace, "stash", "moved_module.ts"), moved);
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module moved_module");
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 1`);
	}, 30_000);

	it("announces no module born before the server started", async () => {
		const importer = path.join(workspace, "old_user.ts");
		fs.writeFileSync(
			importer,
			'import "./old_module";\nimport "./never_module";\nexport {};\n',
		);
		const first = await diagnose({ paths: [importer] });
		// The import that never resolves keeps reporting.
		expect(first.text).toContain("Cannot find module never_module");
		await diagnose({ paths: [importer] });

		const oldUri = pathToFileURL(path.join(workspace, "old_module.ts")).href;
		expect(watchedLines()).not.toContain(`watched ${oldUri} 1`);
	}, 30_000);
});

describe("cache entries past a creation: the dependency scope (#4346)", () => {
	/** Diagnose `file` until its answer is served from the cache. */
	async function cached(file: string): Promise<number | undefined> {
		await diagnose({ paths: [file] });
		// The first call's Created (the file itself, its Go package peers) may
		// be flushed after its scan began, which refuses that entry once; the
		// second call records one past every creation.
		await diagnose({ paths: [file] });
		const touches = touchesOf(file);
		const scannedAt = await scannedAtOf(file);
		await diagnose({ paths: [file] });
		// Precondition: the second call replayed the entry.
		expect(touchesOf(file)).toBe(touches);
		expect(scannedAt).toBeGreaterThan(0);
		expect(await scannedAtOf(file)).toBe(scannedAt);
		return scannedAt;
	}

	// Acceptance item 4. Recurrence: #4320/#4344 refused every finding entry of
	// a server under a root on any Created there, so one new module re-touched
	// every finding file. A created file outside an entry's scope cannot change
	// its answer.
	it("serves a cached finding past a creation outside its dependency scope", async () => {
		const user = path.join(workspace, "scope_user.ts");
		fs.writeFileSync(user, 'import "./scope_never";\nexport {};\n');
		const scannedAt = await cached(user);
		const touches = touchesOf(user);

		const other = path.join(workspace, "scope_other.ts");
		fs.writeFileSync(other, "export const other = 1;\n");
		const after = await diagnose({ paths: [other, user] });

		expect(watchedLines()).toContain(`watched ${pathToFileURL(other).href} 1`);
		expect(touchesOf(user)).toBe(touches);
		expect(await scannedAtOf(user)).toBe(scannedAt);
		expect(after.text).toContain("Cannot find module scope_never");
	}, 30_000);

	// Rows F1 and F2 on the batch route. Recurrence: #4430 r1 review F1/F2.
	// The import query captures import and export statements only, so a
	// dependency held another way was neither a target nor unresolved; the
	// scope looked complete and the finding was served past the dependency's
	// creation (base refused it). Each file's finding is its `import "./*_never"`
	// line; the created module is the one the other form names. Recurrence
	// also: #4430 r2 verify V1, a JSDoc `@import` in a checkJs file and a
	// relative module augmentation, both served stale on real tsserver.
	it.each([
		[
			"a dynamic import",
			"dynf",
			'export const f = () => import("./dynf_mod");\n',
			undefined,
			".ts",
		],
		[
			"a type-position import",
			"typf",
			'export let t: import("./typf_mod").T;\n',
			undefined,
			".ts",
		],
		[
			"an import = require",
			"reqf",
			'import m = require("./reqf_mod");\nexport { m };\n',
			undefined,
			".ts",
		],
		[
			"a target that re-exports",
			"reexf",
			'import "./reexf_a";\n',
			'export * from "./reexf_mod";\n',
			".ts",
		],
		[
			"a JSDoc @import",
			"jsdf",
			'/** @import { T } from "./jsdf_mod" */\n/** @type {T} */\nexport const t = 1;\n',
			undefined,
			".js",
		],
		[
			"a module augmentation",
			"augf",
			'declare module "./augf_mod" {\n\tinterface A { x: number }\n}\nexport {};\n',
			undefined,
			".ts",
		],
	])(
		"refuses a cached finding when %s names the created module",
		async (_shape, stem, rest, reexporter, ext) => {
			if (reexporter) {
				fs.writeFileSync(path.join(workspace, `${stem}_a.ts`), reexporter);
			}
			const user = path.join(workspace, `${stem}_user${ext}`);
			fs.writeFileSync(user, `import "./${stem}_never";\n${rest}`);
			const scannedAt = await cached(user);

			const created = path.join(workspace, `${stem}_mod.ts`);
			fs.writeFileSync(created, "export const T = 1;\n");
			await diagnose({ paths: [created, user] });

			expect(watchedLines()).toContain(
				`watched ${pathToFileURL(created).href} 1`,
			);
			expect(await scannedAtOf(user)).toBeGreaterThan(scannedAt ?? Infinity);
		},
		30_000,
	);

	// #4438: the cases above name the created module in the call. When only
	// the importer is named, the producer's import query had to capture the
	// dynamic `import()` itself: it captured statements only, so a target a
	// shell created was never announced, no creation record existed, and the
	// finding was served past the module's creation.
	it("announces a dynamic-import target created outside pi-lens and refuses the finding", async () => {
		const user = path.join(workspace, "dyno_user.ts");
		fs.writeFileSync(
			user,
			'import "./dyno_never";\nexport const f = () => import("./dyno_mod");\n',
		);
		const scannedAt = await cached(user);

		const created = path.join(workspace, "dyno_mod.ts");
		fs.writeFileSync(created, "export const T = 1;\n");
		await diagnose({ paths: [user] });

		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);
		expect(await scannedAtOf(user)).toBeGreaterThan(scannedAt ?? Infinity);
	}, 30_000);

	// Row 11. Recurrence: #4368 r1 probe, a TypeScript ambient declaration
	// answers a name in a file that never imports it, so no edge exists, and a
	// clean entry was never refused on a creation: a new global that collides
	// with the file's own was served as clean.
	it("refuses a clean entry when an ambient declaration file appears", async () => {
		const user = path.join(workspace, "ambient_user.ts");
		fs.writeFileSync(user, "export const ambientUser = 1;\n");
		const scannedAt = await cached(user);

		const globals = path.join(workspace, "ambient_globals.d.ts");
		fs.writeFileSync(globals, "declare const AMBIENT: number;\n");
		await diagnose({ paths: [globals, user] });

		expect(await scannedAtOf(user)).toBeGreaterThan(scannedAt ?? Infinity);
	}, 30_000);

	// Row 12. Recurrence: #4368 r1 row 11, a Go file uses its package's files
	// with no import, so the producer, which resolves imports, never announced
	// one created outside pi-lens, and the server kept its failed lookup.
	it("announces a Go file created beside a diagnosed one, which clears its stale lookup", async () => {
		const dir = path.join(workspace, "gopkg");
		fs.mkdirSync(dir, { recursive: true });
		const user = path.join(dir, "user.go");
		fs.writeFileSync(user, 'package gopkg\nimport "./peer"\n');
		expect((await diagnose({ paths: [user] })).text).toContain(
			"Cannot find module peer",
		);

		const peer = path.join(dir, "peer.go");
		fs.writeFileSync(peer, "package gopkg\n");
		const after = await diagnose({ paths: [user] });

		expect(watchedLines()).toContain(`watched ${pathToFileURL(peer).href} 1`);
		expect(after.text).not.toContain("Cannot find module peer");
	}, 30_000);

	it("announces a Go file created beside one on the single-file route", async () => {
		const dir = path.join(workspace, "goscalar");
		fs.mkdirSync(dir, { recursive: true });
		const user = path.join(dir, "user.go");
		fs.writeFileSync(user, 'package goscalar\nimport "./peer"\n');
		expect((await diagnose({ path: user })).text).toContain(
			"Cannot find module peer",
		);

		const peer = path.join(dir, "peer.go");
		fs.writeFileSync(peer, "package goscalar\n");
		const after = await diagnose({ path: user });

		expect(watchedLines()).toContain(`watched ${pathToFileURL(peer).href} 1`);
		expect(after.text).not.toContain("Cannot find module peer");
	}, 30_000);

	// Acceptance item 4 on the sweep's route: its producer call hands each
	// resolved file's imports to the cache as the batch's does. Recurrence:
	// without them a swept finding's scope is unknown, and every creation in
	// the workspace refuses it.
	it("serves a swept finding past a creation outside its dependency scope", async () => {
		const user = path.join(workspace, "sweep_scope_user.ts");
		fs.writeFileSync(user, 'import "./sweep_scope_never";\nexport {};\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === user)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		expect(await sweep()).toBe(1);
		const scannedAt = await scannedAtOf(user);
		expect(scannedAt).toBeGreaterThan(0);

		fs.writeFileSync(
			path.join(workspace, "sweep_scope_other.ts"),
			"export const other = 1;\n",
		);

		expect(await sweep()).toBe(1);
		expect(await scannedAtOf(user)).toBe(scannedAt);
	}, 60_000);

	// The sweep lists every Go file it diagnoses, so only a peer it skips (a
	// gitignored generated file) needs the package pass. Recurrence: the
	// sweep's producer call, like the batch's, announced import targets only.
	it("announces a gitignored Go peer in a workspace sweep", async () => {
		fs.appendFileSync(path.join(workspace, ".gitignore"), "*_gen.go\n");
		const dir = path.join(workspace, "gosweep");
		fs.mkdirSync(dir);
		const user = path.join(dir, "user.go");
		fs.writeFileSync(user, 'package gosweep\nimport "./peer_gen"\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === user)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		expect(await sweep()).toBe(1);

		const peer = path.join(dir, "peer_gen.go");
		fs.writeFileSync(peer, "package gosweep\n");

		expect(await sweep()).toBe(0);
		expect(watchedLines()).toContain(`watched ${pathToFileURL(peer).href} 1`);
	}, 60_000);

	// Row E2. Recurrence: a Go file's package files are named by no import,
	// so an edit to one left the file's clean entry serving.
	it("refuses a Go file's clean entry when a file of its package changes", async () => {
		const dir = path.join(workspace, "gochange");
		fs.mkdirSync(dir, { recursive: true });
		const peer = path.join(dir, "peer.go");
		fs.writeFileSync(peer, "package gochange\n");
		const user = path.join(dir, "user.go");
		fs.writeFileSync(user, "package gochange\n");
		const scannedAt = await cached(user);

		fs.appendFileSync(peer, "// edited\n");
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(peer, later, later);
		await diagnose({ paths: [user] });

		expect(await scannedAtOf(user)).toBeGreaterThan(scannedAt ?? Infinity);
	}, 30_000);
});

describe("a workspace edit's resource operations (#4346)", () => {
	it("sends Created, Deleted, and the rename pair the moment they reach disk", async () => {
		const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
		// A live client must exist for the events to reach a server.
		await roundTrip();

		const created = path.join(workspace, "edit_created.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);

		const moved = path.join(workspace, "edit_moved.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						kind: "rename",
						oldUri: pathToFileURL(created).href,
						newUri: pathToFileURL(moved).href,
					},
				],
			},
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 1`);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 3`,
		);

		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "delete", uri: pathToFileURL(moved).href }] },
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 3`);
	}, 30_000);

	// Recurrence: an edit that fails mid-application has already written its
	// earlier operations ("no rollback performed"); a server must still hear
	// about the file that now exists.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"announces an applied create when a later operation fails",
		async () => {
			const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
			// #4397: a Created event reaches a RUNNING client only. A sibling case
			// used to have started it; run first, no client existed to hear it.
			await roundTrip();
			const locked = path.join(workspace, "locked");
			fs.mkdirSync(locked);
			const target = path.join(locked, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			fs.chmodSync(target, 0o444);
			fs.chmodSync(locked, 0o555);
			const created = path.join(workspace, "edit_partial.ts");
			try {
				await expect(
					applyWorkspaceEdit(
						{
							documentChanges: [
								{ kind: "create", uri: pathToFileURL(created).href },
								{
									textDocument: {
										uri: pathToFileURL(target).href,
										version: null,
									},
									edits: [
										{
											range: {
												start: { line: 0, character: 13 },
												end: { line: 0, character: 14 },
											},
											newText: "b",
										},
									],
								},
							],
						},
						workspace,
					),
				).rejects.toThrow(/failed mid-application/);
			} finally {
				fs.chmodSync(locked, 0o755);
			}
			await roundTrip();
			expect(watchedLines()).toContain(
				`watched ${pathToFileURL(created).href} 1`,
			);
		},
		30_000,
	);
});

describe("the producer's cost gate (#4346)", () => {
	// Recurrence: #4344 r1, where a per-call extra pass took the cached replay
	// from 6 ms to 321 ms. A fresh clean entry for the current bytes cannot
	// show a missing import (every import it names resolved), so a batch
	// resolves every file except those (#4368 r1 F1 widened the gate from
	// "has cached findings" to this).
	it("resolves no file a fresh clean entry answers, and resolves it again once edited", async () => {
		const { getCreatedImportScanRollup } =
			await import("../../clients/lsp/created-import-targets.js");
		fs.writeFileSync(path.join(workspace, "gate_module.ts"), "export {};\n");
		const importer = path.join(workspace, "gate_user.ts");
		fs.writeFileSync(importer, 'import "./gate_module";\nexport {};\n');
		const resolved = () => getCreatedImportScanRollup().importers;

		const before = resolved();
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(0);
		expect(resolved() - before).toBe(1);

		await diagnose({ paths: [importer] });
		expect(resolved() - before).toBe(1);

		fs.appendFileSync(importer, "// edited\n");
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(importer, later, later);
		await diagnose({ paths: [importer] });
		expect(resolved() - before).toBe(2);
	}, 30_000);
});
