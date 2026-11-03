export type TlcVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string }
	| { status: "error"; detail: string };
export type ExpectedVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string };
export declare const TLA_TOOLS: Readonly<{
	release: string;
	url: string;
	sha256: string;
}>;
export declare function parseModelHeader(
	text: string,
): { module: string; expect: ExpectedVerdict } | { error: string };
export declare function classifyTlcOutput(output: string): TlcVerdict;
export declare function verdictMatches(
	expected: ExpectedVerdict,
	actual: TlcVerdict,
): boolean;
export declare function describeVerdict(verdict: TlcVerdict): string;
export declare function listModelConfigs(root: string): string[];
export declare function ensureJar(
	jarArg: string | undefined,
	root: string,
): Promise<string>;
export declare function resolveJarPath(
	jarArg: string | undefined,
	root: string,
): string;
export declare function computeConcurrency(
	numConfigs: number,
	availableParallelism: number,
): number;
export declare function parseConcurrencyArg(raw: string | undefined): number;
export declare function resolveConcurrency(
	concurrencyRaw: string | undefined,
	numConfigs: number,
	availableParallelism: number,
): number;
export declare function formatSummary(
	configCount: number,
	shard: string | undefined,
	wallSeconds: number,
	concurrency: number,
): string;
export declare function parseShardArg(raw: string | undefined): {
	index: number;
	total: number;
};
/** The measured per-config cost table's file, repo-relative (#4672). */
export declare const MODEL_COSTS_FILE: string;
export type ModelCosts = {
	root: string;
	files: Record<string, number>;
	max: number;
	/** The recorded TLC distinct-state counts (#4714); absent before it. */
	states?: Record<string, number>;
};
export declare function loadModelCosts(root: string): {
	files: Record<string, number>;
	max: number;
	states: Record<string, number>;
};
/** TLC's distinct-state count from its statistics line, or null (#4714). */
export declare function parseDistinctStates(output: string): number | null;
/** How far a config's distinct-state count may grow past its recorded count. */
export declare const STATE_COUNT_FACTOR: number;
export type StateCountJump = {
	id: string;
	recorded: number;
	observed: number;
};
/** The runs that grew past their recorded count by more than `factor`. */
export declare function stateCountJumps(
	outcomes: ReadonlyArray<{ id: string; distinctStates: number | null }>,
	states: Record<string, number>,
	factor?: number,
): StateCountJump[];
export declare function formatStateJump(
	jump: StateCountJump,
	factor?: number,
): string;
/** The configs that ran with a count but have no recorded count yet. */
export declare function unrecordedStateCounts(
	outcomes: ReadonlyArray<{ id: string; distinctStates: number | null }>,
	states: Record<string, number>,
): string[];
/**
 * The cost table's key for `config`: its path under `root`, always posix.
 * `pathImpl` defaults to the host `path`; pass `path.win32` to dose one
 * (AGENTS.md shape 35).
 */
export declare function modelCostId(
	root: string,
	config: string,
	pathImpl?: { relative: (from: string, to: string) => string; sep: string },
): string;
/** `costs` null keeps the round-robin split; a table packs by measured cost. */
export declare function selectShard(
	configs: readonly string[],
	shard: { index: number; total: number },
	costs?: ModelCosts | null,
): string[];
/**
 * How far this run's own ORDERING may disagree with the table's before the
 * balance line calls the table stale. Scale-free on purpose: one shard's summed
 * ratio carries the runner's speed, the ranking does not.
 */
export declare const MODEL_COST_RANK_TOLERANCE: number;
/**
 * The balance line. `observed` maps `modelCostId` keys to the seconds this run
 * measured, so the second half compares the projection with the run: the
 * summed ratio as an advisory number, the rank agreement as the drift verdict.
 */
export declare function formatShardBalance(args: {
	configs: readonly string[];
	total: number;
	costs: ModelCosts;
	observed?: Map<string, number> | Record<string, number> | null;
	rankTolerance?: number;
}): string;
export declare function resolveShardCosts(
	argv: readonly string[],
	root: string,
): ModelCosts | null;
export declare function parseCliArgs(argv: readonly string[]): {
	jar?: string;
	concurrency?: string;
	shard?: string;
};
export declare function selectConfigs(
	argv: readonly string[],
	root: string,
): string[];
export declare function buildJavaArgs(
	jar: string,
	metadir: string,
	configBasename: string,
	module: string,
): string[];
export declare function runPool<Item, Result>(
	items: readonly Item[],
	concurrency: number,
	task: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]>;
