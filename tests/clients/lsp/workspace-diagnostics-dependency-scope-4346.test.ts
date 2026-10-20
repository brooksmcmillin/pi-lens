/**
 * #4346: a cached workspace-diagnostics entry is refused on a creation only
 * when the created file is in the entry's dependency scope: its imports (the
 * graph's edges, this call's resolution, a file an unresolved source names)
 * and its implicit scope (the TS/JS ambient files for a JS/TS file, the
 * package's files for a Go file). #4320/#4344 refused every finding entry of
 * a server under a root on any Created there, and never a clean one.
 *
 * Every case drives the real cache context (`createWorkspaceDiagnosticsCacheContext`,
 * `lookup`) over real files and the real creation records a client notes when
 * it sends Created (`noteWorkspaceFileCreated`); the import scope is what the
 * created-module producer hands the cache (`noteImportScope`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cacheKeyFor,
	createWorkspaceDiagnosticsCacheContext,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
	type WorkspaceDiagnosticsCacheEntry,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	MAX_FILE_CREATIONS,
	noteWorkspaceFileCreated,
	resetWorkspaceDiagnosticsCacheSession,
} from "../../../clients/lsp/workspace-diagnostics-session.js";
import { extractForwardImports } from "../../../clients/blocker-freshness.js";
import { feedsJsTsGlobalScope } from "../../../clients/lsp/implicit-scope.js";
import { getRecentLoggedPhases } from "../../../clients/latency-logger.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../../clients/project-snapshot.js";
import {
	drainBackgroundWritesForTests,
	removeTempDirSync,
} from "../test-utils.js";

const SCOPE = "all|";

function finding(serverId: string): LSPDiagnostic {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		source: serverId,
		serverId,
		message: "a finding",
	};
}

let tmp: string;
let sessionStart: number;

beforeEach(() => {
	tmp = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dep-scope-")),
	);
	fs.mkdirSync(path.join(tmp, ".pi-lens"));
	sessionStart = Date.now() - 1000;
	resetWorkspaceDiagnosticsCacheSession(sessionStart);
});

afterEach(async () => {
	// `saveProjectSnapshot` queues its body write; let it land first.
	await drainBackgroundWritesForTests();
	removeTempDirSync(tmp);
	resetWorkspaceDiagnosticsCacheSession();
});

function write(name: string, content: string): string {
	const file = path.join(tmp, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** Seed one entry per file, scanned at `sessionStart + 1` unless given. */
function seed(
	entries: Array<{ file: string; serverId?: string; scannedAt?: number }>,
): void {
	const records: Record<string, WorkspaceDiagnosticsCacheEntry> = {};
	for (const { file, serverId, scannedAt } of entries) {
		const stat = fs.statSync(file);
		const diagnostics = serverId ? [finding(serverId)] : [];
		records[cacheKeyFor(file)] = {
			diagnostics,
			count: diagnostics.length,
			mtimeMs: stat.mtimeMs,
			sizeBytes: stat.size,
			scannedAt: scannedAt ?? sessionStart + 1,
			scopeKey: SCOPE,
		};
	}
	saveWorkspaceDiagnosticsCache(tmp, {
		version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
		entries: records,
	});
}

/** A client of `serverId` at the workspace root sent `file` as Created. */
function created(file: string, serverId = "typescript"): void {
	noteWorkspaceFileCreated(
		serverId,
		tmp,
		[cacheKeyFor(file)],
		sessionStart + 10,
	);
}

describe("finding entries: the import scope", () => {
	// #4477: package/alias dependencies in JSDoc and module augmentations
	// escaped both extraction and the relative-only completeness check.
	it.each([
		[
			"jsdoc.js",
			'/** @import { T } from "@/types" */\nexport {};\n',
			"@/types",
		],
		[
			"augment.ts",
			'export {};\ndeclare module "pkg" { interface T {} }\n',
			"pkg",
		],
	])(
		"refuses a cached finding for an uncaptured dependency in %s",
		async (name, content, source) => {
			const user = write(name, content);
			seed([{ file: user, serverId: "typescript" }]);
			created(write("new-target.ts", "export interface T {}\n"));
			const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
			const scope = await extractForwardImports(tmp, user);
			ctx.noteImportScope(user, scope);
			expect(ctx.lookup(user, SCOPE)).toBeUndefined();
			expect(scope.unresolved).toContain(source);
		},
	);

	it.each([
		["alias.js", '/** @import { T } from "@/types" */\nexport {};\n'],
		["package.ts", 'export {}; declare module "pkg" { interface T {} }\n'],
	])(
		"refuses a held finding when its only named dependency is created in %s",
		async (name, content) => {
			write(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						paths: { "@/types": ["dep.ts"], pkg: ["dep.ts"] },
					},
				}),
			);
			const user = write(name, content);
			seed([{ file: user, serverId: "typescript" }]);
			const dep = write("dep.ts", "export interface T {}\n");
			created(dep);
			const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
			const scope = await extractForwardImports(tmp, user);
			ctx.noteImportScope(user, scope);
			expect(ctx.lookup(user, SCOPE)).toBeUndefined();
			expect(scope.targets).toContain(dep);
		},
	);

	it.each([
		["jsdoc.ts", '/** @import { T } from "./dep" */\nexport {};\n'],
		["jsdoc.tsx", '/** @import * as T from "./dep" */\nexport {};\n'],
		["augment.ts", 'export {}; declare module "./dep" { interface T {} }\n'],
		["type.ts", 'import type { T } from "./dep";\n'],
		["dynamic.js", 'export const t = import("./dep");\n'],
		["required.js", 'const t = require("./dep");\n'],
		["required.cjs", 'const t = require("./dep");\n'],
	])(
		"captures the dependency through the production resolver in %s",
		async (name, content) => {
			const dep = write("dep.ts", "export interface T {}\n");
			expect(
				(await extractForwardImports(tmp, write(name, content))).targets,
			).toContain(dep);
		},
	);

	it.each([
		['/// <reference path="generated.ts" />\nexport {};\n'],
		['/// <reference types="pkg" />\nexport {};\n'],
	])(
		"refuses a cached finding for a triple-slash dependency: %s",
		async (content) => {
			const user = write("reference.ts", content);
			seed([{ file: user, serverId: "typescript" }]);
			created(write("new-target.ts", "export interface T {}\n"));
			const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
			ctx.noteImportScope(user, await extractForwardImports(tmp, user));
			expect(ctx.lookup(user, SCOPE)).toBeUndefined();
		},
	);

	it("does not invent dependencies from ordinary comment or string text", async () => {
		const user = write(
			"plain.js",
			'// from "pkg"\nexport const text = "@/types";\n',
		);
		seed([{ file: user, serverId: "typescript" }]);
		created(write("new-target.ts", "export interface T {}\n"));
		const scope = await extractForwardImports(tmp, user);
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, scope);
		expect(ctx.lookup(user, SCOPE)).toBeDefined();
		expect(scope.targets).toEqual([]);
		expect(scope.unresolved).toEqual([]);
	});

	// Acceptance item 4. Recurrence: #4320/#4344 refused this entry on any
	// creation its server heard under its root.
	it("serves a finding entry past a created file its resolved scope does not hold", () => {
		const user = write("user.ts", 'import "./dep";\nexport {};\n');
		write("dep.ts", "export {};\n");
		seed([{ file: user, serverId: "typescript" }]);
		created(write("unrelated.ts", "export const u = 1;\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [path.join(tmp, "dep.ts")],
			unresolved: [],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeDefined();
	});

	it("refuses it when the created file is one its imports resolve to now", () => {
		const user = write("user.ts", 'import "./dep";\nexport {};\n');
		seed([{ file: user, serverId: "typescript" }]);
		const dep = write("dep.ts", "export {};\n");
		created(dep);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		// A spelling with a dot segment: the scope is keyed as records are.
		ctx.noteImportScope(user, {
			targets: [path.join(tmp, ".", "dep.ts")],
			unresolved: [],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	// The resolver cannot answer a JSON module even once it exists; the
	// unresolved source names it.
	it("refuses it when an unresolved import names the created file", () => {
		const user = write("user.ts", 'import data from "./data.json";\n');
		seed([{ file: user, serverId: "typescript" }]);
		created(write("data.json", "{}\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [],
			unresolved: ["./data.json"],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	// A directory import answers through its index file, whose stem is not the
	// name the source spells. Recurrence: matching stems alone served the
	// entry's "cannot find module './gen'" past the new `gen/index.ts`.
	it("refuses it when an unresolved import names the created file's directory", () => {
		const user = write("user.ts", 'import "./gen";\nexport {};\n');
		seed([{ file: user, serverId: "typescript" }]);
		created(write("gen/index.ts", "export {};\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [],
			unresolved: ["./gen"],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	// The base rule is the fallback whenever the scope is not known.
	it("refuses it on any creation when this call did not resolve the file", () => {
		const user = write("user.ts", "export {};\n");
		seed([{ file: user, serverId: "typescript" }]);
		created(write("unrelated.ts", "export const u = 1;\n"));

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(user, SCOPE),
		).toBeUndefined();
	});

	it("refuses it on any creation when an unresolved source names nothing", () => {
		const user = write("user.ts", 'import ".";\n');
		seed([{ file: user, serverId: "typescript" }]);
		created(write("unrelated.ts", "export const u = 1;\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [],
			unresolved: ["."],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	// Population: Python's `from pkg import sub` resolves only
	// `pkg/__init__.py`, so its scope is not modelled and keeps the base rule.
	it("refuses a Python finding entry on any creation, resolved or not", () => {
		const user = write("user.py", "from pkg import sub\n");
		seed([{ file: user, serverId: "pyright" }]);
		created(write("pkg/sub.py", "X = 1\n"), "pyright");

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [write("pkg/__init__.py", "")],
			unresolved: [],
			complete: true,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	// Rows F1, F1b, F2. Recurrence: #4430 r1 review F1/F2, where a dependency
	// the extraction never saw (a dynamic import, a re-export in a target)
	// left the scope looking complete, and a stale finding was served.
	it("refuses it on any creation when the producer reports the scope incomplete", () => {
		const user = write("user.ts", 'import "./dep";\nexport {};\n');
		write("dep.ts", "export {};\n");
		seed([{ file: user, serverId: "typescript" }]);
		created(write("unrelated.ts", "export const u = 1;\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, {
			targets: [path.join(tmp, "dep.ts")],
			unresolved: [],
			complete: false,
		});
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
	});

	it("keeps the server filter: a creation another server heard is not counted", () => {
		const user = write("user.ts", "export {};\n");
		seed([{ file: user, serverId: "typescript" }]);
		created(write("globals.d.ts", "declare const G: number;\n"), "eslint");

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(user, SCOPE),
		).toBeDefined();
	});
});

describe("clean entries: the graph's import edges", () => {
	// A clean entry gets no producer scope (the batch skips files whose clean
	// entry serves), so its import scope is the graph's edges. Recurrence:
	// #4368 r1 row 13, a module moved in with `mv` keeps its old mtime, so the
	// dependency mtime check cannot see it; only the creation record can.
	it("refuses a clean entry when a file its graph edges name is created", () => {
		const old = new Date(sessionStart - 60_000);
		const user = write("user.ts", 'import "./dep";\nexport {};\n');
		const other = write("other.ts", "export {};\n");
		const dep = write("dep.ts", "export {};\n");
		for (const file of [user, other, dep]) fs.utimesSync(file, old, old);
		const node = (file: string, imports: string[]) => ({
			path: file,
			mtimeMs: old.getTime(),
			size: fs.statSync(file).size,
			imports,
			lastSeq: 1,
		});
		saveProjectSnapshot(tmp, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: tmp,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				[cacheKeyFor(user)]: node(user, [dep]),
				[cacheKeyFor(other)]: node(other, []),
				[cacheKeyFor(dep)]: node(dep, []),
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
		seed([{ file: user }, { file: other }]);
		created(dep);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
		expect(ctx.lookup(other, SCOPE)).toBeDefined();
	});
});

describe("the implicit scope (rows 11 and 12)", () => {
	// Row 11. Recurrence: #4368 r1 probe, `declare const FOO` in a new
	// `globals.d.ts` answered `Cannot find name 'FOO'` with no edge.
	it("refuses JS/TS entries, clean or not, when an ambient declaration file is created", () => {
		const user = write("src/use.ts", "export const x: number = FOO;\n");
		const clean = write("src/clean.js", "export const y = 1;\n");
		seed([{ file: user, serverId: "typescript" }, { file: clean }]);
		created(write("types/globals.d.ts", "declare const FOO: number;\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, { targets: [], unresolved: [], complete: true });
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
		expect(ctx.lookup(clean, SCOPE)).toBeUndefined();
	});

	it("serves a non-JS/TS clean entry past the same creation", () => {
		const clean = write("main.py", "X = 1\n");
		seed([{ file: clean }]);
		created(write("types/globals.d.ts", "declare const FOO: number;\n"));

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeDefined();
	});

	// Recurrence: #4430 r1 review F3, the fail-closed branch for a created
	// file over the LSP sync limits had no test. A module-shaped file, so only
	// that branch answers true (a script parses as feeding the scope anyway).
	it("refuses a clean JS/TS entry when a module over the LSP sync limits is created", () => {
		const clean = write("src/clean.ts", "export const y = 1;\n");
		seed([{ file: clean }]);
		created(
			write(
				"src/huge.ts",
				`export const h = 1;\n${"const x = 1;\n".repeat(5_001)}`,
			),
		);

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeUndefined();
	});

	it("serves a clean JS/TS entry past a created module", () => {
		const clean = write("src/clean.ts", "export const y = 1;\n");
		seed([{ file: clean }]);
		created(write("src/module.ts", "export const m = 1;\n"));

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeDefined();
	});

	// Row 12.
	it("refuses Go entries, clean or not, when a file of their package is created", () => {
		const user = write("pkg/user.go", "package pkg\n");
		const clean = write("pkg/clean.go", "package pkg\n");
		const elsewhere = write("other/clean.go", "package other\n");
		// Older than the scan, so only the creation record can refuse.
		const old = new Date(sessionStart - 60_000);
		for (const file of [user, clean, elsewhere]) {
			fs.utimesSync(file, old, old);
			fs.utimesSync(path.dirname(file), old, old);
		}
		seed([
			{ file: user, serverId: "gopls" },
			{ file: clean },
			{ file: elsewhere },
		]);
		const peer = write("pkg/peer.go", "package pkg\n");
		fs.utimesSync(peer, old, old);
		fs.utimesSync(path.dirname(peer), old, old);
		created(peer, "gopls");

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.noteImportScope(user, { targets: [], unresolved: [], complete: true });
		expect(ctx.lookup(user, SCOPE)).toBeUndefined();
		expect(ctx.lookup(clean, SCOPE)).toBeUndefined();
		expect(ctx.lookup(elsewhere, SCOPE)).toBeDefined();
	});

	// A client sends a new file's own Created as the batch diagnoses it, and
	// the flush can land after the scan began. The server answers the file
	// from its open document, so its own Created never changes that answer.
	// Recurrence: a Go file or an ambient file is in its own implicit scope,
	// so each new one was re-touched once for nothing.
	it("serves an entry past its own file's Created", () => {
		const old = new Date(sessionStart - 60_000);
		const goFile = write("pkg/new.go", "package pkg\n");
		const ambient = write("types/new.d.ts", "declare const N: number;\n");
		for (const file of [goFile, ambient]) {
			fs.utimesSync(file, old, old);
			fs.utimesSync(path.dirname(file), old, old);
		}
		seed([{ file: goFile }, { file: ambient }]);
		created(goFile, "gopls");
		created(ambient);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(goFile, SCOPE)).toBeDefined();
		expect(ctx.lookup(ambient, SCOPE)).toBeDefined();
	});

	// Row E2: the package on the mtime axis, as import edges are.
	it("refuses a Go clean entry when a file of its package is edited after the scan", () => {
		const clean = write("pkg/clean.go", "package pkg\n");
		const peer = write("pkg/peer.go", "package pkg\n");
		const elsewhere = write("other/clean.go", "package other\n");
		const old = new Date(sessionStart - 60_000);
		for (const file of [clean, peer, elsewhere]) {
			fs.utimesSync(file, old, old);
			fs.utimesSync(path.dirname(file), old, old);
		}
		seed([{ file: clean }, { file: elsewhere }]);
		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeDefined();

		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(peer, later, later);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(clean, SCOPE)).toBeUndefined();
		expect(ctx.lookup(elsewhere, SCOPE)).toBeDefined();
	});

	it("refuses a Go clean entry when a file of its package is deleted", () => {
		const clean = write("pkg/clean.go", "package pkg\n");
		const peer = write("pkg/peer.go", "package pkg\n");
		const old = new Date(sessionStart - 60_000);
		for (const file of [clean, peer]) fs.utimesSync(file, old, old);
		fs.utimesSync(path.dirname(clean), old, old);
		seed([{ file: clean }]);

		fs.rmSync(peer);
		// The directory's mtime moves with the removal; pin it ahead of the
		// tolerance window so the case does not depend on clock granularity.
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(path.dirname(clean), later, later);

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeUndefined();
	});
});

describe("feedsJsTsGlobalScope: which created files feed the global scope", () => {
	it.each([
		["globals.d.ts", "export {};\n", true],
		["types.d.mts", "export {};\n", true],
		["augment.ts", "export {};\ndeclare global { const G: number }\n", true],
		[
			"ambient.ts",
			"import 'x';\ndeclare module 'foo' { const a: number }\n",
			true,
		],
		["script.ts", "const SCRIPT = 1;\n", true],
		["view.tsx", "const View = () => <div />;\n", true],
		["module.ts", "import x from './y';\nexport const a = x;\n", false],
		["commented.ts", "// declare global {}\nexport const a = 1;\n", false],
		["esm.mts", "const a = 1;\n", false],
		["global.mts", "export {};\ndeclare global { const G: number }\n", true],
		["script.js", "var LEGACY = 1;\n", true],
		["common.js", "module.exports = { a: 1 };\n", false],
		["required.js", "const fs = require('fs');\n", false],
		["exported.js", "exports.a = 1;\n", false],
		["esm.js", "export const a = 1;\n", false],
		["module.mjs", "const a = 1;\n", false],
		["component.vue", "<script>const a = 1</script>\n", false],
		["main.py", "X = 1\n", false],
	])("%s feeds it: %s", (name, content, expected) => {
		expect(feedsJsTsGlobalScope(write(name, content))).toBe(expected);
	});

	it("fails closed on a file it cannot read", () => {
		expect(feedsJsTsGlobalScope(path.join(tmp, "missing.ts"))).toBe(true);
	});
});

describe("bounds and observability", () => {
	// #4320 r2: eviction can only refuse more. Since a clean entry obeys the
	// creation axis too, the fold refuses it once as well.
	it("refuses a clean entry after its creation record is evicted", () => {
		const clean = write("clean.ts", "export const y = 1;\n");
		seed([{ file: clean }]);
		for (let index = 0; index <= MAX_FILE_CREATIONS; index += 1) {
			noteWorkspaceFileCreated(
				"typescript",
				tmp,
				[`/elsewhere/${index}.ts`],
				sessionStart + 10,
			);
		}

		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(clean, SCOPE),
		).toBeUndefined();
	});

	// The decision item 4 makes is counted in the cache's one record per
	// sweep, so a live run shows entries served on the dependency scope.
	// An entry scanned after the creation is not served past it: the count
	// is the decision item 4 makes, not every entry a creation predates.
	it("counts entries served past a creation outside their scope", () => {
		const user = write("user.ts", "export {};\n");
		const later = write("later.ts", "export {};\n");
		seed([
			{ file: user, serverId: "typescript" },
			{ file: later, serverId: "typescript", scannedAt: sessionStart + 20 },
		]);
		created(write("unrelated.ts", "export const u = 1;\n"));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		for (const file of [user, later]) {
			ctx.noteImportScope(file, {
				targets: [],
				unresolved: [],
				complete: true,
			});
			expect(ctx.lookup(file, SCOPE)).toBeDefined();
		}
		ctx.persist();

		const record = getRecentLoggedPhases().find(
			(phase) => phase.phase === "lsp_workspace_diagnostics_cache_expiry",
		);
		expect(record?.metadata?.servedPastCreation).toBe(1);
		expect(record?.metadata?.fileCreated).toBe(0);
	});
});
