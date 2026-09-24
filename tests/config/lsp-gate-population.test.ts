// #3217 recurrence guard: 43 LSP fixtures were added to
// `scripts/smoke-tools.mjs` between #2780 (which built the nightly clean gate)
// and 2026-09-18 WITHOUT gate coverage — nightly run 35334544752 drove the real
// `lsp_diagnostics` handler for 7 servers out of ~50 while the other ~43 only
// had to complete an `initialize` handshake. That is the exact hole #2776
// (provenance) walked through: it passed the handshake layer and shipped.
// Nothing in the repo noticed, because opting in was a per-fixture flag with no
// counterpart asserting the flag was considered.
//
// This file makes the decision explicit and mandatory: every fixture the gate
// COULD drive carries either `lspGate: true` or an `lspGateExempt: "<reason>"`,
// so a new fixture cannot silently join the handshake-only population.
//
// It reads the fixture table as DATA (`import { LSP_FIXTURES }`) rather than
// scanning `smoke-tools.mjs` as text, so no comment, string literal or
// commented-out block can satisfy any assertion here (#3217 F5 — the
// "detectors match code, not prose" screen, satisfied structurally instead of
// by comment-and-string blanking).
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	formatGateCensus,
	LSP_FIXTURES,
	lspGatePopulation,
} from "../../scripts/smoke-tools.mjs";

type Fixture = (typeof LSP_FIXTURES)[number] & {
	lspGate?: boolean;
	lspGateMarker?: string;
	lspGateExempt?: string;
	clean?: boolean;
	auxiliaryServerIds?: string[];
};

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fixtures = LSP_FIXTURES as Fixture[];

describe("LSP clean-gate population (#3217)", () => {
	it("gives every gate-eligible fixture exactly one of lspGate / lspGateExempt", () => {
		const { eligible } = lspGatePopulation() as { eligible: Fixture[] };
		// A floor, not a pin: if the fixture table or the eligibility filter ever
		// yields (almost) nothing, every assertion below passes on an empty set
		// and the guard reads clean while covering nothing. 45 eligible fixtures
		// on 2026-09-23 (26 gated, 19 exempt); the floor is deliberately well under
		// that so ordinary fixture churn never touches it.
		assertNonEmptyScan("LSP gate-eligible fixtures", eligible.length, 30);
		const undecided = eligible
			.filter(
				(fixture) =>
					fixture.lspGate !== true && typeof fixture.lspGateExempt !== "string",
			)
			.map((fixture) => fixture.lang);
		expect(
			undecided,
			"fixtures with neither lspGate nor lspGateExempt",
		).toEqual([]);

		const both = eligible
			.filter(
				(fixture) =>
					fixture.lspGate === true && typeof fixture.lspGateExempt === "string",
			)
			.map((fixture) => fixture.lang);
		expect(both, "fixtures claiming both opt-in and exemption").toEqual([]);
	});

	// #2780's own guard, carried over from the deleted
	// tests/scripts/smoke-tools-lsp-gate-fixtures.test.ts: a fixture with no
	// seeded defect (`clean: true`) or one whose contract is an AUXILIARY
	// server's finding must never be asked for a PRIMARY finding.
	it("keeps clean and auxiliary fixtures out of the gate entirely", () => {
		const wronglyGated = fixtures
			.filter(
				(fixture) =>
					fixture.lspGate === true &&
					(fixture.clean === true ||
						(fixture.auxiliaryServerIds?.length ?? 0) > 0),
			)
			.map((fixture) => fixture.lang);
		expect(wronglyGated).toEqual([]);
	});

	// #3217 F2 (the #3278 / ADR 0009 attribution class in miniature): a marker
	// that is not literally in the file it names cannot be removed to prove the
	// red direction, so the gate row would be unfalsifiable.
	it("requires every opted-in fixture's marker to be present in its own source", () => {
		const { gated } = lspGatePopulation() as { gated: Fixture[] };
		expect(gated.length).toBeGreaterThan(0);
		for (const fixture of gated) {
			expect(fixture.lspGateMarker, fixture.lang).toBeTruthy();
			const source = readFileSync(
				path.join(repoRoot, fixture.dir, fixture.file),
				"utf8",
			);
			expect(source, fixture.lang).toContain(fixture.lspGateMarker);
		}
	});

	it("requires every exemption to state a reason, not just carry the key", () => {
		const { exempt } = lspGatePopulation() as { exempt: Fixture[] };
		for (const fixture of exempt) {
			expect(
				(fixture.lspGateExempt ?? "").trim().length,
				`${fixture.lang} exemption reason`,
			).toBeGreaterThanOrEqual(20);
		}
	});

	// #3217 F7: `java` and `java-lombok` are two fixtures over one server
	// (jdtls). A duplicated `lang` would let one server be counted twice in the
	// census line below, or let a fixture be edited while its twin silently
	// kept the old flag.
	it("keys every fixture by a unique lang", () => {
		const langs = fixtures.map((fixture) => fixture.lang);
		expect(langs).toEqual([...new Set(langs)]);
	});

	// #3217 F6: the nightly's `gated N / handshake-only M / unavailable K` line
	// is derived from the same population helper the runner selects with, so the
	// three counts must partition the eligible population exactly. A count
	// computed independently of the table is how a summary line drifts from the
	// matrix rows it claims to summarize.
	it("prints a census whose counts partition the eligible population", () => {
		const population = lspGatePopulation() as {
			eligible: Fixture[];
			gated: Fixture[];
			exempt: Fixture[];
		};
		const rows = population.gated.map((fixture, index) => ({
			lang: fixture.lang,
			state: index === 0 ? "skip" : "pass",
		}));
		const line = formatGateCensus(population, rows);
		const match =
			/gated (\d+) \/ handshake-only (\d+) \/ unavailable (\d+)/.exec(line);
		expect(match, line).not.toBeNull();
		const [gated, handshakeOnly, unavailable] = match!
			.slice(1)
			.map((value) => Number(value));
		expect(unavailable).toBe(1);
		expect(gated).toBe(population.gated.length - 1);
		expect(handshakeOnly).toBe(population.exempt.length);
		expect(gated + handshakeOnly + unavailable).toBe(
			population.eligible.length,
		);
	});
});
