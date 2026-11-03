// Types for the (plain-JS) certified-host spread, so the TS unit test can drive
// the CLI's own decisions — argv refusal, the missing-build and unreadable-doc
// refusals, the per-host lines, the failed-tier transcript and the exit codes —
// without spawning a Vitest run inside a Vitest worker. Running the real tiers
// is the CLI's own job and the manual/nightly spread's.

import type { TierResult, TierSuite } from "./lib/pi-host-spread.mjs";

/** The boundaries a case may replace; every default is the real seam. */
export interface ProbeBoundaries {
	baselineDoc?: string;
	extensionEntry?: string;
	vitestEntry?: string;
	readFile?: (file: string) => string;
	exists?: (file: string) => boolean;
	runTierSuite?: (input: {
		host: { version: string; dir: string };
		suite: TierSuite;
		timeoutMs: number;
	}) => Promise<TierResult & { detail?: string }>;
	write?: (text: string) => void;
	warn?: (text: string) => void;
	env?: NodeJS.ProcessEnv;
}

export declare function main(
	argv: string[],
	boundaries?: ProbeBoundaries,
): Promise<number>;
