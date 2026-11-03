/** The one host package the tiers load. */
export declare const HOST_PACKAGE: string;

/** One tier's own contract suite, as a repo path. */
export interface TierSuite {
	tier: "tier1" | "tier2";
	file: string;
}

export declare const TIER_SUITES: TierSuite[];

export interface VerifiedHostRow {
	line: string;
	version: string | null;
}

export declare function compareVersions(a: string, b: string): number;

export declare function parseVerifiedHostRows(markdown: string): {
	rows: VerifiedHostRow[];
	hasHeader: boolean;
};

export declare function certifiedHosts(markdown: string): {
	versions: string[];
	unparseable: string[];
	problem?: string;
};

export declare function hostPackageCandidates(candidate: string): string[];

export declare function resolveHostPackage(
	candidate: string,
): { dir: string; version: string } | undefined;

export declare function discoverInstalledHosts(roots: string[]): {
	hosts: Array<{ version: string; dir: string }>;
	unreadable: string[];
};

export interface TierResult {
	ok: boolean;
	passed: number | null;
	total: number | null;
	detail?: string;
}

export interface SpreadRow {
	version: string;
	installed: boolean;
	dir?: string;
	tiers: Array<TierSuite & TierResult>;
	failed: boolean;
}

export interface Spread {
	rows: SpreadRow[];
	installed: number;
	missing: string[];
	failed: string[];
}

export declare function runSpread(options: {
	certified: string[];
	hosts: Array<{ version: string; dir: string }>;
	runTierSuite: (input: {
		host: { version: string; dir: string };
		suite: TierSuite;
	}) => Promise<TierResult>;
}): Promise<Spread>;

/** A parsed Vitest summary, as `parseVitestSummary` shapes it. */
export interface TierTranscriptSummary {
	testsPassed: number | null;
	testsFailed: number | null;
	testsSkipped: number | null;
}

export declare function tierVerdict(input: {
	status: number | null;
	timedOut?: boolean;
	summary: TierTranscriptSummary;
}): TierResult & { timedOut: boolean };

export declare function renderHostLine(row: SpreadRow): string;

export declare function renderSpreadSummary(spread: Spread): string;

export declare const EXIT: {
	ok: 0;
	tiersFailed: 1;
	usage: 2;
	hostMissing: 3;
};

export declare function exitCodeForSpread(
	spread: Spread,
	options?: { requireAll?: boolean },
): number;

export declare function parseCliArgs(argv: string[]): {
	hostRoots: string[];
	requireAll: boolean;
	timeoutMs: number;
	help: boolean;
};
