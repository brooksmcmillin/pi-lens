// #4514: the proof-of-work floor for every nightly producer that cannot fail
// its own job. characterize-lsp, probe-clean-signal, server-capabilities and
// measure-lsp-idle-eviction exit 0 by design and run under continue-on-error,
// so a night that evaluated almost nothing (a missing trust adoption, a lost
// toolchain, an API drift) read green for six days (the 2026-10-10 regression:
// ~54 classified rows fell to ~24, "41 servers captured" fell to 16). A green
// with nothing evaluated is the shape this closes; the retro's P2.
//
// One record shape, designed once, so a non-LSP producer can reuse it
// (#4518):
//   { producer, evaluated, floor, prevEvaluated, ok, reason }
// `evaluated` is what this run measured; `floor` is the lowest healthy count;
// `prevEvaluated` is the count at HEAD (a committed doc's header) or null.
// Pure, no I/O: the CLI (scripts/assert-evaluated.mjs) reads the records and
// the docs and fails a dedicated step that is NOT continue-on-error.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	elapsedDays,
	FIRST_PUBLISH_EXPIRY_DAYS,
	MEASURED_CLEAN_BEHAVIORS,
	parseRefreshState,
	parseTable,
} from "./md-matrix.mjs";

/**
 * A run may fall this far below HEAD's count before the delta check fails. It
 * sits above runner noise (a flaky install drops one or two servers) and below
 * the observed regression (41 captured to 16, 33 eligible to 7).
 */
export const MAX_DROP_FRACTION = 0.2;

/** Where each LSP producer's record is written (a directory the workflow sets). */
export const EVALUATED_DIR_ENV = "PI_LENS_EVALUATED_DIR";

const SERVERS_CAPTURED_RE = /(\d+) servers captured/;
const IDLE_COUNTS_RE =
	/(\d+) eligible, (\d+) vetoed, (\d+) inconclusive, \d+ unavailable/;

const isClassified = (cell) =>
	cell !== undefined && cell !== "" && cell !== "unknown";

/**
 * The matrix doc is merged, never blanked, so its only honest per-run signal is
 * the `first-publish` column the 5-day expiry turns to `unknown` (the #4338
 * shape: five false `unknown` cells). `matrixCells` reads that column keyed by
 * `lang|server`; `matrixClassifiedCount` counts the classified ones.
 */
export function matrixCells(text) {
	const table = parseTable(text, "| lang | server |");
	const col = table?.header.indexOf("first-publish") ?? -1;
	if (!table || col < 0) return null;
	return new Map(
		table.rows.map((cells) => [`${cells[0]}|${cells[1]}`, cells[col]]),
	);
}

function matrixClassifiedCount(text) {
	const cells = matrixCells(text);
	return cells ? [...cells.values()].filter(isClassified).length : null;
}

/**
 * Cells classified at HEAD that the regeneration turned `unknown`, as
 * `lang|server` keys. A 20% margin on the count lets five of 28 cells flip
 * (17.9%), exactly the #4338 shape, so the matrix is compared cell by cell.
 * A HEAD firstMissed stamp at the expiry threshold justifies the loss (#4537).
 * A row absent from the regeneration is the count floor's business, not a lost
 * measurement of its own.
 */
export function lostClassifiedCells(headText, text) {
	const state = parseRefreshState(headText)["first-publish"];
	const today = new Date().toISOString().slice(0, 10);
	const head = matrixCells(headText);
	const now = matrixCells(text);
	if (!head || !now) return [];
	return [...head]
		.filter(([key, cell]) => isClassified(cell) && now.get(key) === "unknown")
		.filter(([key]) => {
			const lang = key.split("|")[0];
			const elapsed = elapsedDays(state?.[lang]?.firstMissed, today);
			return elapsed === null || elapsed < FIRST_PUBLISH_EXPIRY_DAYS;
		})
		.map(([key]) => key);
}

/**
 * Per producer: `floor` is the lowest healthy count, measured on the nightly
 * (tests/fixtures/nightly-floors/measurements.json holds the raw log lines and
 * tests/config/nightly-evaluated-floors.test.ts pins each floor between the
 * degraded and the healthy measurement). `doc` names the committed doc the
 * refresh PR carries, its own floor, and how to read its count back.
 */
export const EVALUATED_PRODUCERS = {
	"characterize-lsp": { floor: 35 },
	"probe-clean-signal": {
		floor: 32,
		doc: {
			path: "docs/lsp-capability-matrix.md",
			floor: 1,
			count: matrixClassifiedCount,
			// The record counts measured rows (43 live); the doc counts first-publish
			// cells (<= 29). Different units: the doc's HEAD count is no baseline for
			// the record, so records mode does not compare them.
			comparableToRecord: false,
			// Compared cell by cell against HEAD (lostClassifiedCells).
			cells: true,
		},
	},
	"server-capabilities": {
		floor: 31,
		doc: {
			path: "docs/servercapabilities.md",
			floor: 31,
			count: (text) => {
				const m = SERVERS_CAPTURED_RE.exec(text);
				return m ? Number(m[1]) : null;
			},
		},
	},
	"measure-lsp-idle-eviction": {
		floor: 26,
		doc: {
			path: "docs/lsp-idle-eviction.md",
			floor: 26,
			count: (text) => {
				const m = IDLE_COUNTS_RE.exec(text);
				return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : null;
			},
		},
	},
};

/**
 * What each producer counts as "evaluated", from the value its script already
 * holds: one pure function per producer, called by the script (through
 * writeEvaluatedRecord) and by the test that feeds it a nightly's log lines, so
 * neither can drift from the other (tests/config/nightly-evaluated-floors.test.ts).
 *   characterize-lsp          rows with a measured mode
 *   probe-clean-signal        classified rows plus pull rows (answered by protocol)
 *   server-capabilities       rows captured
 *   measure-lsp-idle-eviction summarizeRows() counts: spawned, not unavailable
 */
export const EVALUATED_COUNTS = {
	"characterize-lsp": (rows) =>
		rows.filter((r) => r.mode === "pull" || r.mode === "push-only").length,
	"probe-clean-signal": (rows) =>
		rows.filter(
			(r) =>
				MEASURED_CLEAN_BEHAVIORS.has(r.behavior) || r.behavior === "n/a (pull)",
		).length,
	"server-capabilities": (rows) => rows.length,
	"measure-lsp-idle-eviction": (counts) => counts.total - counts.unavailable,
};

export function countEvaluated(producer, input) {
	const count = EVALUATED_COUNTS[producer];
	if (!count)
		throw new TypeError(`countEvaluated: unknown producer ${producer}`);
	return count(input);
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * @param {{ producer: string, evaluated: number, expectedAtLeast: number, previous?: number | null }} input
 * @returns {{ producer: string, evaluated: number, floor: number, prevEvaluated: number | null, ok: boolean, reason: string }}
 */
export function assertEvaluated({
	producer,
	evaluated,
	expectedAtLeast,
	previous = null,
}) {
	if (typeof producer !== "string" || producer === "")
		throw new TypeError("assertEvaluated: producer must be a non-empty string");
	if (!isCount(evaluated))
		throw new TypeError(
			`assertEvaluated(${producer}): evaluated must be a non-negative integer, got ${evaluated}`,
		);
	if (!Number.isInteger(expectedAtLeast) || expectedAtLeast < 1)
		throw new TypeError(
			`assertEvaluated(${producer}): expectedAtLeast must be a positive integer, got ${expectedAtLeast}`,
		);
	if (previous !== null && !isCount(previous))
		throw new TypeError(
			`assertEvaluated(${producer}): previous must be null or a non-negative integer, got ${previous}`,
		);
	const record = {
		producer,
		evaluated,
		floor: expectedAtLeast,
		prevEvaluated: previous,
	};
	if (evaluated < expectedAtLeast)
		return {
			...record,
			ok: false,
			reason: `evaluated ${evaluated}, below the floor of ${expectedAtLeast}`,
		};
	const allowed = previous === null ? 0 : previous * (1 - MAX_DROP_FRACTION);
	if (previous !== null && evaluated < allowed)
		return {
			...record,
			ok: false,
			reason: `evaluated ${evaluated}, down from ${previous} at HEAD (more than ${MAX_DROP_FRACTION * 100}% drop)`,
		};
	return { ...record, ok: true, reason: "ok" };
}

/** The record a producer that never reported (crashed, skipped, timed out) leaves. */
export function missingRecord(producer, floor, previous = null) {
	return {
		producer,
		evaluated: 0,
		floor,
		prevEvaluated: previous,
		ok: false,
		reason: "no record: the producer did not report how much it evaluated",
	};
}

/**
 * Producer side. One log line per run (not per row), and a record file only
 * when the workflow names a directory, so a local run leaves nothing behind.
 */
export function writeEvaluatedRecord({ producer, input }) {
	const evaluated = countEvaluated(producer, input);
	console.error(`[evaluated] ${producer}: ${evaluated}`);
	const dir = process.env[EVALUATED_DIR_ENV];
	if (!dir) return;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${producer}.json`),
			JSON.stringify({ producer, evaluated }),
		);
	} catch (e) {
		console.error(
			`[evaluated] ${producer}: record not written (${e?.message ?? e})`,
		);
	}
}

/** Read a producer's record back; null when absent or not a valid count. */
export function readEvaluatedRecord(dir, producer) {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(dir, `${producer}.json`), "utf8"),
		);
		return parsed?.producer === producer && isCount(parsed.evaluated)
			? parsed.evaluated
			: null;
	} catch {
		return null;
	}
}
