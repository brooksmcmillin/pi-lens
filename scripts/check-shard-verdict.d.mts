// #4672: the shard-verdict seam both sharded required aggregates call. These
// declarations are the contract every TypeScript importer sees
// (tests/config/dmts-export-drift.test.ts holds them to the .mjs exports).
export type ShardJobStep = {
	name?: string;
	conclusion?: string | null;
	status?: string;
	number?: number;
	started_at?: string | null;
	completed_at?: string | null;
};

export type ShardJob = {
	id?: number;
	name?: string;
	conclusion?: string | null;
	steps?: ShardJobStep[];
};

export type ShardOutcome = "pass" | "warn" | "fail";

export type ShardJobVerdict = {
	outcome: ShardOutcome;
	reason: string;
};

export type ShardVerdict = {
	outcome: ShardOutcome;
	line: string;
};

export type ShardVerdictArgs = {
	label: string;
	result: string;
	shardPattern: RegExp;
	/** The step that does the shard's work (the first entry of `checkSteps`). */
	checkStep?: string;
	/** Every gating step that job must finish; `--check-step` is repeatable. */
	checkSteps?: string | readonly string[];
	jobs: readonly ShardJob[];
};

export type ShardVerdictCliArgs = {
	label: string;
	result: string;
	"shard-pattern": string;
	"check-step": string[];
	repository?: string;
	run?: string;
	"jobs-file"?: string;
	"jobs-url"?: string;
};

export declare function parseArgs(argv: readonly string[]): ShardVerdictCliArgs;
export declare function classifyShardJob(
	job: ShardJob,
	checkSteps: string | readonly string[],
): ShardJobVerdict;
export declare function evaluateShardVerdict(
	args: ShardVerdictArgs,
): ShardVerdict;
export declare function jobsUrl(args: {
	repository?: string;
	run?: string;
	jobsUrlOverride?: string;
}): string | null;
export declare function readJobs(args: {
	jobsFile?: string;
	url?: string | null;
	token?: string;
	fetchImpl?: typeof fetch;
	readFileSync?: (path: string, encoding: string) => string;
}): Promise<ShardJob[]>;
export declare function runShardVerdict(args?: {
	argv?: readonly string[];
	env?: Record<string, string | undefined>;
	stdout?: (line: string) => void;
	fetchImpl?: typeof fetch;
	readFileSync?: (path: string, encoding: string) => string;
}): Promise<{ code: number; outcome: ShardOutcome; line: string }>;
export declare function main(): Promise<void>;
