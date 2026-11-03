/**
 * #4638 ticket 02: pi-lens passes no syntax level to ruff. Ruff discovers
 * `target-version` from the project config, so a flag spelled anywhere in
 * `clients/` is either a second owner of that decision or a stale copy of one.
 *
 * The scan strips comments and keeps string literals, so a mention in prose is
 * not a hit while an argv entry is, and it pins per-file hit COUNTS rather than
 * line numbers: a moved line stays green, a new occurrence reds. The one
 * admitted site is black's own CLI shape in the bash guard, unrelated to ruff.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = fileURLToPath(new URL("../../clients", import.meta.url));
const NEEDLE = "--target-version";
const SCAN_OPTIONS = { strings: "keep" } as const;

const ADMITTED: ReadonlyArray<{ file: string; hits: number; reason: string }> =
	[
		{
			file: "bash-file-access.ts",
			hits: 1,
			reason:
				"black's CLI takes `--target-version <value>`; the bash guard must skip that value to find file operands, and pi-lens never passes the flag to black",
		},
	];

interface Hit {
	line: number;
	text: string;
}

interface FileHits {
	file: string;
	hits: Hit[];
}

const FILES = listSourceFiles(ROOT);

function scan(): FileHits[] {
	const found: FileHits[] = [];
	for (const absolute of FILES) {
		const source = readWalkedFile(absolute);
		if (source === undefined) continue;
		const rawLines = source.split("\n");
		const scannedLines = stripSource(source, SCAN_OPTIONS).split("\n");
		const hits: Hit[] = [];
		for (let index = 0; index < scannedLines.length; index += 1) {
			if (!(scannedLines[index] ?? "").includes(NEEDLE)) continue;
			hits.push({ line: index + 1, text: (rawLines[index] ?? "").trim() });
		}
		if (hits.length > 0) {
			found.push({ file: relativePosix(ROOT, absolute), hits });
		}
	}
	return found;
}

describe("ruff syntax-level overrides stay out of clients/ (#4638)", () => {
	it("counts a comment as prose but a string literal as a hit", () => {
		// A real fixture crossing the boundary the scan relies on.
		expect(stripSource(`// ${NEEDLE} py310\n`, SCAN_OPTIONS)).not.toContain(
			NEEDLE,
		);
		expect(
			stripSource(`const args = ["${NEEDLE}", "py310"];\n`, SCAN_OPTIONS),
		).toContain(NEEDLE);
	});

	it("admits only black's CLI shape and no ruff invocation", () => {
		// A dead walk must never read as clean (#1718).
		assertNonEmptyScan(
			"ruff target-version sweep (clients/)",
			FILES.length,
			40,
		);
		const found = scan();

		const unadmitted = found.filter(
			(entry) => !ADMITTED.some((admitted) => admitted.file === entry.file),
		);
		expect(
			unadmitted,
			`unclassified ${NEEDLE} site(s): ${JSON.stringify(unadmitted, null, 2)}`,
		).toEqual([]);

		const stale = ADMITTED.filter(
			(admitted) => !found.some((entry) => entry.file === admitted.file),
		);
		expect(stale, "stale admission(s)").toEqual([]);

		// Counts, not line numbers: only the population is pinned.
		expect(
			found.map((entry) => `${entry.file}:${entry.hits.length}`).sort(),
		).toEqual(ADMITTED.map((entry) => `${entry.file}:${entry.hits}`).sort());
		expect(found.some((entry) => entry.file === "ruff-client.ts")).toBe(false);
	});

	it("admits every surviving site with a stated reason", () => {
		for (const entry of ADMITTED) {
			expect(entry.reason.length).toBeGreaterThan(20);
		}
	});
});
