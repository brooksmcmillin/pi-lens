// flake-shape: in-process-mock — the native addon's load is the host boundary; its sync loader is the only seam to make it fail
/**
 * #4346: `feedsJsTsGlobalScope` parses a created JS/TS file with the
 * ast-grep native addon. When the addon does not load, it fails closed (the
 * file counts as feeding the global scope, so the cache refuses) and records
 * that once per session. Recurrence: the fail-closed branch was silent, so a
 * host without the addon refused every clean JS/TS entry on every creation
 * with no record of why.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// Host boundary: the native addon's load.
vi.mock("../../../clients/deps/ast-grep-napi.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/deps/ast-grep-napi.js")
	>()),
	loadAstGrepNapiSync: () => undefined,
}));

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("feedsJsTsGlobalScope without the native addon (#4346)", () => {
	it("counts a module as feeding the global scope and records it once", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-napi-4346-"));
		dirs.push(dir);
		const first = path.join(dir, "a.ts");
		const second = path.join(dir, "b.ts");
		fs.writeFileSync(first, "export const a = 1;\n");
		fs.writeFileSync(second, "export const b = 1;\n");
		const { feedsJsTsGlobalScope } =
			await import("../../../clients/lsp/implicit-scope.js");
		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");

		expect(feedsJsTsGlobalScope(first)).toBe(true);
		expect(feedsJsTsGlobalScope(second)).toBe(true);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "ast-grep-napi-unavailable",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.reason).toContain(
			"every created JS/TS file counts",
		);
	});
});
