import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripSource } from "../support/sweep-kit.js";

// Recurrence #4411 round 2 F6: `clients/lsp/index.ts` carries a comment that
// its import surface from `./config.js` stays as it is (#2052), because ~58
// test files mirror that surface in explicit `vi.mock` factories and every new
// symbol breaks all of them. Only the comment enforced it, and #4411 round 2
// added a symbol there anyway. This test pins the exact list; widening the
// surface is a deliberate edit of EXPECTED below, made with the mock
// dependents in view.
const ROOT = resolve(import.meta.dirname, "../..");
const INDEX_PATH = resolve(ROOT, "clients/lsp/index.ts");
const EXPECTED = ["getServersForFileWithConfig"];

const CONFIG_SPECIFIER = /["']\.\/config\.js["']/g;
const NAMED_FROM = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*$/;

/**
 * Every symbol the module takes from `./config.js`, as the exported names it
 * asks for. A form that takes the whole surface (`import * as`, a default
 * import, `export *`, a bare `import("./config.js")`) reports `*`, so it
 * cannot slip past an exact-list comparison. Scans comment-blanked text with
 * string contents kept: the specifier is itself a string literal.
 */
export function configImportSurface(source: string): string[] {
	const code = stripSource(source, { strings: "keep" });
	const taken: string[] = [];
	for (const match of code.matchAll(CONFIG_SPECIFIER)) {
		const before = code.slice(0, match.index);
		const named = NAMED_FROM.exec(before);
		if (!named) {
			taken.push("*");
			continue;
		}
		for (const part of named[1].split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				.trim();
			if (name) taken.push(name);
		}
	}
	return taken.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("clients/lsp/index.ts import surface from ./config.js (#2052)", () => {
	it("takes exactly the pinned symbols from ./config.js", () => {
		expect(configImportSurface(readFileSync(INDEX_PATH, "utf8"))).toEqual(
			EXPECTED,
		);
	});

	describe("the extractor reads the surface, not the prose", () => {
		const header =
			'import { getServersForFileWithConfig } from "./config.js";\n';
		it.each([
			["the pinned import", header, EXPECTED],
			[
				"an added named symbol",
				'import { getServersForFileWithConfig, getConfigPath } from "./config.js";\n',
				["getConfigPath", "getServersForFileWithConfig"],
			],
			[
				"an added symbol on a second statement",
				`${header}import { getConfigPath } from "./config.js";\n`,
				["getConfigPath", "getServersForFileWithConfig"],
			],
			[
				"a multi-line import with an alias and a type modifier",
				'import {\n\ttype ServerConfig as S,\n\tgetServersForFileWithConfig as g,\n} from "./config.js";\n',
				["ServerConfig", "getServersForFileWithConfig"],
			],
			[
				"a type-only import",
				'import type { ServerConfig } from "./config.js";\n',
				["ServerConfig"],
			],
			[
				"a re-export",
				`${header}export { getConfigPath } from "./config.js";\n`,
				["getConfigPath", "getServersForFileWithConfig"],
			],
			["a namespace import", 'import * as cfg from "./config.js";\n', ["*"]],
			["a default import", 'import cfg from "./config.js";\n', ["*"]],
			["a dynamic import", 'const m = await import("./config.js");\n', ["*"]],
			["a star re-export", 'export * from "./config.js";\n', ["*"]],
			[
				"a comment that names the specifier",
				`${header}// import { x } from "./config.js";\n/* import { y } from './config.js' */\n`,
				EXPECTED,
			],
			[
				"a different module that ends in config.js",
				`${header}import { z } from "./lsp-config.js";\nimport { w } from "../config.js";\n`,
				EXPECTED,
			],
		])("%s", (_name, source, surface) => {
			expect(configImportSurface(source)).toEqual(surface);
		});
	});
});
