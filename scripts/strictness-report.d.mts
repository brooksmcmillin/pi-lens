export interface StrictnessResult {
	config: string;
	exitCode: number;
	total: number;
	counts: Record<string, number>;
	/** tsc lines carrying `error TSnnnn` that no bucket classifies (#4429). */
	unclassified: string[];
}

export declare const REPORT_ROOTS: readonly string[];
export declare function parseDiagnostics(
	output: string,
	repoRoot: string,
): Pick<StrictnessResult, "counts" | "unclassified">;
export declare function runCheck(
	config: string,
	repoRoot?: string,
): StrictnessResult;
export declare function formatReport(summary: StrictnessResult[]): string;
export declare function main(argv?: string[]): void;
