/**
 * Registered-or-fail sweep for the freshness kernel (#1739).
 *
 * Every mtime-vs-reference-timestamp comparison in `clients/` must go
 * through the kernel's comparator. A NEW out-of-kernel comparison fails
 * here until it is either migrated or added to EXEMPT with a reason - the
 * same ratchet shape as run-outcome-ratchet and the smoke-fixture guard.
 *
 * The needle matches the freshness SHAPE (`.mtimeMs` compared with > or >=
 * against an identifier expression), not just the words: age-based checks
 * (`Date.now() - mtime > TTL`) and max-selection comparisons
 * (`mtime > best.mtimeMs`) are structurally different and listed as
 * exemptions with reasons where they coexist in a file.
 *
 * KNOWN MISSED SHAPES (accepted floor - the needle cannot see them):
 * destructured comparisons without a dot (for (const { mtimeMs } of mtimes)
 * if (mtimeMs > ref) - exactly master's detectDrift import-loop shape),
 * reversed operand order (ref + TOL < x.mtimeMs), and aliased locals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	freshnessFromMtime,
	MTIME_DRIFT_TOLERANCE_MS,
} from "../../clients/freshness.js";
import { toPosix } from "../../clients/path-utils.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_DIR = path.join(REPO_ROOT, "clients");
const KERNEL_FILE = "freshness.ts";

/**
 * Files whose mtime comparisons are NOT reference-timestamp freshness, or
 * whose comparison the kernel's verdict cannot express (an inverted tolerance:
 * a write guard that must refuse where a cache would stay fresh).
 */
const EXEMPT: Record<string, string> = {
	"bounded-pid-file-lock.ts":
		"age-based TTL staleness of a lock file (Date.now() - mtime), not comparison against a recorded scan/record timestamp",
	"generation-lock.ts":
		"lock staleness is a cross-process liveness check on a foreign file, not a content-freshness read; freshnessFromMtime targets in-kernel content caches",
	"installer/index.ts":
		"age-based maxAge expiry of a cached install probe, same TTL-not-freshness shape",
	"installer/managed-tool-refresh.ts":
		"age-based cutoff for stale rule-pack candidate files a killed refresh left behind (Date.now() - mtime > one hour), not freshness against a scan or record timestamp",
	"lsp/edits.ts":
		"the rename staleness guard's compare-and-refuse bounds (#3601, #3734): it refuses AT the request instant and inside a margin BEFORE it, while freshnessFromMtime's verdict tolerates drift after the reference and treats the tie as fresh. Migrating would widen this fail-closed write guard by 50 ms and drop the tie, so the guard keeps its own comparison; the kernel's own doc comment scopes it to caches.",
	"lsp/lombok.ts":
		"max-selection among candidates (find newest), no reference timestamp",
	"project-snapshot.ts":
		"compares in-process snapshot ownership metadata, not file freshness against a scan or record",
	"sgconfig.ts":
		"evicts oldest retained config baselines by an age cutoff, not freshness against a scan or record",
};

describe("freshness kernel coverage (#1739)", () => {
	it("kernel module exists", () => {
		expect(fs.existsSync(path.join(CLIENTS_DIR, KERNEL_FILE))).toBe(true);
	});

	it("every mtime-comparison site uses the kernel or carries an exemption", () => {
		const violations: string[] = [];
		let scanned = 0;
		let matched = 0;
		const walkDir = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walkDir(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
					continue;
				// Relative to CLIENTS_DIR (not REPO_ROOT): keys in EXEMPT and
				// the kernel-skip are clients/-relative by contract.
				const rel = toPosix(path.relative(CLIENTS_DIR, full));
				if (rel === KERNEL_FILE) continue;
				const source = stripSource(fs.readFileSync(full, "utf8"), {
					strings: "blank",
				});
				// Freshness-shaped needle: `.mtimeMs > identifier` / `>=` where
				// the right side is not obviously `best.`-style selection.
				const hits = [
					...source.matchAll(
						/(?:\b[A-Za-z_$][\w$]*\.)?mtimeMs\s*(?:>|>=|<|<=)\s*(?!best\b)[A-Za-z_$]/g,
					),
				];
				scanned++;
				matched += hits.length;
				if (hits.length === 0) continue;
				const base = path.basename(rel);
				if (EXEMPT[rel] || EXEMPT[base]) continue;
				violations.push(`${rel} (${hits.length} comparison[s])`);
			}
		};
		walkDir(CLIENTS_DIR);
		// Calibration: 393 production files walked on 2026-08-26; half rounds
		// to 200. The matched population is 5, so its floor is 3.
		assertNonEmptyScan("freshness sweep: clients files scanned", scanned, 200);
		assertNonEmptyScan(
			"freshness sweep: freshness-shaped comparisons",
			matched,
			3,
		);
		expect(
			violations,
			`out-of-kernel mtime comparisons found - migrate to clients/freshness.ts freshnessFromMtime(), or add an EXEMPT entry with a reason: ${violations.join(", ")}`,
		).toEqual([]);
	});

	it("exemptions still exist on disk (no phantom rows)", () => {
		const all: string[] = [];
		const walkAll = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walkAll(full);
				else if (entry.name.endsWith(".ts")) all.push(entry.name);
			}
		};
		walkAll(CLIENTS_DIR);
		const names = new Set(all);
		const phantom = Object.keys(EXEMPT).filter(
			(name) => !names.has(path.basename(name)),
		);
		expect(phantom, "exempt files must exist").toEqual([]);
	});
});

/**
 * Property (#4928): the kernel's verdict over arbitrary mtimes, references and
 * tolerances, stated as relations between calls.
 *
 * Recurrence this prevents: a gate that serves stale content as fresh, or
 * demotes fresh content, with no error. #1664, #1710 and #1711 were three
 * copies of one tolerance defect (a skewed mtime read as a modification, 42
 * false demotions in 50 Windows runs); a verdict that reads `fresh` for a file
 * edited after the reference is the silent direction.
 *
 * Relations: an undefined mtime is `indeterminate` whatever the reference and
 * tolerance; omitting the tolerance is `MTIME_DRIFT_TOLERANCE_MS`; staleness is
 * monotone in the mtime and in the tolerance; a file not newer than the
 * reference is fresh; an mtime exactly one tolerance past the reference is
 * fresh (the tie, as the `lsp/edits.ts` exemption above describes it) and one
 * millisecond more is stale; a tolerance of 0 is honored, not defaulted.
 * Fractional mtimes are drawn because `fs.Stats.mtimeMs` is fractional.
 *
 * numRuns 400, seed 492804.
 *
 * Not modelled: NaN and infinite inputs (`fs.stat` never yields them), the
 * callers' mapping of `indeterminate` (each owns its policy), and clock skew
 * between hosts.
 */
describe("freshnessFromMtime property (#4928)", () => {
	it("keeps the verdict monotone, tie-fresh and tolerance-honoring", () => {
		const referenceArb = fc.double({
			min: 1e12,
			max: 2e12,
			noNaN: true,
			noDefaultInfinity: true,
		});
		const spanArb = fc.oneof(
			fc.integer({ min: 0, max: 500 }),
			fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
		);
		const verdict = (
			mtimeMs: number | undefined,
			referenceMs: number,
			toleranceMs?: number,
		) => freshnessFromMtime({ mtimeMs, referenceMs, toleranceMs });
		fc.assert(
			fc.property(
				referenceArb,
				spanArb,
				spanArb,
				spanArb,
				fc.option(spanArb, { nil: undefined }),
				(reference, past, ahead, extra, tolerance) => {
					expect(
						verdict(undefined, reference, tolerance),
						"no mtime evidence",
					).toEqual({ verdict: "indeterminate", reason: "no-mtime-evidence" });

					const m = reference + ahead;
					expect(verdict(m, reference), "the default tolerance").toEqual(
						verdict(m, reference, MTIME_DRIFT_TOLERANCE_MS),
					);

					const effective = tolerance ?? MTIME_DRIFT_TOLERANCE_MS;
					expect(
						verdict(reference - past, reference, tolerance).verdict,
						"a file not newer than the reference",
					).toBe("fresh");
					expect(
						verdict(reference + effective, reference, tolerance).verdict,
						"the tie",
					).toBe("fresh");
					expect(
						verdict(reference + effective + 1, reference, tolerance),
						"one millisecond past the tie",
					).toEqual({ verdict: "stale", reason: "modified-after-reference" });
					expect(
						verdict(reference + 1, reference, 0).verdict,
						"a tolerance of 0",
					).toBe("stale");

					if (verdict(m, reference, tolerance).verdict === "stale") {
						expect(
							verdict(m + extra, reference, tolerance).verdict,
							"a later mtime",
						).toBe("stale");
						expect(
							verdict(m, reference, Math.max(0, effective - extra)).verdict,
							"a narrower tolerance",
						).toBe("stale");
					}
				},
			),
			{ numRuns: 400, seed: 492804 },
		);
	});
});
