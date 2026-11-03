/**
 * #3310 — the expiry check on the `emptyFirstPublish` class.
 *
 * ## The recurrence this guards
 *
 * `emptyFirstPublish: "indexing"` (clients/lsp/wait-policy/strategies.ts) makes
 * the publish handler HOLD a server's empty first publish, because intelephense
 * answers `didOpen` with `[]` while it indexes and pi-lens read that as
 * "confirmed clean" for a file with an error. A per-server marker derived from a
 * measurement goes stale the moment the measurement changes, and the two stale
 * directions fail differently:
 *
 *  - a server measured `empty-first` with NO marker is a LIVE false clean (the
 *    #3310 defect, for that server);
 *  - a marker whose server now measures `direct` makes the client hold a publish
 *    that was the answer, paying the index budget for nothing.
 *
 * So this census compares the two committed sources against each other: the
 * `first-publish` column of docs/lsp-capability-matrix.md — which the nightly
 * `probe-clean-signal.mjs` step re-measures and merges through the
 * `bot/lsp-docs-refresh` auto-PR — and the marker in the strategy table. When a
 * server's measured class changes, that auto-PR reds here until the marker moves
 * with it. Deterministic by construction: it reads two files in the repo and
 * spawns nothing.
 *
 * `unknown` / `empty-only` / `TBD` / `n/a (pull)` cells are evidence of nothing
 * in either direction (the #240 doctrine, as `clean-behavior`'s own drift check
 * applies it) and are excluded — with a floor, so a column that somehow became
 * all-`TBD` cannot pass this sweep silently.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	COMPARABLE_FIRST_PUBLISH,
	strategyKeyForLang,
} from "../../scripts/lib/clean-signal.mjs";
import {
	FIRST_PUBLISH_EXPIRY_DAYS,
	elapsedDays,
	parseRefreshState,
	parseTable,
	refreshCapabilityMatrix,
} from "../../scripts/lib/md-matrix.mjs";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const MATRIX_PATH = path.join(repoRoot, "docs", "lsp-capability-matrix.md");

interface MatrixRow {
	lang: string;
	server: string;
	firstPublish: string;
}

function matrixRows(text = fs.readFileSync(MATRIX_PATH, "utf8")): MatrixRow[] {
	const table = parseTable(text, "| lang | server |");
	expect(table, "capability matrix table is parseable").not.toBeNull();
	const header = table!.header;
	const langIdx = header.indexOf("lang");
	const serverIdx = header.indexOf("server");
	const firstPublishIdx = header.indexOf("first-publish");
	expect(
		firstPublishIdx,
		"the matrix carries a first-publish column (#3310)",
	).toBeGreaterThan(-1);
	return table!.rows.map((cells) => ({
		lang: cells[langIdx] ?? "",
		server: cells[serverIdx] ?? "",
		firstPublish: cells[firstPublishIdx] ?? "",
	}));
}

describe("#3310 first-publish census", () => {
	it("compares a non-trivial number of measured rows", () => {
		const comparable = matrixRows().filter((row) =>
			COMPARABLE_FIRST_PUBLISH.has(row.firstPublish),
		);
		// A floor, not a ratchet: the sweep must never pass by comparing nothing
		// (defect shape 10 — an empty census fails loud).
		expect(comparable.length).toBeGreaterThanOrEqual(2);
	});

	it("marks every server measured empty-first, and no server measured direct", () => {
		const mismatches: string[] = [];
		for (const row of matrixRows()) {
			if (!COMPARABLE_FIRST_PUBLISH.has(row.firstPublish)) continue;
			const key = strategyKeyForLang(row.lang);
			const marked =
				SERVER_DIAGNOSTIC_STRATEGIES[key]?.emptyFirstPublish === "indexing";
			if (row.firstPublish === "empty-first" && !marked) {
				mismatches.push(
					`${row.lang} (${row.server}): measured empty-first but wait-policy/strategies.ts has no emptyFirstPublish marker for "${key}" — its empty pre-index publish still resolves the push wait, which is a live #3310 false clean for that server`,
				);
			}
			if (row.firstPublish === "direct" && marked) {
				mismatches.push(
					`${row.lang} (${row.server}): wait-policy/strategies.ts marks "${key}" emptyFirstPublish:"indexing" but this measurement says direct — the marker is stale and the client is holding a publish that was the answer`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("keeps every marked server inside the measured population", () => {
		// A marker for a server with no row at all cannot be re-measured, so it
		// could never expire — the registry entry and its measurement ship together.
		const langs = new Set(
			matrixRows().map((row) => strategyKeyForLang(row.lang)),
		);
		const orphans = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(([, strategy]) => strategy.emptyFirstPublish === "indexing")
			.map(([serverId]) => serverId)
			.filter((serverId) => !langs.has(serverId));
		expect(orphans).toEqual([]);
	});

	/**
	 * #4615: the other direction of the same census. An `empty-first` cell is
	 * never expired (it backs a live `emptyFirstPublish` marker), which made the
	 * cell+marker pair immortal: a probe that stopped observing the axis left the
	 * cell standing with nothing behind it, and the census — comparing the two
	 * committed sources only — could not tell a dead instrument from a healthy
	 * one. `refreshCapabilityMatrix` now stamps the first unobserved night, the
	 * same `firstMissed` clock a stale `direct` cell gets; this rule reds when
	 * that stamp is old enough that the cell's measurement can no longer be
	 * called live.
	 *
	 * The rule is bounded by the nightly, and says so: a cell with no stamp (an
	 * unstamped committed cell, or one a human flipped) is not named here until a
	 * full nightly miss writes one. So a green census means "observed since the
	 * last miss, or not yet missed by a full nightly" — the accepted p3 residual,
	 * not a claim that every unstamped cell was observed recently.
	 */
	function unbackedEmptyFirstCells(
		text: string,
		today = new Date().toISOString().slice(0, 10),
	): string[] {
		const state = parseRefreshState(text)["first-publish"] ?? {};
		const stale: string[] = [];
		for (const row of matrixRows(text)) {
			if (row.firstPublish !== "empty-first") continue;
			const elapsed = elapsedDays(state[row.lang]?.firstMissed, today);
			if (elapsed === null || elapsed < FIRST_PUBLISH_EXPIRY_DAYS) continue;
			stale.push(
				`${row.lang} (${row.server}): first-publish is empty-first and backs a live emptyFirstPublish marker, but the probe has not observed that axis since ${state[row.lang]?.firstMissed} (${elapsed} days) — the cell is standing on no measurement`,
			);
		}
		return stale;
	}

	it("keeps every committed empty-first cell backed by a live measurement", () => {
		expect(
			unbackedEmptyFirstCells(fs.readFileSync(MATRIX_PATH, "utf8")),
		).toEqual([]);
	});

	it("names an empty-first cell whose axis the probe stopped observing (#4615 plant)", () => {
		// Plant: the real matrix, refreshed for a month of nights that observed
		// nothing on the first-publish axis — the dead-instrument shape of #3310,
		// in the direction the expiry cannot reach on its own.
		const real = fs.readFileSync(MATRIX_PATH, "utf8");
		let text = refreshCapabilityMatrix(real, [], {
			src: "ci",
			now: "2026-09-01",
		}).text;
		text = refreshCapabilityMatrix(text, [], {
			src: "ci",
			now: "2026-09-20",
		}).text;
		const unbacked = unbackedEmptyFirstCells(text, "2026-09-20");
		// Was ["php", "terraform"]. terraform's marker is retired (#4615: its
		// `empty-first` reads came from the workspace-directory row), so its cell
		// is `direct` and is never a candidate for this rule. Only php, the one
		// empty-first cell left, is named.
		expect(unbacked.map((line) => line.split(" ")[0]).sort()).toEqual(["php"]);
		expect(unbacked.join("\n")).toContain("standing on no measurement");
		// The cell itself is NOT expired: it still backs its marker.
		const table = parseTable(text, "| lang | server |")!;
		const langIdx = table.header.indexOf("lang");
		const fpIdx = table.header.indexOf("first-publish");
		const php = table.rows.find((row) => row[langIdx] === "php")!;
		expect(php[fpIdx], "php").toBe("empty-first");
	});

	it("clears the miss stamp when the axis is observed again", () => {
		// The reverse direction: a live measurement makes the cell back its marker
		// again, so the census rule stops naming it. The stamp sits on php, the one
		// empty-first cell left after #4615 retired terraform's marker.
		const real = fs.readFileSync(MATRIX_PATH, "utf8");
		const first = refreshCapabilityMatrix(real, [], {
			src: "ci",
			now: "2026-09-01",
		}).text;
		const missed = refreshCapabilityMatrix(first, [], {
			src: "ci",
			now: "2026-09-20",
		}).text;
		expect(unbackedEmptyFirstCells(missed, "2026-09-20")).toEqual([
			expect.stringContaining("php"),
		]);
		const observed = refreshCapabilityMatrix(
			missed,
			[
				{
					lang: "php",
					firstPublish: "empty-first",
					cleanBehavior: null,
					tier: null,
				},
			],
			{ src: "ci", now: "2026-09-20" },
		).text;
		expect(unbackedEmptyFirstCells(observed, "2026-09-20")).toEqual([]);
	});

	it("never marks one server both seedFirstPush and emptyFirstPublish", () => {
		// "the first push is complete" and "the first push is provisional" cannot
		// both hold; the publish handler evaluates the hold first, so a server with
		// both markers would silently lose its seed fast path.
		const contradictory = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(
				([, strategy]) =>
					strategy.emptyFirstPublish === "indexing" && strategy.seedFirstPush,
			)
			.map(([serverId]) => serverId);
		expect(contradictory).toEqual([]);
	});
});
