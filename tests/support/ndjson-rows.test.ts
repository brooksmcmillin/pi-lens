/**
 * The contract of the shared JSON-lines reader (#4699 F2), before any consumer
 * leans on it: what it keeps, what it reports, and how a byte offset lands.
 *
 * Recurrence: ten copies of "read, split, parse each line" judged the same
 * sinks with three different answers (drop, drop, throw), and the two that
 * dropped did it silently, so a corrupt record could not be seen by an
 * exact-count assertion (Sourcery on #4699). This file pins the one answer the
 * fold leaves: rows in write order, a skipped-line COUNT beside them, and no
 * silent path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { readNdjsonRows } from "./ndjson-rows.js";

const fixture = setupTestEnvironment("pi-lens-ndjson-rows-");
afterAll(() => fixture.cleanup());

function fixtureFile(name: string, content: string): string {
	const file = path.join(fixture.tmpDir, name);
	fs.writeFileSync(file, content);
	return file;
}

describe("readNdjsonRows", () => {
	it("returns the rows in write order, a blank line is not a lost row", () => {
		const file = fixtureFile(
			"order.log",
			'{"phase":"a"}\n\n{"phase":"b"}\n   \n{"phase":"c"}\n',
		);

		const read = readNdjsonRows(file);

		expect(read.rows.map((row) => row.phase)).toEqual(["a", "b", "c"]);
		expect(read.skipped).toBe(0);
	});

	it("counts a mangled line and a line cut mid-write instead of dropping them", () => {
		// The two shapes Sourcery's probe planted: a line that is not JSON at
		// all, and a torn tail with no trailing newline. Both used to come back
		// as nothing at all, so `toHaveLength(0)`/`toHaveLength(1)` could not
		// tell a clean log from a corrupted one.
		const file = fixtureFile(
			"corrupt.log",
			'{"phase":"a"}\nnot a row\n{"phase":"b"}\n{"phase":"memory_sam',
		);

		const read = readNdjsonRows(file);

		expect(read.rows.map((row) => row.phase)).toEqual(["a", "b"]);
		expect(read.skipped).toBe(2);
	});

	it("counts a line that parses but is not an object", () => {
		const file = fixtureFile("scalar.log", '{"phase":"a"}\n42\nnull\n');

		const read = readNdjsonRows(file);

		expect(read.rows).toHaveLength(1);
		expect(read.skipped).toBe(2);
	});

	it("reads an absent file as no rows and no skips", () => {
		const read = readNdjsonRows(path.join(fixture.tmpDir, "never-written.log"));

		expect(read).toEqual({ rows: [], skipped: 0 });
	});

	it("applies fromByte to the bytes, so a multi-byte character before it moves nothing", () => {
		// #4484 review F3: a byte offset decoded through a character index lands
		// inside a line once an emoji precedes it, and the row it should have
		// read becomes a parse failure.
		const first = '{"phase":"a","note":"🔴 kept"}\n';
		const file = fixtureFile("offset.log", `${first}{"phase":"b"}\n`);

		const read = readNdjsonRows(file, Buffer.byteLength(first, "utf8"));

		expect(read.rows.map((row) => row.phase)).toEqual(["b"]);
		expect(read.skipped).toBe(0);
	});
});
