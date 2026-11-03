import { afterEach, describe, expect, it } from "vitest";
import {
	forgetCascadePendingNeighbor,
	formatCascadeNeighborDiagnostics,
	listCascadePendingNeighbors,
	markCascadeUnansweredPrimariesDelivered,
	recordDeliveredCascadeNeighbor,
	renderCascadeResult,
	resetCascadePendingNeighbors,
	resetCascadeUnansweredPrimariesDelivered,
	splitCascadeUnansweredPrimaries,
} from "../../clients/cascade-format.js";
import type {
	CascadeNeighborResult,
	CascadeResult,
} from "../../clients/cascade-types.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";

describe("formatCascadeNeighborDiagnostics", () => {
	it("renders an explicit marker for an inconclusive empty neighbor (#1444)", () => {
		const output = formatCascadeNeighborDiagnostics("C:/repo", [
			{
				filePath: "C:/repo/src/neighbor.ts",
				reason: "imports",
				diagnostics: [],
				lspTouched: true,
				inconclusive: true,
			},
		]);

		expect(output).toContain("neighbor.ts");
		expect(output).toContain("inconclusive");
		expect(output).toContain("no clean result was confirmed");
	});

	it("keeps a confirmed clean neighbor silent", () => {
		expect(
			formatCascadeNeighborDiagnostics("C:/repo", [
				{
					filePath: "C:/repo/src/neighbor.ts",
					reason: "imports",
					diagnostics: [],
					lspTouched: true,
				},
			]),
		).toBe("");
	});
});

/**
 * #4403 round 5 (V1): a server's "no language server answered" line is said
 * once per session, counted from delivery. Two servers in one cascade need
 * neighbours in two languages, which the turn-path test
 * (tests/clients/cascade-unanswered-primary-4403.test.ts) cannot build, so the
 * per-server rule is pinned here on the module's own state.
 */
describe("the cascade's unanswered-primary line, per server (#4403 V1)", () => {
	afterEach(() => resetCascadeUnansweredPrimariesDelivered());

	const neighbor = (
		file: string,
		serverIds?: string[],
	): CascadeNeighborResult => ({
		filePath: `/repo/${file}`,
		reason: "imports",
		diagnostics: [],
		lspTouched: true,
		...(serverIds && {
			primaryUnavailable: { serverIds, cause: "unstarted" as const },
		}),
	});
	const line = (ids: string): string =>
		`⚠️ Cascade: no primary language server answered for neighbor files of ${ids} (it could not be started, or was still starting), so their cross-file errors were not confirmed (not a clean result).`;
	const neighbors = (): CascadeNeighborResult[] => [
		neighbor("a.ts", ["typescript"]),
		neighbor("b.py", ["pyright"]),
		neighbor("c.ts"),
	];

	// Recurrence: a delivered server's neighbours kept in every later run
	// give each run a non-empty `formatted`, which hides #1104's
	// binding-rejected marker; the run must drop them as it did before #4403.
	it("drops a delivered server's neighbours and line, and keeps the other server's", () => {
		markCascadeUnansweredPrimariesDelivered(["typescript"]);
		const split = splitCascadeUnansweredPrimaries(neighbors());
		expect({
			answered: split.answered.map((n) => n.filePath),
			unanswered: split.unanswered.map((n) => n.filePath),
			notes: split.notes,
		}).toEqual({
			answered: ["/repo/c.ts"],
			unanswered: ["/repo/b.py"],
			notes: [{ serverIds: ["pyright"], line: line("pyright") }],
		});
	});

	// Recurrence: a run carried past the turn that delivered its server's
	// line (or a second run of that turn) repeated it.
	it("renders a line only while one of its servers is neither delivered nor shown this turn", () => {
		const { notes } = splitCascadeUnansweredPrimaries(neighbors());
		const result: CascadeResult = {
			filePath: "/repo/x.ts",
			impact: {} as CascadeResult["impact"],
			neighbors: neighbors(),
			formatted: ["body", ...notes.map((note) => note.line)].join("\n"),
			unansweredPrimaries: { notes, formattedWithoutNotes: "body" },
		};
		const shown = new Set<string>();
		const first = renderCascadeResult(result, shown);
		const again = renderCascadeResult(result, shown);
		markCascadeUnansweredPrimariesDelivered(["pyright"]);
		const nextTurn = renderCascadeResult(result, new Set());
		// The text never carries the lines: turn_end puts the kept ones at the
		// head of the section (round 6, W2).
		expect([first, again, nextTurn]).toEqual([
			{
				text: "body",
				lines: [line("typescript"), line("pyright")],
				serverIds: ["typescript", "pyright"],
			},
			{ text: "body", lines: [], serverIds: [] },
			{ text: "body", lines: [line("typescript")], serverIds: ["typescript"] },
		]);
	});
});

/**
 * #4487: the pending record of delivered cascade neighbour errors, on the
 * module's own state.
 */
describe("the cascade's pending neighbour-error record (#4487)", () => {
	afterEach(() => {
		resetCascadePendingNeighbors();
		resetDegradationLedger();
	});

	const error = (filePath: string): Diagnostic => ({
		id: "typescript:2322",
		message: "Type 'string' is not assignable to type 'number'.",
		filePath,
		line: 2,
		column: 14,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "typescript:2322",
	});
	const paths = () => listCascadePendingNeighbors().map((e) => e.filePath);

	// Recurrence: a clean answer published BEFORE an error was delivered (a
	// late quiet-window answer to an older touch) erased the newer error.
	it("forgets an entry only for a clean observation newer than the error it holds", () => {
		recordDeliveredCascadeNeighbor(
			"/repo/b.ts",
			[error("/repo/b.ts")],
			1,
			1_000,
		);
		forgetCascadePendingNeighbor("/repo/b.ts", 1_000);
		forgetCascadePendingNeighbor("/repo/b.ts", 999);
		expect(paths()).toEqual(["/repo/b.ts"]);
		forgetCascadePendingNeighbor("/repo/b.ts", 1_001);
		expect(paths()).toEqual([]);
	});

	// Recurrence: a session-long store keyed by neighbour path with no cap
	// (the bounded-container rule); the oldest entry goes, once recorded.
	it("keeps at most 256 neighbours, evicting the oldest with one degradation record", () => {
		for (let i = 0; i <= 256; i++) {
			const file = `/repo/n${i}.ts`;
			recordDeliveredCascadeNeighbor(file, [error(file)], 1, i);
		}
		const kept = paths();
		expect(kept).toHaveLength(256);
		expect(kept[0]).toBe("/repo/n1.ts");
		expect(
			getDegradationSummary().filter(
				(row) => row.kind === "cascade-pending-neighbors-evicted",
			),
		).toHaveLength(1);
	});
});
