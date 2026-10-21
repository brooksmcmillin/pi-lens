/**
 * `lineTextAt` moved here from `position-encoding.ts` (#2066): line addressing
 * of document content is one domain, owned by `clients/lsp/content-scan.ts`,
 * not by the position-encoding core that only consumes it.
 */

import { describe, expect, it } from "vitest";
import {
	countLfNewlines,
	lineTextAt,
} from "../../../clients/lsp/content-scan.js";

describe("lineTextAt (#269)", () => {
	it("returns the 0-based line text", () => {
		const content = "first\nsecond\nthird";
		expect(lineTextAt(content, 0)).toBe("first");
		expect(lineTextAt(content, 1)).toBe("second");
		expect(lineTextAt(content, 2)).toBe("third");
	});

	it("returns empty string for out-of-range lines", () => {
		expect(lineTextAt("only", 5)).toBe("");
		expect(lineTextAt("only", -1)).toBe("");
	});
});

/**
 * #2066: `lineTextAt` used to be `content.split("\n")[line] ?? ""` — one
 * substring per line, materialized to read one of them (0.65 ms on a 1.95 MB
 * document, on the diagnostic-conversion call sites). The bounded scan that
 * replaced it must answer EXACTLY what the split answered, including its
 * peculiar corners: `\n` is the only separator (a `\r` stays in the line), a
 * line past the end is `""`, and a fractional index reads no line at all
 * (`lines[1.5]` is `undefined`).
 */
describe("lineTextAt answers what the split it replaced answered (#2066)", () => {
	/** The pre-fix implementation, kept as the reference. */
	const reference = (content: string, line: number): string =>
		content.split("\n")[line] ?? "";

	const EDGE_CASES: ReadonlyArray<readonly [string, number]> = [
		["", 0],
		["", -1],
		["\n", 0],
		["\n", 1],
		["\n", 2],
		["a\n", 1],
		["a\r\nb\r\n", 1],
		["a\rb\rc", 1],
		["a\r\nb\rc\n", 2],
		["a\r\nb\rc\n", 3],
		["🙂 é\nx", 0],
		["last", 0],
		["last", 1],
		["a\nb", 0.5],
		["a\nb", Number.NaN],
		["a\nb", Number.POSITIVE_INFINITY],
	];

	for (const [content, line] of EDGE_CASES) {
		it(`matches the split for ${JSON.stringify(content)} at line ${String(line)}`, () => {
			expect(lineTextAt(content, line)).toBe(reference(content, line));
		});
	}

	// The same 1,500-document shape the #4517 corpus walks (60 sequences x 25
	// edits): every document is asked for every line it has, plus one past each
	// end, so a boundary slip anywhere in the scan names a document.
	it("matches the split over 1,500 randomly edited documents, line by line", () => {
		let seed = 0x2066;
		const random = (): number => {
			// mulberry32: deterministic, so a red names a reproducible document.
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)];
		const POOLS: readonly (readonly string[])[] = [
			["ab", "é", "x y", "\n"], // LF-only
			["ab", "🙂", "\r\n"], // CRLF-only
			["ab", "\r", "c"], // lone CR
			["a", "\n", "\r", "\r\n", "🙂", ""], // mixed
		];
		const randomText = (pool: readonly string[]): string => {
			const pieces = Math.floor(random() * 12);
			let text = "";
			for (let i = 0; i < pieces; i++) text += pick(pool);
			return text;
		};

		let documentsChecked = 0;
		for (let sequence = 0; sequence < 60; sequence++) {
			const pool = POOLS[sequence % POOLS.length];
			let doc = sequence % 5 === 0 ? "" : randomText(pool);
			for (let step = 0; step < 25; step++) {
				const lineCount = doc.split("\n").length;
				for (let line = -1; line <= lineCount; line++) {
					expect(
						lineTextAt(doc, line),
						`${JSON.stringify(doc)} line ${line}`,
					).toBe(reference(doc, line));
				}
				documentsChecked++;

				// The next document: splice a random span out and random text in
				// (deletes, inserts, and replacements across line boundaries).
				const from = Math.floor(random() * (doc.length + 1));
				const to = Math.min(
					doc.length,
					from + (random() < 0.5 ? 0 : Math.floor(random() * 6)),
				);
				doc = `${doc.slice(0, from)}${randomText(random() < 0.15 ? pick(POOLS) : pool)}${doc.slice(to)}`;
			}
		}
		expect(documentsChecked).toBe(60 * 25);
	});
});

/**
 * #2066 review F1: the LF count is the one answer that needs no terminator
 * knowledge — `\r\n` carries exactly one `\n`, a lone `\r` none — so it is the
 * `\n` count on every document. `countLfNewlines` is the entry point the sync
 * bound asks, so that a document holding a `\r` does not pay the per-character
 * loop `lastLine` needs (the loop made the bound check 4.6x-5.5x slower until
 * this round). Each row is pinned against the split the bound check used.
 */
describe("countLfNewlines answers the split's line count on every terminator (#2066)", () => {
	const DOCUMENTS: ReadonlyArray<readonly [string, string]> = [
		["an empty document", ""],
		["LF content", "first\nsecond\nthird"],
		["CRLF content", "a\r\nb\r\nc\r\n"],
		["lone-CR content", "a\rb\rc"],
		["mixed terminators", "a\r\nb\rc\nd\r\n"],
		["an astral glyph", "🙂 é\nx"],
		["a trailing newline", "a\nb\n"],
		["no trailing newline", "a\nb"],
		["CRLF at the line bound", "a\r\n".repeat(4999)],
	];

	for (const [name, content] of DOCUMENTS) {
		it(`counts the split's newlines for ${name}`, () => {
			expect(countLfNewlines(content)).toBe(content.split("\n").length - 1);
		});
	}
});
