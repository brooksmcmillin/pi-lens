/**
 * #4346: the bounds of the created-module producer and of the workspace edit's
 * resource-operation announce, through the real modules (no language server
 * needed: neither spawns one).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	CREATED_IMPORT_SCAN_MAX_FILES,
	emitCreatedImportScanRollupAtSessionEnd,
	getCreatedImportScanRollup,
	goPackageFilesToAnnounce,
	type ImportScope,
	importTargetsToAnnounce,
} from "../../../clients/lsp/created-import-targets.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { applyWorkspaceEdit } from "../../../clients/lsp/edits.js";
import { resetLSPService } from "../../../clients/lsp/index.js";
import { peekOwnedLspService } from "../../../clients/lsp/service-singleton.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { toPosix } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];
afterEach(() => {
	resetDegradationLedger();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		'{"name":"w","version":"0.0.0"}\n',
	);
	return root;
}

describe("importTargetsToAnnounce (#4346)", () => {
	// Recurrence: a sweep of hundreds of finding-bearing files would extract
	// every one of them on the diagnostics path; the cap bounds that, and the
	// record says what it left out.
	it("resolves at most the cap of importers per call and records the rest once", async () => {
		const root = workspace("pi-lens-4346-cap-");
		const importers: string[] = [];
		for (let i = 0; i <= CREATED_IMPORT_SCAN_MAX_FILES; i++) {
			const importer = path.join(root, `user${i}.ts`);
			fs.writeFileSync(importer, `import "./mod${i}";\nexport {};\n`);
			fs.writeFileSync(path.join(root, `mod${i}.ts`), "export {};\n");
			importers.push(importer);
		}

		const targets = (await importTargetsToAnnounce(root, importers)).map(
			(file) => toPosix(path.relative(root, file)),
		);
		await importTargetsToAnnounce(root, importers);

		expect(targets).toHaveLength(CREATED_IMPORT_SCAN_MAX_FILES);
		expect(targets).toContain("mod0.ts");
		expect(targets).not.toContain(`mod${CREATED_IMPORT_SCAN_MAX_FILES}.ts`);
		const record = getDegradationSummary().find(
			(group) => group.kind === "lsp-created-import-scan-incomplete",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.subject).toBe("capped");
	});

	// #4346: the cache's dependency scope is complete only for a file the
	// producer resolved, so it hears every resolved file's targets and
	// unresolved sources, and never a file past the cap (which then keeps the
	// base rule).
	it("hands each resolved importer's scope to the caller, and none past the cap", async () => {
		const root = workspace("pi-lens-4346-scope-");
		const importers: string[] = [];
		for (let i = 0; i <= CREATED_IMPORT_SCAN_MAX_FILES; i++) {
			const importer = path.join(root, `user${i}.ts`);
			fs.writeFileSync(
				importer,
				`import "./mod${i}";\nimport "./missing${i}";\nexport {};\n`,
			);
			fs.writeFileSync(path.join(root, `mod${i}.ts`), "export {};\n");
			importers.push(importer);
		}
		const heard = new Map<string, ImportScope>();

		await importTargetsToAnnounce(root, importers, (importer, scope) =>
			heard.set(importer, scope),
		);

		expect(heard.size).toBe(CREATED_IMPORT_SCAN_MAX_FILES);
		expect(heard.has(importers[CREATED_IMPORT_SCAN_MAX_FILES]!)).toBe(false);
		const first = heard.get(importers[0]!);
		expect(first?.targets.map((file) => path.basename(file))).toEqual([
			"mod0.ts",
		]);
		expect(first?.unresolved).toEqual(["./missing0"]);
	});

	it("records nothing within the cap", async () => {
		const root = workspace("pi-lens-4346-cap-under-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
		fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

		const targets = await importTargetsToAnnounce(root, [importer]);

		expect(targets.map((file) => toPosix(path.relative(root, file)))).toEqual([
			"mod.ts",
		]);
		expect(
			getDegradationSummary().some(
				(group) => group.kind === "lsp-created-import-scan-incomplete",
			),
		).toBe(false);
	});
});

describe("importTargetsToAnnounce: scope completeness (#4346 r2)", () => {
	async function scopeOf(root: string, importer: string): Promise<ImportScope> {
		let heard: ImportScope | undefined;
		await importTargetsToAnnounce(root, [importer], (_file, scope) => {
			heard = scope;
		});
		if (!heard) throw new Error(`no scope heard for ${importer}`);
		return heard;
	}

	// Completeness table rows C2-C10. Recurrence: #4430 r1 review F1 and r2
	// verify V1, the import query captures only import and export statements,
	// so these dependencies were neither targets nor unresolved, and the cache
	// served a stale finding past their creation (on real tsserver for the
	// JSDoc `@import` and the module augmentation). Rule A (a relative
	// specifier string that is not a captured source) covers the rows with a
	// quoted relative specifier; rule K (an `import(` or `require(` call)
	// covers the call rows, and alone the alias and backtick rows.
	it.each([
		["dynamic import", "user.ts", 'export const f = () => import("./lazy");\n'],
		["type-position import", "user.ts", 'export let t: import("./types").T;\n'],
		[
			"import = require",
			"user.ts",
			'import m = require("./mod");\nexport { m };\n',
		],
		["require", "user.ts", 'const m = require("./mod");\nexport { m };\n'],
		[
			"reference path",
			"user.ts",
			'/// <reference path="./globals.ts" />\nexport {};\n',
		],
		[
			"JSDoc @import",
			"user.js",
			'/** @import { T } from "./types" */\n/** @type {T} */\nexport const t = 1;\n',
		],
		[
			"module augmentation",
			"user.ts",
			'declare module "./augmod" {\n\tinterface A { x: number }\n}\nexport {};\n',
		],
		// Rule K alone: an alias or package specifier, and a backtick one.
		[
			"dynamic import of an alias",
			"user.ts",
			'export const f = () => import("@/lazy");\n',
		],
		[
			"template dynamic import",
			"user.ts",
			"export const f = () => import(`./lazy`);\n",
		],
	])(
		"reports a file holding a %s incomplete",
		async (_shape, name, content) => {
			const root = workspace("pi-lens-4346-uncaptured-");
			const importer = path.join(root, name);
			fs.writeFileSync(importer, `import "./dep";\n${content}`);
			fs.writeFileSync(path.join(root, "dep.ts"), "export {};\n");

			const scope = await scopeOf(root, importer);

			expect(scope.targets.map((file) => path.basename(file))).toEqual([
				"dep.ts",
			]);
			expect(scope.complete).toBe(false);
		},
	);

	// #4438 rewrote completeness row C4: the import query captures a dynamic
	// `import()` now, comments inside the call included, so its target is in
	// the scope and the scope is complete (rule K does not see this spelling).
	// Before, rule A refused the uncaptured `./lazy` and no target was named.
	it("names a comment-split dynamic import's target in a complete scope", async () => {
		const root = workspace("pi-lens-4346-comment-split-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(
			importer,
			'import "./dep";\nexport const p = import /* c */ ("./lazy");\n',
		);
		fs.writeFileSync(path.join(root, "dep.ts"), "export {};\n");
		fs.writeFileSync(path.join(root, "lazy.ts"), "export {};\n");

		const scope = await scopeOf(root, importer);

		expect(scope.targets.map((file) => path.basename(file)).sort()).toEqual([
			"dep.ts",
			"lazy.ts",
		]);
		expect(scope.complete).toBe(true);
	});

	it("reports a file whose imports are all statements complete", async () => {
		const root = workspace("pi-lens-4346-captured-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(
			importer,
			'import { a } from "./dep";\nexport { b } from "./other";\nexport const c = a;\n',
		);
		fs.writeFileSync(path.join(root, "dep.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(root, "other.ts"), "export const b = 1;\n");

		expect((await scopeOf(root, importer)).complete).toBe(true);
	});

	// Row C11. Recurrence: #4430 r3 verify, round 3 deleted the reference-path
	// keyword on the claim that a referenced file reaches F only through
	// global declarations. A module target does too: TS6053 ("file not found")
	// depends only on the file existing, so the ambient arm misses its
	// creation, and real tsserver served the stale finding. Rule K counts it.
	it("reports a file referencing a module path without ./ incomplete", async () => {
		const root = workspace("pi-lens-4346-reference-bare-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(
			importer,
			'/// <reference path="x.ts" />\nimport "./dep";\nexport {};\n',
		);
		fs.writeFileSync(path.join(root, "dep.ts"), "export {};\n");
		fs.writeFileSync(path.join(root, "x.ts"), "export const x = 1;\n");

		expect((await scopeOf(root, importer)).complete).toBe(false);
	});

	// Row C19: rules A and K are JS/TS only. A Go grouped import is `import (`,
	// and a Go string may spell `./x`; the Go query captures every import spec.
	it("reports a Go file with a grouped import and a relative string complete", async () => {
		const root = workspace("pi-lens-4346-go-group-");
		const importer = path.join(root, "main.go");
		fs.writeFileSync(
			importer,
			'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() { fmt.Println("./x") }\n',
		);

		expect((await scopeOf(root, importer)).complete).toBe(true);
	});

	// Row F1b: an importer with a grammar that cannot be read now.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports a file it cannot read incomplete",
		async () => {
			const root = workspace("pi-lens-4346-unread-importer-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(importer, 'import "./dep";\nexport {};\n');
			fs.writeFileSync(path.join(root, "dep.ts"), "export {};\n");
			fs.chmodSync(importer, 0o000);
			try {
				const scope = await scopeOf(root, importer);
				expect(scope.targets).toEqual([]);
				expect(scope.complete).toBe(false);
			} finally {
				fs.chmodSync(importer, 0o644);
			}
		},
	);

	// Row F1b. Recurrence: an importer the extraction cannot parse (here a Vue
	// file, which has no grammar) answered an empty scope that counted as
	// complete, so its finding entry ignored every creation.
	it("reports a file it cannot parse incomplete", async () => {
		const root = workspace("pi-lens-4346-unparsed-");
		const importer = path.join(root, "view.vue");
		fs.writeFileSync(
			importer,
			'<script setup lang="ts">\nimport { a } from "./dep";\n</script>\n',
		);
		fs.writeFileSync(path.join(root, "dep.ts"), "export const a = 1;\n");

		const scope = await scopeOf(root, importer);

		expect(scope.targets).toEqual([]);
		expect(scope.complete).toBe(false);
	});

	// Rows T1-T8. Recurrence: #4430 r1 review F2 and the r2 verify's three
	// slips (T6-T8): a target that re-exports another module lets the
	// importer use that module, which its imports do not name. Rule R (an
	// `export` then a `from` with no `;` between) covers every row.
	it.each([
		["export * from", 'export * from "./b";\n'],
		["export * as ns from", 'export * as ns from "./b";\n'],
		["export { x } from", 'export {\n  x,\n} from "./b";\n'],
		["export type { T } from", 'export type { T } from "./b";\n'],
		["export { default } from", 'export { default } from "./b";\n'],
		["export /* c */ * from", 'export /* c */ * from "./b";\n'],
		[
			"a } in a comment within export { } from",
			'export {\n  x, // see }\n} from "./b";\n',
		],
		['export * as "ns" from', 'export * as "ns" from "./b";\n'],
		// #4430 r3 verify nitpick: a `;` inside a comment split the run.
		[
			"a ; in a comment within export { } from",
			'export { a /* ; */ } from "./b";\n',
		],
		// Both readings count: removing "comments" alone would drop this
		// line from `//` on.
		[
			"a re-export after a URL string on its line",
			'const u = "http://x"; export * from "./b";\n',
		],
	])(
		"reports a file whose target holds %s incomplete",
		async (_form, content) => {
			const root = workspace("pi-lens-4346-reexport-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(
				importer,
				'import { x } from "./a";\nexport const y = x;\n',
			);
			fs.writeFileSync(path.join(root, "a.ts"), content);

			expect((await scopeOf(root, importer)).complete).toBe(false);
		},
	);

	// Rows T10 and T13: rule R reads an `export` and a later `from` in one
	// `;`-free run. A `from` before the `export`, or past a `;`, is no
	// re-export, with or without semicolons.
	it.each([
		[
			"with semicolons",
			'export const z = 1;\nimport { b } from "./b";\nexport const x = b;\nexport { b };\n',
		],
		[
			"without semicolons",
			'import { b } from "./b"\nexport const x = b\nexport { b }\n',
		],
	])(
		"reports a file whose target only imports and exports its own names complete (%s)",
		async (_style, content) => {
			const root = workspace("pi-lens-4346-no-reexport-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(
				importer,
				'import { x } from "./a";\nexport const y = x;\n',
			);
			fs.writeFileSync(path.join(root, "a.ts"), content);
			fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");

			expect((await scopeOf(root, importer)).complete).toBe(true);
		},
	);

	// A target the extraction resolved but that cannot be read now (gone, or
	// no permission) may re-export anything: the scope fails closed.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports a file whose target cannot be read incomplete",
		async () => {
			const root = workspace("pi-lens-4346-unreadable-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(
				importer,
				'import { x } from "./a";\nexport const y = x;\n',
			);
			const target = path.join(root, "a.ts");
			fs.writeFileSync(target, "export const x = 1;\n");
			fs.chmodSync(target, 0o000);
			try {
				expect((await scopeOf(root, importer)).complete).toBe(false);
			} finally {
				fs.chmodSync(target, 0o644);
			}
		},
	);
});

describe("importTargetsToAnnounce bounds (#4368 r1 F2)", () => {
	// Recurrence: #4368 r1 F2. A file the LSP does not sync (over its byte or
	// line limit) gets no server answer, so its imports have nothing to make
	// stale; resolving it only spent the diagnostics call's time.
	it("skips an importer over the LSP sync limits and records it once", async () => {
		const root = workspace("pi-lens-4346-oversized-");
		const importer = path.join(root, "huge.ts");
		fs.writeFileSync(
			importer,
			`import "./mod";\n${"export const x = 1;\n".repeat(5_001)}`,
		);
		fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

		expect(await importTargetsToAnnounce(root, [importer])).toEqual([]);
		await importTargetsToAnnounce(root, [importer]);

		const record = getDegradationSummary().find(
			(group) => group.kind === "lsp-created-import-scan-incomplete",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.subject).toBe("oversized");
	});
});

describe("the producer's session rollup (#4368 r1 F3)", () => {
	async function rollupRows(): Promise<Array<Record<string, unknown>>> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
		return text
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						phase?: string;
						metadata?: Record<string, unknown>;
					},
			)
			.filter((row) => row.phase === "lsp_created_import_scan_rollup")
			.map((row) => row.metadata ?? {});
	}

	// Recurrence: #4368 r1 F3. The producer's cost (60 ms to 9 s measured)
	// left no record; one row per session carries it, never one per call.
	it("writes one row per session with the calls, importers and targets, then starts over", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			emitCreatedImportScanRollupAtSessionEnd();
			clearLatencyLog();
			const root = workspace("pi-lens-4346-rollup-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
			fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

			await importTargetsToAnnounce(root, [importer]);
			await importTargetsToAnnounce(root, [importer]);
			expect(await rollupRows()).toEqual([]);
			expect(getCreatedImportScanRollup()).toMatchObject({
				calls: 2,
				importers: 2,
				targets: 2,
			});

			// The session_shutdown reset index.ts runs (no service here).
			resetLSPService({ reason: "session_shutdown" });
			resetLSPService({ reason: "session_shutdown" });

			const rows = await rollupRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				calls: 2,
				importers: 2,
				targets: 2,
				capped: 0,
				oversized: 0,
			});
			expect(typeof rows[0]?.totalMs).toBe("number");
			expect(typeof rows[0]?.maxMs).toBe("number");
			expect(getCreatedImportScanRollup().calls).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
		}
	});

	// Recurrence: #4368 r2 L1 (mutant S7: the rollup emitted on any
	// resetLSPService reason). The row is a session-end record; a reset with
	// any other reason (session_start) must emit nothing and leave the tally
	// for the session's own shutdown.
	it("emits no rollup row for a reset that is not session_shutdown", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			emitCreatedImportScanRollupAtSessionEnd();
			clearLatencyLog();
			const root = workspace("pi-lens-4346-rollup-reason-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
			fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

			await importTargetsToAnnounce(root, [importer]);
			resetLSPService({ reason: "session_start" });

			expect(await rollupRows()).toEqual([]);
			expect(getCreatedImportScanRollup().calls).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
		}
	});
});

describe("a workspace edit's resource operations with no LSP service (#4346)", () => {
	// Recurrence: an edit applied before any LSP use (a `rename_file` with no
	// client yet) must not start the LSP stack only to report its operations.
	it("applies the operation and creates no service", async () => {
		const root = workspace("pi-lens-4346-noservice-");
		const created = path.join(root, "made.ts");
		expect(peekOwnedLspService()).toBeUndefined();

		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			root,
		);

		expect(fs.existsSync(created)).toBe(true);
		expect(peekOwnedLspService()).toBeUndefined();
	});
});

describe("goPackageFilesToAnnounce (#4346)", () => {
	// Row 12. Recurrence: a Go file uses its package's files with no import,
	// so the import producer never named one created outside pi-lens.
	it("lists the Go files beside the call's Go files that the call does not list", () => {
		const root = workspace("pi-lens-4346-gopkg-");
		const pkg = path.join(root, "pkg");
		fs.mkdirSync(pkg);
		for (const name of ["a.go", "b.go", "c.go", "notes.md"]) {
			fs.writeFileSync(path.join(pkg, name), "package pkg\n");
		}
		fs.mkdirSync(path.join(pkg, "nested.go"));
		const other = path.join(root, "other.ts");
		fs.writeFileSync(other, "export {};\n");

		const peers = goPackageFilesToAnnounce([
			path.join(pkg, "a.go"),
			path.join(pkg, "b.go"),
			other,
		]).map((file) => toPosix(path.relative(root, file)));

		expect(peers).toEqual(["pkg/c.go"]);
		expect(goPackageFilesToAnnounce([other])).toEqual([]);
	});
});
