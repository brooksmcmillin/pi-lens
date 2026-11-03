/**
 * #4709 slice 4a: the server-selection setter on `clients/lsp/config.ts`.
 *
 * Recurrence it prevents: 73 suites faked `getServersForFileWithConfig` with a
 * whole-module `vi.mock` because the module had no seam for a per-test server
 * list (shape 66). The setter is that seam. A setter that survives
 * `resetLSPConfigStateForTests` leaks one case's servers into the next, and a
 * setter a product path can reach turns a test hook into a way to pick which
 * language server runs.
 *
 * Real: the config module and its selection gate; nothing is mocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_setServersForFileForTests,
	getServersForFileWithConfig,
	primaryServerId,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../../support/sweep-kit.js";
import { repoRoot } from "../../support/flake-shape-scan.js";

afterEach(() => {
	resetLSPConfigStateForTests();
});

const SETTER = "_setServersForFileForTests";

/**
 * A source that USES the setter. Comments are blanked (prose is no use); string
 * literals are kept, because `mod["_set..."]` is a use the identifier scan
 * would miss.
 */
const namesSetter = (source: string): boolean =>
	stripSource(source, { strings: "keep" }).includes(SETTER);

describe("_setServersForFileForTests", () => {
	it("answers getServersForFileWithConfig and the primary lookup derived from it", () => {
		const [real] = getServersForFileWithConfig("/repo/a.ts");
		expect(real.id).toBe("typescript");

		const injected = { ...real, id: "injected" };
		_setServersForFileForTests((file) =>
			file.endsWith(".ts") ? [injected] : [],
		);

		expect(getServersForFileWithConfig("/repo/a.ts")).toEqual([injected]);
		expect(getServersForFileWithConfig("/repo/a.py")).toEqual([]);
		// `primaryServerId` calls the gate internally, so the injected list is
		// what a downstream consumer sees, not only the direct caller.
		expect(primaryServerId("/repo/a.ts")).toBe("injected");
	});

	it("is dropped by resetLSPConfigStateForTests", () => {
		_setServersForFileForTests(() => []);
		expect(getServersForFileWithConfig("/repo/a.ts")).toEqual([]);

		resetLSPConfigStateForTests();

		expect(
			getServersForFileWithConfig("/repo/a.ts").map((s) => s.id),
		).toContain("typescript");
	});

	it("is dropped by passing undefined", () => {
		_setServersForFileForTests(() => []);
		_setServersForFileForTests(undefined);
		expect(
			getServersForFileWithConfig("/repo/a.ts").map((s) => s.id),
		).toContain("typescript");
	});

	it("ignores an arm outside a Vitest process", () => {
		const prior = process.env.VITEST;
		delete process.env.VITEST;
		try {
			_setServersForFileForTests(() => []);
		} finally {
			process.env.VITEST = prior;
		}
		expect(
			getServersForFileWithConfig("/repo/a.ts").map((s) => s.id),
		).toContain("typescript");
	});

	it("is named by no product source file", () => {
		// Product source = everything shipped: clients, tools, mcp, scripts and
		// the entry file. Only the defining module (and its built twin) may carry the name.
		const defining = new Set(
			["ts", "js"].map((ext) =>
				path.join(repoRoot, `clients/lsp/config.${ext}`),
			),
		);
		const roots = ["clients", "tools", "mcp", "scripts"].map((dir) =>
			path.join(repoRoot, dir),
		);
		const files = [
			path.join(repoRoot, "index.ts"),
			...roots.flatMap((root) =>
				fs.existsSync(root)
					? listSourceFiles(root, {
							extensions: [".ts", ".mjs", ".js"],
							skipTests: true,
						})
					: [],
			),
		].filter((file) => !defining.has(file));
		assertNonEmptyScan("product source files", files.length, 100);
		const naming = files
			.filter((file) => namesSetter(fs.readFileSync(file, "utf8")))
			.map((file) => relativePosix(repoRoot, file));
		expect(naming.join(",")).toBe("");
	});

	it("reads code, not prose: a comment that mentions the setter is no use of it", () => {
		// Recurrence: a raw-text scan reds on a doc comment in `clients/` that
		// documents the seam (greptile thread on #4779), so a harmless comment
		// fails the suite without any product path reaching the setter.
		expect(namesSetter(`// ${SETTER} is test-only\nexport const x = 1;`)).toBe(
			false,
		);
		expect(namesSetter(`/** see ${SETTER} */\nexport const x = 1;`)).toBe(
			false,
		);
		expect(namesSetter(`const f = mod["${SETTER}"];`)).toBe(true);
		expect(namesSetter(`import { ${SETTER} } from "./config.js";`)).toBe(true);
		expect(namesSetter(`${SETTER}(() => []);`)).toBe(true);
	});
});
