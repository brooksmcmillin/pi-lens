export interface ScanSuite {
	dir: string[];
	sgConfig: string;
	baseline: string;
	category: string | undefined;
	scanPaths: string[];
	contentKeyed: boolean;
	reasonedIgnores?: boolean;
}

export const SUITES: Record<string, ScanSuite>;
export function suiteByName(name: string): ScanSuite;

export function repoRoot(): string;
export function rulesDir(root?: string, suite?: ScanSuite): string;

export function selfScanRuleIds(root?: string, suite?: ScanSuite): string[];

export interface SelfScanFinding {
	ruleId?: string;
	file?: string;
	range?: { start?: { line?: number } };
	[key: string]: unknown;
}

export interface SelfScanResult {
	ruleIds: string[];
	findings: SelfScanFinding[];
	advisoryFindings: SelfScanFinding[];
	scannedFileCount: number | undefined;
	effectiveRuleCount: number | undefined;
	stderr: string;
}

export function runSelfScan(options?: {
	root?: string;
	suite?: ScanSuite;
	scanPaths?: string[];
	ruleIds?: string[];
	sgConfigPath?: string;
}): SelfScanResult;

export function findingSignature(finding: SelfScanFinding): string;

export function findingSignatures(
	findings: SelfScanFinding[],
	suite?: ScanSuite,
): string[];

export function runRuleTests(
	root?: string,
	suite?: ScanSuite,
): { status: number | null; stdout?: string; stderr?: string; error?: Error };

export function loadBaseline(root?: string, suite?: ScanSuite): Set<string>;

export function writeBaseline(
	signatures: Iterable<string>,
	root?: string,
	suite?: ScanSuite,
	findings?: SelfScanFinding[],
): string;

export const REASONED_IGNORE: RegExp;

export function findUnreasonedIgnores(
	files: string[],
	root?: string,
): { file: string; line: number; text: string }[];

export function filesMentioningIgnore(
	root?: string,
	roots?: string[],
): string[];

export function changedFilesSince(base: string, cwd?: string): Set<string>;

export function findingsInChangedFiles(
	findings: SelfScanFinding[],
	changed: Set<string>,
	root?: string,
): SelfScanFinding[];

export function trackedSelfScanFileSet(
	root?: string,
	roots?: string[],
): Set<string> | undefined;

export function findingsInTrackedFiles(
	findings: SelfScanFinding[],
	tracked: Set<string> | undefined,
): SelfScanFinding[];
