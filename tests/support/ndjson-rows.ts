/**
 * The ONE reader for the JSON lines pi-lens's sinks write (#4699 F2).
 * `clients/ndjson-logger.ts` puts one JSON object per line into `latency.log`,
 * `extension.log`, `cascade.log`, the diagnostic log and the child's provider
 * log. Ten readers in `tests/support/` and `tests/index-*witness*.test.ts`
 * each carried their own copy of "read, split, parse each line", and the
 * copies disagreed: most dropped a line they could not parse, three threw at
 * the caller (#4699 F2). Other tests still parse sink lines inline.
 *
 * Neither answer was complete. A dropped line is invisible to an exact-count
 * or absence assertion, so a writer that corrupted a row passed (Sourcery on
 * #4699: a malformed `memory_sample` line left `samples` at 0 and the case
 * green), and a throw names the failure but no row and no count.
 *
 * So the reader skips a line it cannot parse and REPORTS it: `skipped` is the
 * record. A caller whose claim depends on the total asserts it is zero (that is
 * a red on a corrupt sink, with the count in the message); a caller that only
 * names rows ignores it. A blank line is not a lost row and is never counted.
 *
 * The reader never flushes. An in-process sink's writers only ENQUEUE, so the
 * caller drains the sink first, right before the read, with no other await in
 * between (AGENTS.md shape 67); a child process's file is read as it lands.
 */
import * as fs from "node:fs";

/** One parsed row. Callers narrow the fields they read. */
type NdjsonRow = Record<string, unknown>;

export interface NdjsonRowRead<Row extends NdjsonRow = NdjsonRow> {
	/** The rows that parsed as objects, in write order. */
	rows: Row[];
	/** Lines this read could not turn into a row. */
	skipped: number;
}

/**
 * The rows of the JSON-lines `file`, and how many of its lines it could not
 * turn into a row. An absent file reads as no rows and no skips.
 *
 * `fromByte` reads from a byte offset a caller took before a run: it is applied
 * to the BYTES, never to a decoded string, because a byte count is not a
 * character index (an emoji earlier in the log moves a character offset off the
 * row boundary, #4484 review F3).
 */
export function readNdjsonRows<Row extends NdjsonRow = NdjsonRow>(
	file: string,
	fromByte = 0,
): NdjsonRowRead<Row> {
	if (!fs.existsSync(file)) return { rows: [], skipped: 0 };
	const bytes = fs.readFileSync(file);
	const text = (fromByte > 0 ? bytes.subarray(fromByte) : bytes).toString(
		"utf8",
	);
	const rows: Row[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const row = JSON.parse(line) as unknown;
			if (row && typeof row === "object") rows.push(row as Row);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { rows, skipped };
}
