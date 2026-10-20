/**
 * #4596: every implicit-scope question that cannot be answered is recorded
 * with its file and its cause.
 *
 * The defect the audit proved (probe 1). `classifyJsTsGlobalScope` read a file
 * it could not open, caught the failure, and answered `"unknown"` with no row
 * anywhere: `feedsJsTsGlobalScope` then read `"unknown"` as feeding the global
 * scope, so a module judged wrong made the diagnostics cache refuse its entry
 * and nothing explained why. The same silence sat on four siblings in the same
 * file (a Go directory that cannot be listed, a Go peer's header, a Go
 * package's mtime, and a parse that throws), so the fix sweeps the file rather
 * than the instance (AGENTS.md shape 31: a failure path's only trace must not
 * be a caller's inference).
 *
 * The verdicts are deliberately UNCHANGED: `"unknown"` still fails closed, so
 * the cache refuses rather than serves. Only the silence is the defect here.
 *
 * Cells, written before the fix. Each failure is REAL, produced by the
 * filesystem itself, so no seam is doubled: a path that is a directory where a
 * file is expected (EISDIR), and a path that went away between the walk and
 * the read (ENOENT) — the race each arm exists for. The parse arm is the
 * parser's own throw, injected into the loaded module for one call.
 *
 * | Arm | Injected failure | Verdict | Record |
 * |---|---|---|---|
 * | unreadable JS/TS file | the path is a directory, so the read throws EISDIR | `"unknown"`, `feedsJsTsGlobalScope` true | `unreadable-file` + the path + the error |
 * | unreadable Go directory | the package directory is gone (ENOENT) | `goPackageFiles` undefined | `unreadable-go-dir` + the dir |
 * | Go package mtime | the package directory is gone (ENOENT) | `goPackageChangedAt` undefined | `unreadable-mtime` + the dir |
 * | Go peer header | the peer is gone between the listing and the read | no peer admitted | `unreadable-go-peer` + the peer |
 * | parse throws | the parser itself throws | `"unknown"` | `parse-failed` + the path |
 * | control: a module with `import` | none | `"none"` | no row |
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAstGrepNapiSync } from "../../../clients/deps/ast-grep-napi.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import {
	classifyJsTsGlobalScope,
	feedsJsTsGlobalScope,
	goPackageChangedAt,
	goPackageFiles,
	goPackagePeersOf,
} from "../../../clients/lsp/implicit-scope.js";

let root: string;
const cleanups: Array<() => void> = [];

/** Rows this change's record wrote, one group per cause. */
function unknownRows(): Array<{
	kind: string;
	count: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}> {
	return getDegradationSummary().filter(
		(group) => group.kind === "lsp-implicit-scope-unknown",
	);
}

function reasonFor(cause: string): string | undefined {
	return unknownRows().find(
		(group) => group.latestReasons[0]?.subject === cause,
	)?.latestReasons[0]?.reason;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4596-scope-"));
	resetDegradationLedger();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("an implicit-scope answer that could not be derived", () => {
	it("records the unreadable file and keeps the conservative verdict", () => {
		// A directory whose name reads as a TypeScript file: the read throws
		// EISDIR, the same arm as an EACCES on a file pi-lens may not read.
		const moduleDir = path.join(root, "module.ts");
		fs.mkdirSync(moduleDir);

		expect(classifyJsTsGlobalScope(moduleDir)).toBe("unknown");
		expect(feedsJsTsGlobalScope(moduleDir)).toBe(true);
		const reason = reasonFor("unreadable-file");
		expect(reason).toContain(moduleDir);
		expect(reason).toContain("EISDIR");
	});

	it("records a Go directory that went away before it could be listed", () => {
		const pkg = path.join(root, "gone-pkg");
		fs.mkdirSync(pkg);
		fs.writeFileSync(path.join(pkg, "a.go"), "package p\n");
		fs.rmSync(pkg, { recursive: true });

		expect(goPackageFiles(pkg)).toBeUndefined();
		const reason = reasonFor("unreadable-go-dir");
		expect(reason).toContain(pkg);
		expect(reason).toContain("ENOENT");
	});

	it("records a Go package whose mtime cannot be read", () => {
		const pkg = path.join(root, "gone-mtime");
		fs.mkdirSync(pkg);
		fs.rmSync(pkg, { recursive: true });

		expect(goPackageChangedAt(pkg)).toBeUndefined();
		const reason = reasonFor("unreadable-mtime");
		expect(reason).toContain(pkg);
		expect(reason).toContain("ENOENT");
	});

	it("records a Go peer that went away before its header was read", () => {
		const pkg = path.join(root, "pkg-peer");
		fs.mkdirSync(pkg);
		const own = path.join(pkg, "a.go");
		fs.writeFileSync(own, "package p\n");
		const peer = path.join(pkg, "b.go");
		fs.writeFileSync(peer, "package p\n");

		const admits = goPackagePeersOf(own);
		expect(admits).toBeDefined();
		fs.rmSync(peer);
		expect(admits?.(peer)).toBe(false);
		expect(reasonFor("unreadable-go-peer")).toContain(peer);
	});

	it("records a parse that throws and keeps the conservative verdict", () => {
		const modulePath = path.join(root, "broken.ts");
		fs.writeFileSync(modulePath, "export const value = 1;\n");
		const napi = loadAstGrepNapiSync();
		expect(napi).toBeDefined();
		const parse = (napi as { parse: unknown }).parse;
		(napi as { parse: unknown }).parse = () => {
			throw new Error("parser exploded");
		};
		cleanups.push(() => {
			(napi as { parse: unknown }).parse = parse;
		});

		expect(classifyJsTsGlobalScope(modulePath)).toBe("unknown");
		expect(feedsJsTsGlobalScope(modulePath)).toBe(true);
		const reason = reasonFor("parse-failed");
		expect(reason).toContain(modulePath);
		expect(reason).toContain("parser exploded");
	});

	it("writes no row for a module it can answer for", () => {
		const modulePath = path.join(root, "clean.ts");
		fs.writeFileSync(modulePath, "export const value = 1;\n");

		expect(classifyJsTsGlobalScope(modulePath)).toBe("none");
		expect(unknownRows()).toEqual([]);
	});

	it("writes the file, the cause and the error into the durable row", async () => {
		// The in-process summary carries the reason; only the durable row carries
		// metadata, so a monitor reading `latency.log` sees `file`/`cause`/`err`
		// here or not at all (#4603 review, the P2 row-read thread).
		// `PI_LENS_TEST_MODE=0` is the sanctioned opt-out that lets the real sink
		// write into the worker's own hermetic home, scoped to this case.
		const moduleDir = path.join(root, "durable.ts");
		fs.mkdirSync(moduleDir);

		const previousMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		await flushLatencyLog();
		try {
			expect(classifyJsTsGlobalScope(moduleDir)).toBe("unknown");
			await flushLatencyLog();
		} finally {
			if (previousMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousMode;
		}

		const rows = fs
			.readFileSync(getLatencyLogPath(), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter(
				(row) =>
					(row.metadata as Record<string, unknown> | undefined)?.kind ===
					"lsp-implicit-scope-unknown",
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject({
			file: moduleDir,
			cause: "unreadable-file",
		});
		expect(String((rows[0].metadata as Record<string, unknown>).err)).toContain(
			"EISDIR",
		);
	});
});
