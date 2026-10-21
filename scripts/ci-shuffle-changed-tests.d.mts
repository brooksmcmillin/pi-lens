export declare const SEEDS: readonly number[];
export declare const BUDGET_MS: number;
export interface GitOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}
export interface ShuffleRun {
	label: string;
	files: string[];
	flags: string[];
}
export interface ExecOutcome {
	status: number | null;
	output: string;
	timedOut: boolean;
}
export type ExecVitest = (
	run: { files: string[]; flags: string[] },
	options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => ExecOutcome;
export interface RunResult {
	run: ShuffleRun;
	verdict: "ok" | "red" | "timeout" | "uncollected";
	output: string;
	ms: number;
}
export declare function selectChangedTestFiles(
	paths: string[],
	exists?: (file: string) => boolean,
	added?: readonly string[],
): string[];
export declare function planRuns(
	files: string[],
	seeds?: readonly number[],
	options?: { alone?: boolean; added?: readonly string[] },
): ShuffleRun[];
export declare function reproCommand(run: {
	files: string[];
	flags: string[];
}): string;
export declare const execVitest: ExecVitest;
export declare function runPlan(
	plan: ShuffleRun[],
	options: {
		cwd: string;
		budgetMs?: number;
		exec?: ExecVitest;
		now?: () => number;
		log?: (line: string) => void;
	},
): { results: RunResult[]; notRun: ShuffleRun[] };
export declare function judge(state: {
	files: string[];
	results: RunResult[];
	notRun: ShuffleRun[];
}): { code: 0 | 1 | 3; kind: "clean" | "red" | "unproven"; lines: string[] };
export declare function parseArgs(argv: string[]): {
	base: string | null;
	head: string | null;
	files: string[] | null;
	cwd: string;
};
export declare function run(
	argv: string[],
	io?: {
		env?: NodeJS.ProcessEnv;
		diff?: (range: string, options: GitOptions) => string[] | null;
		added?: (range: string, options: GitOptions) => string[] | null;
		exec?: ExecVitest;
		now?: () => number;
		budgetMs?: number;
		log?: (line: string) => void;
	},
): number;
