/**
 * #4638 F8: the tree has ONE JSONC reader. `clients/review-graph/tsconfig-paths.ts`
 * owns `parseJsonc` (comments and trailing commas, string-aware), and every
 * consumer — tsconfig discovery, pyright's `pythonVersion` — asks it. A second
 * stripper would answer the same question twice, which is exactly the fork this
 * sweep exists to keep deleted.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["clients", "tools"].map((dir) => path.join(REPO_ROOT, dir));
// The owner's name, in every definition spelling: a declaration or a binding
// (`const parseJsonc = (…) =>`), so an arrow cannot sidestep the count (#4638 r3
// N6).
const DEFINITION =
	/\bfunction\s+parseJsonc\s*[<(]|\b(?:const|let|var)\s+parseJsonc\b/;
const EXPORTED_DEFINITION =
	/\bexport\s+function\s+parseJsonc\s*[<(]|\bexport\s+(?:const|let|var)\s+parseJsonc\b/;
// A second reader under the owner's old helper names.
const SECOND_READER = /\bstripJsonc\w*|\bskipJsonc\w*/;
// A second reader under ANY name: JSONC text only reaches `JSON.parse` after a
// trailing-comma strip, and the regex spelling of that strip is a literal that
// opens with a comma and closes over a bracket (`/,\s*([}\]])/g`,
// `/,(?=\s*})/g`). Regex bodies survive only under `strings: "keep"`. The owner
// strips with a lookahead loop, which this does not match, so the owner needs no
// exemption. Rule bound, stated plainly: a hand-rolled loop under another name
// stays a reviewer's screen, not this test's (AGENTS.md shape 69).
const TRAILING_COMMA_STRIP = /\/,[^/\n]*[}\]][^/\n]*\/[dgimsuvy]*/;

interface LineHit {
	file: string;
	line: number;
	text: string;
}

/** Line hits of `pattern` in comment-and-string-blanked (or regex-kept) text. */
function scanText(
	pattern: RegExp,
	source: string,
	strings: "blank" | "keep" = "blank",
): Array<{ line: number; text: string }> {
	const hits: Array<{ line: number; text: string }> = [];
	// Comments blanked (and strings, unless the needle lives in a regex body):
	// only real code can match, so a doc comment naming the helper is not a
	// second implementation.
	const scanned = stripSource(source, { strings }).split("\n");
	for (let index = 0; index < scanned.length; index += 1) {
		const text = scanned[index] ?? "";
		if (pattern.test(text)) hits.push({ line: index + 1, text: text.trim() });
	}
	return hits;
}

function scan(pattern: RegExp, strings: "blank" | "keep" = "blank"): LineHit[] {
	const hits: LineHit[] = [];
	for (const root of ROOTS) {
		for (const absolute of listSourceFiles(root)) {
			const source = readWalkedFile(absolute);
			if (source === undefined) continue;
			for (const hit of scanText(pattern, source, strings)) {
				hits.push({ ...hit, file: relativePosix(REPO_ROOT, absolute) });
			}
		}
	}
	return hits;
}

describe("the JSONC reader has one owner (#4638 F8)", () => {
	it(
		"defines parseJsonc exactly once, exported, and no second reader",
		() => {
			const scannedFiles = ROOTS.flatMap((root) => listSourceFiles(root));
			assertNonEmptyScan(
				"JSONC reader sweep (clients + tools)",
				scannedFiles.length,
				50,
			);

			expect(scan(DEFINITION).map((hit) => hit.file)).toEqual([
				"clients/review-graph/tsconfig-paths.ts",
			]);
			expect(scan(EXPORTED_DEFINITION).map((hit) => hit.file)).toEqual([
				"clients/review-graph/tsconfig-paths.ts",
			]);
			expect(scan(SECOND_READER)).toEqual([]);
			expect(scan(TRAILING_COMMA_STRIP, "keep")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence (#4638 r3 N6): the first form of this sweep matched the owner's
	// name only, so a second reader as an arrow binding or under another name
	// stayed green. Each plant below is a spelling its author did not design for.
	describe("plants a second reader in spellings the name list never saw", () => {
		it("sees an arrow binding of the owner's name", () => {
			const plant =
				"export const parseJsonc = (content: string) => JSON.parse(content);\n";
			expect(scanText(DEFINITION, plant)).toHaveLength(1);
			expect(scanText(EXPORTED_DEFINITION, plant)).toHaveLength(1);
		});

		it("sees a renamed reader that strips trailing commas with a regex", () => {
			const plant = [
				"export function parseJsonWithComments(content: string) {",
				'\treturn JSON.parse(content.replace(/,\\s*([}\\]])/g, "$1"));',
				"}",
				"",
			].join("\n");
			expect(scanText(TRAILING_COMMA_STRIP, plant, "keep")).toHaveLength(1);
		});

		it("sees the same strip behind an alias of the regex", () => {
			const plant =
				"const TRAILING = /,(?=\\s*[}\\]])/g;\nexport const readCfg = (t: string) => JSON.parse(t.replace(TRAILING, ''));\n";
			expect(scanText(TRAILING_COMMA_STRIP, plant, "keep")).toHaveLength(1);
		});

		it("ignores a comment that only quotes the pattern", () => {
			const plant = "// strips /,\\s*([}\\]])/g like the owner\nconst x = 1;\n";
			expect(scanText(TRAILING_COMMA_STRIP, plant, "keep")).toEqual([]);
		});
	});
});
