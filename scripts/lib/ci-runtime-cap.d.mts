// #3920 item 3 / #4691: the runtime-vs-cap rule shared by ci-verdict and the nightly p90 check.
export declare const RUNTIME_CAP_WARN_RATIO: number;
export declare const MAX_RUNTIME_CAP_LINES: number;
export type JobCapEntry = {
	file: string;
	jobId: string;
	name: string;
	capMinutes: number;
	pattern: RegExp;
};
export declare function checkNamePattern(
	jobName: string,
	escapeRegExp: (text: string) => string,
): RegExp;
export declare function jobCapEntries(
	doc: unknown,
	file: string,
	escapeRegExp: (text: string) => string,
): JobCapEntry[];
export declare function runtimeCapLines(args: {
	checkRuns: readonly unknown[];
	caps: readonly JobCapEntry[];
	requiredChecks?: readonly string[];
	ratio?: number;
	limit?: number;
}): string[];
export declare function p90(values: number[]): number | undefined;
export type JobRow = {
	name?: string;
	started_at?: string | null;
	completed_at?: string | null;
};
export type MasterRun = {
	id: number;
	created_at: string;
	jobs: readonly JobRow[];
};
export type P90Warning = {
	name: string;
	file: string;
	jobId: string;
	context: string;
	p90Seconds: number;
	capSeconds: number;
	ratio: number;
	samples: number;
	window: { runs: number; from: string; to: string };
};
export declare function p90CapReport(input: {
	caps: readonly JobCapEntry[];
	runs: readonly MasterRun[];
	requiredChecks?: Iterable<string>;
	ratio?: number;
}): { warnings: P90Warning[]; measuredContexts: string[] };
export declare function formatP90Warning(w: P90Warning): string;
