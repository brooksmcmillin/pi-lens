import type { ExecVitest, ShuffleRun } from "./ci-shuffle-changed-tests.mjs";

export declare const CHUNK_FILES: number;
export declare const START_CAP_MS: number;
export declare const MIN_START_MS: number;
export declare const RATCHET_PATH: string;
export type Seed = number | "alone";
export interface CensusRun extends ShuffleRun {
	kind: "census" | "confirm" | "rerun";
	key?: string;
}
export interface Member {
	file: string;
	test: string;
	firstError: string;
}
export interface CensusRecord {
	key: string;
	kind: "census" | "confirm" | "rerun";
	label: string;
	files: string[];
	seed: Seed;
	verdict: "ok" | "red" | "timeout" | "uncollected";
	at?: number;
	ms: number;
	members: Member[];
	tail?: string;
}
export interface RatchetEntry {
	file: string;
	seed: number | "alone";
	test: string;
	seam: string;
}
export type MemberKind = "order-dependent" | "cross-file" | "fails alone";
export interface MemberRow extends Member {
	kind: MemberKind;
	seed: Seed;
}
export interface Verdict {
	code: 0 | 1 | 3 | 4;
	kind: "clean" | "red" | "unproven" | "stale";
	members: MemberRow[];
	stale: string[];
	lines: string[];
}
export declare function listTrackedFiles(
	cwd: string,
	pathspecs?: string[],
): string[];
export declare function listTestFiles(cwd: string): string[];
export declare function seedOf(run: { flags: string[] }): Seed;
export declare function planCensus(
	files: string[],
	options?: { seeds?: readonly number[]; chunk?: number; alone?: boolean },
): CensusRun[];
export declare function extractMembers(output: string): Member[];
export declare function loadRecords(dir: string): CensusRecord[];
export declare function isUnproven(record: CensusRecord): boolean;
export declare function runCensus(
	plan: CensusRun[],
	options: {
		cwd: string;
		outFile: string;
		done: Set<string>;
		budgetMs: number;
		exec?: ExecVitest;
		now?: () => number;
		log?: (line: string) => void;
	},
): { ran: number; pending: number };
export declare function planConfirms(records: CensusRecord[]): CensusRun[];
export declare function judgeCensus(state: {
	records: CensusRecord[];
	ratchet: Array<{ file: string }>;
	previousStale?: Iterable<string>;
	planned?: CensusRun[];
	censusResult?: string;
}): Verdict;
export declare function previousStaleFrom(
	issuesJson: string,
	title: string,
): string[];
export declare function issueBody(
	verdict: Verdict,
	options?: { runUrl?: string },
): string;
export declare function parseArgs(argv: string[]): {
	out: string;
	part: [number, number];
	chunk: number;
	budgetMs: number;
	seeds: number[];
	files: string[] | null;
	confirm: boolean;
	report: boolean;
	redoUnproven: boolean;
	alone: boolean;
	previousIssues: string | null;
	title: string | null;
	staleOut: string | null;
	bodyOut: string | null;
	runUrl: string;
	censusResult: string | undefined;
	ratchet: string;
	cwd: string;
};
export declare function run(
	argv: string[],
	io?: {
		exec?: ExecVitest;
		now?: () => number;
		log?: (line: string) => void;
		distExists?: (file: string) => boolean;
	},
): number;
