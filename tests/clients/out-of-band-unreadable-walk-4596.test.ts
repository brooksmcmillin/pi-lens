/**
 * #4596: a declaration walk that could not read a subtree must say so, and
 * must never report a file under it as deleted.
 *
 * The defect the audit proved (probe 2). `walkDeclarations` skipped a
 * directory it could not list (`catch { continue; }`,
 * `clients/out-of-band-changes.ts`), the map it returned looked complete, and
 * the diff against the previous walk read every declaration file under that
 * directory as gone: `lsp_out_of_band_change` published `deleted: 1` for a
 * file that still existed, and a diagnostics cache refused entries for it. No
 * row named the failed read. AGENTS.md shape 10 ("silencing as fixing"): an
 * unavailable read is not a clean answer, and here it was not even silent — it
 * was a false event.
 *
 * Cells, written before the fix:
 *
 * | Cell | Walk | Published change | Record |
 * |---|---|---|---|
 * | control: a declaration edited under a readable directory | complete | `changed: 1` | no unreadable row |
 * | failure: the same edit under an unreadable directory | incomplete (1 dir) | nothing (no invented deletion) | one `lsp-declaration-walk-unreadable` row naming the root, the directory and the kept fingerprint |
 * | recovery: that subtree is readable again | complete | the real `changed: 1` | the same row from the earlier look |
 * | recovery: a file in it was really deleted while unreadable | complete, after | `deleted: 1`, once the walk can see it | a row per unreadable look |
 * | #4603 F2: a file the walk lists but cannot stat (EACCES) | complete | nothing (no invented deletion) | one row naming the file, its previous fingerprint kept |
 * | #4603 F5: the carried set does not fit the file cap | incomplete | nothing; the previous map stands | one row with `carriedDropped` |
 *
 * The unreadable directory is injected at the filesystem seam
 * (`fs.promises.readdir` refuses one path and every other read goes through
 * the real call), so the cell runs on every platform and needs no privileges;
 * the control cell in the same file proves the injection is the only
 * difference.
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

let root: string;
const cleanups: Array<() => void> = [];
const previousInterval = process.env.PI_LENS_DECLARATION_LOOK_MS;

/**
 * Refuse exactly one file's `stat` with EACCES, the shape a readable directory
 * can still hold (a mode that lists the entries but denies reading them).
 * Every other stat stays real.
 */
function denyStat(file: string): void {
	const real = fsp.stat;
	const patched = (async (
		target: fs.PathLike,
		options?: unknown,
	): Promise<unknown> => {
		if (normalizeMapKey(String(target)) === normalizeMapKey(file))
			throw Object.assign(new Error(`EACCES: permission denied, ${file}`), {
				code: "EACCES",
			});
		// oxlint-disable-next-line typescript/no-explicit-any
		return (real as any)(target, options);
	}) as typeof fsp.stat;
	fsp.stat = patched;
	cleanups.push(() => {
		fsp.stat = real;
	});
}

/** Refuse exactly one directory's listing; every other read stays real. */
function denyListing(dir: string): void {
	const real = fsp.readdir;
	const patched = (async (
		target: fs.PathLike,
		options?: unknown,
	): Promise<unknown> => {
		if (normalizeMapKey(String(target)) === normalizeMapKey(dir))
			throw Object.assign(new Error(`EACCES: permission denied, ${dir}`), {
				code: "EACCES",
			});
		// oxlint-disable-next-line typescript/no-explicit-any
		return (real as any)(target, options);
	}) as typeof fsp.readdir;
	fsp.readdir = patched;
	cleanups.push(() => {
		fsp.readdir = real;
	});
}

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("t4596-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

function unreadableRows(): Array<{
	kind: string;
	count: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}> {
	return getDegradationSummary().filter(
		(group) => group.kind === "lsp-declaration-walk-unreadable",
	);
}

/**
 * The `lsp_out_of_band_change` rows the detector wrote, newest first.
 *
 * The phase ring is process-wide, so `beforeEach` clears it: reading it
 * unfiltered made this file's verdict depend on which case ran first (a
 * rejected run under shuffle seed 3). A row is this case's own because the
 * ring holds nothing older than the case's own looks.
 */
function changeRows(): Array<Record<string, unknown>> {
	return getRecentLoggedPhases()
		.filter((entry) => entry.phase === "lsp_out_of_band_change")
		.map((entry) => entry.metadata ?? {});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4596-walk-"));
	fs.mkdirSync(path.join(root, "types"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "types", "globals.d.ts"),
		"declare const A: number;\n",
	);
	// Every look walks: the cells below change the disk between two looks.
	process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	resetDegradationLedger();
	// The recent-phase ring is process-wide and `resetDegradationLedger` does
	// not clear it, so a case would otherwise read the row a sibling case wrote.
	_setRecentPhasesForTest([]);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	if (previousInterval === undefined)
		process.env.PI_LENS_DECLARATION_LOOK_MS = undefined;
	else process.env.PI_LENS_DECLARATION_LOOK_MS = previousInterval;
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * One look with the real sink enabled (`PI_LENS_TEST_MODE=0`, the sanctioned
 * opt-in, scoped to this look) and the durable
 * `lsp-declaration-walk-unreadable` rows it wrote. The in-process summary
 * carries only the reason, which the ledger caps at `LEDGER_FIELD_MAX`, so the
 * counts a reader needs (`heldBackDeclarations`, `carriedDropped`) live only in
 * the durable row: a claim about them reads it.
 */
async function lookAndReadUnreadableRows(): Promise<
	Array<Record<string, unknown>>
> {
	const previousMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	clearLatencyLog();
	await flushLatencyLog();
	try {
		await lookForOutOfBandChanges(root, "tool_result");
		await flushLatencyLog();
	} finally {
		if (previousMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousMode;
	}
	return fs
		.readFileSync(getLatencyLogPath(), "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(row) =>
				(row.metadata as Record<string, unknown> | undefined)?.kind ===
				"lsp-declaration-walk-unreadable",
		);
}

describe("a declaration walk that could not read a subtree", () => {
	it("reports a changed declaration under a readable directory (control)", async () => {
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(root, "types", "globals.d.ts"),
			"declare const A: string;\n",
		);
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{
				filePath: path.join(root, "types", "globals.d.ts"),
				type: "changed",
			},
		]);
		expect(changeRows()[0]).toMatchObject({ changed: 1, deleted: 0 });
		expect(unreadableRows()).toEqual([]);
	});

	it("records the unreadable subtree and publishes no deletion for it", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(types, "globals.d.ts"),
			"declare const A: string;\n",
		);

		denyListing(types);
		const seen = recordPublishes();
		const durable = await lookAndReadUnreadableRows();

		// The pre-fix detector published `deleted: 1` for a file that exists.
		expect(seen).toEqual([]);
		expect(changeRows()[0] ?? { deleted: 0 }).toMatchObject({ deleted: 0 });
		const rows = unreadableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(1);
		// The record keeps the identity a reader needs: which root, which
		// directory, and how many fingerprints were kept instead of deleted.
		expect(rows[0].latestReasons[0].subject).toBe(normalizeMapKey(root));
		expect(rows[0].latestReasons[0].reason).toContain(types);
		// The kept count is in the durable row's metadata: the reason string is
		// capped by the ledger, so it names only the first unreadable path.
		expect(durable).toHaveLength(1);
		expect(
			Number(
				(durable[0].metadata as Record<string, unknown>).heldBackDeclarations,
			),
		).toBe(1);
	});

	it("reports the deferred change on the first walk that can read the subtree", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(types, "globals.d.ts"),
			"declare const A: string;\n",
		);

		denyListing(types);
		await lookForOutOfBandChanges(root, "tool_result");
		// The subtree is readable again: the carried fingerprint is compared
		// against the bytes the walk can finally see.
		for (const cleanup of cleanups.splice(0)) cleanup();
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{
				filePath: path.join(types, "globals.d.ts"),
				type: "changed",
			},
		]);
	});

	it("reports a real deletion under the subtree once it is readable again", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");

		denyListing(types);
		fs.rmSync(path.join(types, "globals.d.ts"));
		await lookForOutOfBandChanges(root, "tool_result");
		for (const cleanup of cleanups.splice(0)) cleanup();
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{ filePath: path.join(types, "globals.d.ts"), type: "deleted" },
		]);
		expect(changeRows()[0]).toMatchObject({ deleted: 1 });
	});

	it("keeps a file it lists but cannot stat, and publishes no deletion", async () => {
		const globals = path.join(root, "types", "globals.d.ts");
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(globals, "declare const A: string;\n");

		// Pre-fix: every stat failure was read as absence, so this published
		// `deleted: 1` for a file that is on disk.
		denyStat(globals);
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toEqual([]);
		expect(changeRows()[0] ?? { deleted: 0 }).toMatchObject({ deleted: 0 });
		const rows = unreadableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].latestReasons[0].reason).toContain("1 unreadable file(s)");

		// The kept fingerprint makes the first readable walk report the real
		// change, not a creation.
		for (const cleanup of cleanups.splice(0)) cleanup();
		const recovered = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");
		expect(recovered).toHaveLength(1);
		expect(recovered[0].pathChanges).toEqual([
			{ filePath: globals, type: "changed" },
		]);
	});

	it("holds the carried set to the walk's file cap and keeps the record", async () => {
		// The walk's cap is 2,048 files (`DECLARATION_WALK_MAX_FILES`). Walk 1
		// is complete: 1,500 files under `a` plus the fixture's
		// `types/globals.d.ts`. Walk 2 cannot list `a` and sees 1,500 new files
		// under `b`, so carrying every previous fingerprint would take the
		// stored map to 3,001 — half again the cap, and it grows by a
		// directory's worth every round (#4603 F5).
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		fs.mkdirSync(a, { recursive: true });
		for (let index = 0; index < 1500; index += 1)
			fs.writeFileSync(path.join(a, `g${index}.d.ts`), "export {};\n");
		await lookForOutOfBandChanges(root, "tool_result");

		fs.mkdirSync(b, { recursive: true });
		for (let index = 0; index < 1500; index += 1)
			fs.writeFileSync(path.join(b, `h${index}.d.ts`), "export {};\n");
		denyListing(a);
		const seen = recordPublishes();
		const durable = await lookAndReadUnreadableRows();

		// Over the cap the walk is incomplete: the previous map stands and
		// nothing is published this round. Pre-fix it published
		// `created: 1500` and stored a 3,001-entry map.
		expect(seen).toEqual([]);
		const rows = unreadableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].latestReasons[0].reason).toMatch(
			/could not be carried past the 2048-file cap/,
		);
		// #4603 F5/N8: the metadata field is the record, so assert the drop
		// count the durable row carries, not only the reason text.
		expect(durable).toHaveLength(1);
		expect(
			Number((durable[0].metadata as Record<string, unknown>).carriedDropped),
		).toBeGreaterThan(0);

		// A later complete walk still diffs against the map the over-cap round
		// kept, so `a`'s files are never read as deleted.
		fs.rmSync(b, { recursive: true, force: true });
		for (const cleanup of cleanups.splice(0)) cleanup();
		const later = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");
		expect(later).toEqual([]);
	}, 120_000);
});
