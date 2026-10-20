/**
 * #1649: `scanFileLines` replaced every read-accounting `readFileSync(path,
 * "utf-8").split(/\r?\n/)` (`countFileLines`, the `recordRead` disk capture).
 * Its count and line hashes feed the read guard's coverage, staleness and
 * relocation verdicts, so they must equal what the released split gave on the
 * same bytes. The oracle below is that released derivation, written out once:
 * it is the behaviour being preserved, not the new code restated (the scan
 * works on bytes in 64 KiB chunks and never builds the string it splits).
 *
 * Recurrences prevented: a line that straddles a chunk boundary, a `\r\n`
 * split across two chunks, a lone `\r` at EOF, a BOM, or an invalid UTF-8
 * sequence before a newline changing a count or a hash, which would move a
 * staleness verdict without any test of the guard noticing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { lineContentHash, scanFileLines } from "../../clients/read-guard.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { setupTestEnvironment } from "./test-utils.js";

const env = setupTestEnvironment("pi-lens-1649-scan-");
afterAll(() => env.cleanup());

const CHUNK = 64 * 1024;
const READ_HASH_MAX_LINES = 3000;

/** The released derivation: whole-file decode, then `split(/\r?\n/)`. */
function released(bytes: Buffer): {
	count: number;
	hashes: (offset: number, limit: number) => Record<number, string> | undefined;
} {
	const content = bytes.toString("utf8");
	const lines = content.split(/\r?\n/);
	return {
		count: content.length === 0 ? 1 : lines.length,
		hashes(offset, limit) {
			if (limit <= 0 || limit > READ_HASH_MAX_LINES) return undefined;
			const start = Math.max(1, offset);
			const end = Math.min(lines.length, offset + limit - 1);
			const slice = lines.slice(start - 1, end);
			if (slice.length === 0) return undefined;
			const out: Record<number, string> = {};
			slice.forEach((line, i) => {
				out[start + i] = lineContentHash(line);
			});
			return out;
		},
	};
}

let seq = 0;
function fileWith(bytes: Buffer): string {
	const file = path.join(env.tmpDir, `f${seq++}.txt`);
	fs.writeFileSync(file, bytes);
	return file;
}

/** Bytes rich in separators, multi-byte text, and invalid UTF-8. */
const piece = fc.oneof(
	fc.constantFrom("\n", "\r\n", "\r", "\r\r\n", "﻿", "é", "€", "𝄞", " \t"),
	fc.string({ maxLength: 12 }),
	fc
		.uint8Array({ minLength: 1, maxLength: 3 })
		.map((a) => Buffer.from(a).toString("latin1")),
	fc.constantFrom("\xE2", "\xF0\x9F", "\xC3"),
);
const bodyArb = fc
	.array(piece, { maxLength: 60 })
	.map((parts) => Buffer.from(parts.join(""), "latin1"));

/** Pad so the generated body straddles the first chunk boundary. */
const straddleArb = fc
	.tuple(fc.integer({ min: -6, max: 6 }), bodyArb)
	.map(([shift, body]) => {
		const pad = Buffer.alloc(Math.max(0, CHUNK - 3 + shift), 0x61);
		return Buffer.concat([pad, body]);
	});

/**
 * Offsets start at 0. Every `recordRead` caller passes an offset of at least
 * 1 (the native read, search and bash paths clamp it, the read bridge rejects
 * `offset < 1`, and edit, relocation and symbol ranges are 1-based). Only
 * `offset + limit - 1 < 0` differs: the released `slice(start - 1, end)` then
 * counted `end` back from the last line, which no caller can reach.
 */
const rangeArb = fc.tuple(
	fc.integer({ min: 0, max: 40 }),
	fc.integer({ min: -1, max: 40 }),
);

function assertParity(bytes: Buffer, ranges: Array<[number, number]>) {
	const file = fileWith(bytes);
	const want = released(bytes);
	expect(countFileLines(file)).toBe(want.count);
	const asked = ranges.map(([offset, limit]) => ({ offset, limit }));
	const counted = scanFileLines(file, asked, { count: true });
	const stopped = scanFileLines(file, asked, { count: false });
	expect(counted?.totalLines).toBe(want.count);
	expect(stopped?.totalLines).toBeUndefined();
	for (const [offset, limit] of ranges) {
		expect(counted?.hashes(offset, limit)).toEqual(want.hashes(offset, limit));
		expect(stopped?.hashes(offset, limit)).toEqual(want.hashes(offset, limit));
	}
}

describe("scanFileLines matches the released split (#1649)", () => {
	it("gives the released count and hashes for small files", () => {
		fc.assert(
			fc.property(bodyArb, fc.array(rangeArb, { maxLength: 4 }), (b, r) =>
				assertParity(b, r),
			),
			{ numRuns: 300 },
		);
	});

	it("gives the released count and hashes across the first chunk boundary", () => {
		fc.assert(
			fc.property(straddleArb, fc.array(rangeArb, { maxLength: 4 }), (b, r) =>
				assertParity(b, r),
			),
			{ numRuns: 120 },
		);
	});

	it("splits a \\r\\n whose \\r ends one chunk and whose \\n starts the next", () => {
		const bytes = Buffer.concat([
			Buffer.alloc(CHUNK - 1, 0x61),
			Buffer.from("\r\nnext\r"),
		]);
		assertParity(bytes, [[1, 3]]);
		expect(
			scanFileLines(fileWith(bytes), [], { count: true })?.totalLines,
		).toBe(2);
	});

	// Recurrence prevented: wanted lines lost when their decode run is still
	// open as the chunk ends and the chunk is refilled.
	it("ends a run of wanted lines at the end of each chunk", () => {
		for (const tail of ["\nab\ncdefghijklmnop\nq\n", "\nab\nc", "\n\n\n\n"])
			for (const pad of [CHUNK - 10, CHUNK - 4, CHUNK - 1])
				assertParity(
					Buffer.concat([Buffer.alloc(pad, 0x61), Buffer.from(tail)]),
					[
						[1, 3],
						[1, 6],
						[2, 1],
					],
				);
	});

	// Recurrence prevented: a decode run that kept going past the last wanted
	// line, so a count of a large log held every later line of each chunk.
	it("keeps no line outside the ranges it was given", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const scan = scanFileLines(
			fileWith(Buffer.from(text)),
			[
				{ offset: 3, limit: 2 },
				{ offset: 20, limit: 1 },
			],
			{ count: true },
		);
		expect(scan?.totalLines).toBe(40);
		expect(scan?.hashes(3, 2)).toEqual(
			released(Buffer.from(text)).hashes(3, 2),
		);
		expect(scan?.hashes(5, 1)).toBeUndefined();
		expect(scan?.hashes(21, 5)).toBeUndefined();
		expect(scan?.hashes(1, 1)).toBeUndefined();
	});

	it("answers an unreadable path and a directory as the released catch did", () => {
		expect(countFileLines(path.join(env.tmpDir, "missing.ts"))).toBe(1);
		expect(countFileLines(env.tmpDir)).toBe(1);
		expect(
			scanFileLines(env.tmpDir, [{ offset: 1, limit: 5 }], { count: false }),
		).toBeUndefined();
	});
});
