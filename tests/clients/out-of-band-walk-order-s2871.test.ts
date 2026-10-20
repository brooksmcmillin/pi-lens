/**
 * The declaration walk's order is a published order (Sonar typescript:S2871).
 *
 * `walkDeclarations` sorts the files it found and inserts them into the map the
 * caller diffs, so the sort's order becomes `Map` insertion order, which
 * becomes the emission order of `diffDeclarations` and of the `pathChanges`
 * payload in the `DiskChange` subscribers act on. The walk therefore promises a
 * deterministic order (`clients/out-of-band-changes.ts`, the walk's doc
 * comment), and the comparator that delivers it must not depend on the order
 * the filesystem happened to enumerate a directory in.
 *
 * Cells, written before the fix:
 *
 * | Cell | Listings | Expected |
 * |---|---|---|
 * | two enumerations of the same disk | forward, then reversed | one `pathChanges` payload, byte-identical |
 * | the payload's order | reversed | code-unit order (`B.d.ts` before `a.d.ts`), not `localeCompare`'s collation |
 *
 * The enumeration order is planted at the seam the walk itself consumes:
 * `fs.promises.readdir` for the fixture root answers in the order the cell
 * picks, and every other read goes through the real call. The reversed arm
 * counts its own hits, so an arm that stopped reaching the walk reds instead of
 * passing vacuously.
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	_setRecentPhasesForTest,
	clearLatencyLog,
} from "../../clients/latency-logger.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

/**
 * The fixture's declaration files. `B` sorts before `a` in code units
 * (`"B".charCodeAt(0) === 66`, `"a".charCodeAt(0) === 97`) and after it in the
 * default collation, so one payload order tells the two apart.
 */
const DECLARATIONS = ["B.d.ts", "a.d.ts", "c.d.ts"];

let root: string;
const cleanups: Array<() => void> = [];
const previousInterval = process.env.PI_LENS_DECLARATION_LOOK_MS;

/** Answer the fixture root's listing in reverse, and count the hits. */
function reverseRootListing(): () => number {
	const real = fsp.readdir;
	let hits = 0;
	const patched = (async (
		target: fs.PathLike,
		options?: unknown,
	): Promise<unknown> => {
		// oxlint-disable-next-line typescript/no-explicit-any
		const entries = await (real as any)(target, options);
		if (normalizeMapKey(String(target)) !== normalizeMapKey(root))
			return entries;
		hits++;
		return Array.isArray(entries) ? [...entries].reverse() : entries;
	}) as typeof fsp.readdir;
	fsp.readdir = patched;
	cleanups.push(() => {
		fsp.readdir = real;
	});
	return () => hits;
}

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("s2871-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

/** Rewrite every declaration file, so every one of them is a `changed`. */
function rewriteDeclarations(suffix: string): void {
	for (const name of DECLARATIONS)
		fs.writeFileSync(
			path.join(root, name),
			`declare const A: number; // ${suffix}\n`,
		);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-s2871-walk-"));
	for (const name of DECLARATIONS)
		fs.writeFileSync(
			path.join(root, name),
			`declare const A: number; // initial ${name}\n`,
		);
	// Every look walks: the cells below change the disk between two looks.
	process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	_setRecentPhasesForTest([]);
	clearLatencyLog();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	if (previousInterval === undefined)
		delete process.env.PI_LENS_DECLARATION_LOOK_MS;
	else process.env.PI_LENS_DECLARATION_LOOK_MS = previousInterval;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the declaration walk's published order", () => {
	it("publishes one payload whichever order the filesystem enumerates", async () => {
		// First look records the population and publishes nothing.
		await lookForOutOfBandChanges(root, "tool_result");

		rewriteDeclarations("forward arm");
		const forward = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");
		expect(forward).toHaveLength(1);

		rewriteDeclarations("reversed arm");
		const hits = reverseRootListing();
		const reversed = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		// The reversed arm reached the walk's own listing (no invisible skip).
		expect(hits()).toBeGreaterThan(0);
		expect(reversed).toHaveLength(1);
		// Same disk content, same changes, different enumeration order: the
		// payload a subscriber receives is the same payload, in the same order.
		expect(reversed[0].pathChanges).toEqual(forward[0].pathChanges);
	});

	it("publishes the payload in code-unit order, not collation order", async () => {
		await lookForOutOfBandChanges(root, "tool_result");

		rewriteDeclarations("order arm");
		const hits = reverseRootListing();
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(hits()).toBeGreaterThan(0);
		expect(seen).toHaveLength(1);
		const expected = DECLARATIONS.map((name) => ({
			filePath: path.join(root, name),
			type: "changed",
		}));
		// The fixture discriminates: a collation-based comparator would publish
		// `a.d.ts` first, so this cell cannot pass by accident on a machine whose
		// collation happens to agree with code units.
		expect(
			[...DECLARATIONS].sort((left, right) => left.localeCompare(right)),
		).not.toEqual(expected.map((change) => path.basename(change.filePath)));
		expect(seen[0].pathChanges).toEqual(expected);
	});
});
