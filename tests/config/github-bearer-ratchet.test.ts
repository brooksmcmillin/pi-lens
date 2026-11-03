import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	lineOf,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

// Recurrence #4422 review F3 (#4427): five request blocks in `scripts/` each
// built their own GitHub header set after #4422 had already folded four other
// copies onto `scripts/lib/github-rest.mjs`. A `Bearer` header is the part of
// that block no test sees drift in (a token scheme change, a missing API
// version). This ratchet reds on a `Bearer` spelled in `scripts/` outside the
// helper and the named exceptions below, so the next copy folds onto the
// helper instead of adding a seventh.
const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPTS = resolve(ROOT, "scripts");
const HELPER = "scripts/lib/github-rest.mjs";

/**
 * Files that may still build their own Bearer header, each with why the helper
 * cannot serve it. Empty since #4435 round 2 folded ci-verdict.mjs and
 * lib/label-triage.mjs, whose blocks were byte-identical to `githubHeaders`.
 * Admitting a file here is a decision, not a registration: it needs a reason
 * that names what the helper cannot express.
 */
export const ALLOWED_BEARER_FILES: Readonly<Record<string, string>> = {};

// Two needles, so a scheme assembled out of sight of the literal
// (`["Bea", "rer"].join("")`, a `token ${t}` scheme in another module) still
// shows at the Authorization header it is assigned to (#4435 review F2).
const HEADER_NEEDLE = /\bbearer\b|\bauthorization\b["'`\]]*\s*[:=]/gi;

/** `line` of every `Bearer` or `Authorization:` header spelled in code (comments blanked, strings kept). */
export function bearerLines(source: string): number[] {
	const code = stripSource(source, { strings: "keep" });
	return [
		...new Set(
			[...code.matchAll(HEADER_NEEDLE)].map((m) => lineOf(code, m.index)),
		),
	];
}

describe("a GitHub Bearer header is built in one place (#4427, #4422 F3)", () => {
	const files = listSourceFiles(SCRIPTS, {
		extensions: [".mjs", ".js", ".cjs", ".ts", ".mts"],
	});
	const hits = new Map(
		files.map((file) => [
			relativePosix(ROOT, file),
			bearerLines(readFileSync(file, "utf8")),
		]),
	);

	it(
		"spells Bearer only in the helper and the named exceptions",
		() => {
			assertNonEmptyScan("scripts/ sources", files.length, 50);
			const stray = [...hits]
				.filter(([file, lines]) => lines.length > 0 && file !== HELPER)
				.filter(([file]) => !(file in ALLOWED_BEARER_FILES))
				.map(
					([file, lines]) =>
						`${file}:${lines.join(",")}: build the header with githubHeaders/githubFetcher from scripts/lib/github-rest.mjs, or admit the file in ALLOWED_BEARER_FILES with the reason the helper cannot serve it`,
				);
			expect(stray).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"keeps the helper as the real home and every exception live",
		() => {
			// A helper that stopped spelling Bearer, or an exception whose file
			// folded, would leave the ratchet guarding nothing.
			expect(hits.get(HELPER)?.length, HELPER).toBeGreaterThan(0);
			for (const [file, reason] of Object.entries(ALLOWED_BEARER_FILES)) {
				expect(
					hits.get(file)?.length,
					`${file}: stale exception`,
				).toBeGreaterThan(0);
				expect(reason.length, `${file}: reason`).toBeGreaterThan(40);
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("the scan reads code, not prose", () => {
		it.each([
			["a template literal", "const h = `Bearer ${token}`;\n", [1]],
			["a quoted literal", 'const h = "Bearer " + token;\n', [1]],
			["a lowercase scheme", 'const h = "bearer " + token;\n', [1]],
			[
				"an Authorization key with an assembled scheme",
				'const h = { Authorization: ["Bea", "rer"].join("") + t };\n',
				[1],
			],
			[
				"a lowercase authorization key",
				"const h = { authorization: t };\n",
				[1],
			],
			[
				"a quoted authorization key",
				'const h = { "Authorization": t };\n',
				[1],
			],
			[
				"an authorization member assignment",
				"headers.Authorization = t;\n",
				[1],
			],
			["a bracket authorization key", 'headers["authorization"] = t;\n', [1]],
			[
				"a second line",
				"const a = 1;\nheaders.Authorization = `Bearer ${t}`;\n",
				[2],
			],
		])("finds %s", (_name, source, lines) => {
			expect(bearerLines(source)).toEqual(lines);
		});

		it.each([
			["a line comment", "// sends a Bearer token\n"],
			["a block comment", "/* Bearer */\n"],
			["an identifier containing it", "const bearerless = 1;\n"],
			[
				"the word in prose inside a string",
				'const m = "needs explicit authorization with --force";\n',
			],
			["a comment naming the header", "// Authorization: Bearer x\n"],
		])("ignores %s", (_name, source) => {
			expect(bearerLines(source)).toEqual([]);
		});
	});
});
