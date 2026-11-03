export const CASCADE_CONCLUSIVE_DEADLINE_MS: number;
export const CASCADE_WARM_DEADLINE_MS: number;
export const CASCADE_RETRY_INTERVAL_MS: number;
export const CASCADE_RENAME_EXTRA_DEADLINES: number;

export interface CascadeFixture {
	/** The LSP_FIXTURES row whose tools, setup and handshake-census entry this reuses. */
	lang: string;
	dir: string;
	/** The exporter the lane breaks. */
	file: string;
	/** The exported function the edit breaks; each neighbour calls it. */
	symbol: string;
	neighbours: string[];
	edit: { from: string; to: string };
	/** Pattern the server's own message must match in each neighbour's block. */
	expectFindings?: string;
	/** The rename phase (#1677): move the exporter, then ask the importers. */
	rename?: RenameFixture;
	/**
	 * A known defect of the cascade for this fixture: the one outcome it
	 * excuses, as a `known-defect` row. Every other outcome is red.
	 */
	expectDefect?: { skipReason: string; reason: string };
	/** Env var the workflow sets when it provisioned this server itself. */
	provisionedBy?: string;
	warmDeadlineMs?: number;
	conclusiveDeadlineMs?: number;
	serverHint?: string;
}

export interface RenameFixture {
	/** The exporter's new path, relative to the workspace. */
	to: string;
	/** What an importer spells while the server offered no rewrite for it. */
	staleSpecifier: string;
	/** Pattern the server's message must match in a stale importer. */
	expectFindings: string;
}

export type RenameImporterVerdict =
	| "unconfirmed"
	| "concluded"
	| "stale-clean"
	| "wrong-finding";

export interface RenameMeasurement {
	state:
		| "concluded"
		| "no-baseline"
		| "rename-failed"
		| "notify-failed"
		| "unconcluded";
	detail: string;
	renameMs?: number;
	/** Importers the server's `willRenameFiles` edit rewrote. */
	importersRewritten?: number;
	/** From the start of the rename call to every importer concluded. */
	timeToConclusiveMs?: number;
	importers?: Record<string, RenameImporterVerdict>;
}

export type NeighbourVerdict = "unconfirmed" | "findings" | "clean";

export interface CascadeRunLike {
	skipReason?: string;
	observedNeighborPaths?: string[];
	unconfirmed?: { servers: Array<{ paths: string[] }> };
	result?: { formatted?: string };
}

export interface CascadeClassification {
	state: "conclusive" | "wrong-verdict" | "inconclusive";
	neighbours: Record<string, NeighbourVerdict>;
	/** Set when the run was classified inconclusive by a skip reason. */
	skipReason?: string;
	detail: string;
}

export interface CascadeMeasurement {
	handshook?: boolean;
	answered: boolean;
	warmMs: number;
	attempts: number;
	firstCascadeMs?: number;
	elapsedMs?: number;
	timeToConclusiveMs?: number;
	/** Why the last warm-up touch went unanswered (latency-log phases). */
	why?: string;
	neighbours?: Record<string, NeighbourVerdict>;
	concluded?: CascadeClassification;
	rename?: RenameMeasurement;
}

export interface CascadeRow {
	lang: string;
	runner: string;
	state: "pass" | "fail" | "skip" | "known-defect";
	detail: string;
	diags: number;
}

export const CASCADE_FIXTURES: CascadeFixture[];
export function neighbourVerdict(
	run: CascadeRunLike | undefined,
	workspace: string,
	rel: string,
): NeighbourVerdict;
export function neighbourShowsFinding(
	run: CascadeRunLike | undefined,
	rel: string,
	pattern: string,
): boolean;
export function classifyCascadeRun(
	run: CascadeRunLike | undefined,
	fx: Pick<CascadeFixture, "neighbours" | "expectFindings">,
	workspace: string,
): CascadeClassification;
export function classifyRenameImporter(
	rename: RenameFixture,
	seen: { content: string; messages: string[] | undefined },
): RenameImporterVerdict;
export function cascadeRow(
	fx: Partial<CascadeFixture> & { lang: string },
	m: CascadeMeasurement,
): CascadeRow;
export function cascadeTimesRecord(
	rows: CascadeRow[],
	measurements: Record<string, CascadeMeasurement>,
	env?: Record<string, string | undefined>,
): {
	schema: number;
	command: string;
	date: string;
	runner: Record<string, unknown>;
	rows: Array<Record<string, unknown>>;
};

export function describeLastTouch(
	latencyLogText: string,
	file: string,
	extensionLogText?: string,
): string;
