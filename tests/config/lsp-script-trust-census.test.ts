import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

// Recurrence #4514 (shape: a seam changed in the product, the standalone hosts
// under scripts/ that drive the built `dist/` copy were not swept). #4248 and
// #4269 made the LSP launch gate refuse project-local and project-code servers
// while project trust is "unknown". #4262 taught smoke-tools.mjs to adopt
// trust and swept nothing else, so characterize-lsp, probe-clean-signal,
// server-capabilities, measure-lsp-idle-eviction and bench-lsp measured
// `unknown` for ~30 of 54 rows from 2026-10-10 while the nightly stayed
// green. This census makes the next such script red at its own PR: every
// `scripts/*.mjs` that reaches `dist/clients/lsp/` must call the one shared
// adoption, `adoptFixtureProjectTrust`.
const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPTS = resolve(ROOT, "scripts");
const SHARED = "scripts/lib/lsp-fixture-workspace.mjs";

// The compiled-LSP path as a string, in every spelling a script uses: one
// literal, or `"dist", "clients", "lsp"` / `"dist/clients" + "/lsp/"` pieces.
// The evidence is itself a string literal, so this runs on text with comments
// blanked and strings kept.
const DIST_LSP = /dist[\s"'`+,/\\]+clients[\s"'`+,/\\]+lsp[\s"'`/\\]/;
// A CALL of the adoption, on text with comments AND strings blanked: a comment
// or a string naming the helper is not an adoption.
const ADOPTION_CALL = /\badoptFixtureProjectTrust\s*\(/;

export function reachesCompiledLsp(source: string): boolean {
	return DIST_LSP.test(stripSource(source, { strings: "keep" }));
}

export function adoptsFixtureTrust(source: string): boolean {
	return ADOPTION_CALL.test(stripSource(source, { strings: "blank" }));
}

/**
 * Scripts that name `dist/clients/lsp/` but never drive the service, with the
 * reason. An entry the scan stops flagging is stale and reds the audit.
 */
const EXEMPT: Record<string, string> = {
	"scripts/pre-push-targeted-tests.mjs":
		"names the compiled output path of server-traits.ts in its build-freshness table; it never imports or drives the LSP service",
};

describe("scripts that reach the built LSP service adopt project trust (#4514)", () => {
	const files = listSourceFiles(SCRIPTS, {
		extensions: [".mjs"],
		// Top-level entry points only: scripts/lib holds helpers and the shared
		// adoption itself, and a helper is judged through its entry point.
		exclude: (rel) => rel.includes("/"),
	});
	const sources = new Map(
		files.map((file) => [
			relativePosix(ROOT, file),
			readFileSync(file, "utf8"),
		]),
	);

	it(
		"every scripts/*.mjs importing dist/clients/lsp/ calls adoptFixtureProjectTrust",
		() => {
			const reaching = [...sources].filter(([, src]) =>
				reachesCompiledLsp(src),
			);
			// Dead-scan guard: the six harness entry points plus the exempt one.
			assertNonEmptyScan(
				"scripts reaching dist/clients/lsp/",
				reaching.length,
				7,
			);
			const audit = auditRegistry({
				sweepName: "lsp-script-trust-census",
				flagged: reaching
					.filter(([, src]) => !adoptsFixtureTrust(src))
					.map(([file]) => file),
				registered: [],
				exemptions: EXEMPT,
				scannedCount: files.length,
				minScanned: 40,
				remediation: `call adoptFixtureProjectTrust({ repoRoot }) from ${SHARED} before the first touch, or exempt the script with the reason it never drives the service`,
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence #4514 (net-count rule): smoke-tools.mjs carried three inline
	// copies of the adoption before it moved onto the shared helper. A script
	// that adopts trust itself, bypassing the helper, is the next copy.
	it(
		"no scripts/*.mjs adopts trust inline: the shared helper is the only caller",
		() => {
			const inline = [...sources]
				.filter(([, src]) =>
					/\badoptProjectTrustFromContext\s*\(/.test(
						stripSource(src, { strings: "blank" }),
					),
				)
				.map(([file]) => file);
			expect(inline).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence #4514 acceptance 2: a refusal must be named in the row. The
	// call sites live in two entry points that execute on import, so the pin is
	// a scan: reverting either leaves every unit test green and the nightly
	// printing "no publish observed" for a server that never launched.
	it(
		"characterize-lsp and probe-clean-signal name a trust refusal (call-site pin)",
		() => {
			for (const [file, needle] of [
				["scripts/characterize-lsp.mjs", /\bfixtureTrustRefusal\s*\(/],
				["scripts/probe-clean-signal.mjs", /\btrustRefusal\s*:\s*\(\)\s*=>/],
			] as const) {
				const stripped = stripSource(sources.get(file) ?? "", {
					strings: "blank",
				});
				expect(stripped, file).toMatch(needle);
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("the detector reads code, not prose", () => {
		const adopt = "await adoptFixtureProjectTrust({ repoRoot });";
		it.each([
			["a real call", adopt, true],
			[
				"a call inside an async function",
				`async function f() { ${adopt} }`,
				true,
			],
			["a line comment naming the call", `// ${adopt}`, false],
			["a block comment naming the call", `/* ${adopt} */`, false],
			["a string naming the call", `const s = "${adopt}";`, false],
			["a template naming the call", `const s = \`${adopt}\`;`, false],
			[
				"an import with no call",
				`import { adoptFixtureProjectTrust } from "./x.mjs";`,
				false,
			],
		])("adoption: %s", (_name, source, expected) => {
			expect(adoptsFixtureTrust(source)).toBe(expected);
		});

		// Plants a script author did not design for: an alias, an indirect
		// import and a value reached through another binding.
		it.each([
			[
				"a literal specifier",
				`await import("../dist/clients/lsp/index.js");`,
				true,
			],
			[
				"path pieces",
				`path.join(root, "dist", "clients", "lsp", "index.js")`,
				true,
			],
			[
				"an alias of the pieces",
				`const lspDir = path.join("dist", "clients", "lsp");`,
				true,
			],
			[
				"an indirect importer",
				`const imp = (r) => import(r);\nimp("dist/clients/lsp/config.js");`,
				true,
			],
			[
				"a template specifier",
				"import(`${root}/dist/clients/lsp/index.js`)",
				true,
			],
			[
				"a concatenation in one expression",
				`"dist/clients" + "/lsp/index.js"`,
				true,
			],
			["a sibling directory", `import("dist/clients/lsp-lazy.js")`, false],
			["a comment naming the path", `// dist/clients/lsp/index.js`, false],
			// RESIDUAL (stated in the PR body): a value built across statements
			// (`const base = "dist/clients"; ... base + "/lsp/x.js"`) is not seen.
			[
				"a binding reached across statements",
				`const base = "dist/clients";\nimport(base + "/lsp/x.js");`,
				false,
			],
		])("compiled-LSP reach: %s", (_name, source, expected) => {
			expect(reachesCompiledLsp(source)).toBe(expected);
		});
	});
});
