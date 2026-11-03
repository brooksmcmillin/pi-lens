// #4672: the cost table's only producer. These declarations are the contract
// every TypeScript importer sees (tests/config/dmts-export-drift.test.ts holds
// them to the .mjs exports).
export type ModelCostTable = {
	files: Record<string, number>;
	/** The median TLC distinct-state count per config (#4714). */
	states: Record<string, number>;
	sources: string[];
	perShardShares: Record<string, number>;
};

/**
 * Per-config TLC seconds from one `gh run view --log --job <id>` capture: the
 * `ok|FAIL formal/<family>/<Model>.cfg: ... (Ns)` lines the checker prints.
 */
export declare function costsFromLog(
	text: string | null | undefined,
): Map<string, number>;

/** Per-config TLC distinct-state counts from one log (#4714); absent when unprinted. */
export declare function statesFromLog(
	text: string | null | undefined,
): Map<string, number>;

/** One median per config over every log that ran it, keys sorted. */
export declare function buildModelCosts(
	logs: ReadonlyArray<{ source: string; text: string }>,
): ModelCostTable;

/** The share of the tree's configs a generated table must price. */
export declare const MIN_TABLE_COVERAGE: number;

/** Why `files` cannot ship as the cost table, or null when it can. */
export declare function incompleteTableReason(
	files: Record<string, number>,
	args: { configCount: number },
): string | null;

export declare function main(
	argv?: readonly string[],
	args?: { root?: string },
): number;
