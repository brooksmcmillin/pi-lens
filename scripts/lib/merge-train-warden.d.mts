export const CONFLICT_LABEL: string;
export const RED_CI_LABEL: string;
export const REQUIRED_CHECKS: string[];
export const PAGE_SIZE: number;
export const MAX_PAGES: number;

export type FetchFn = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface WardenPr {
	number: number;
	url: string;
	headSha: string | undefined;
	mergeStateStatus: string;
	autoMergeEnabled: boolean;
	isFork: boolean;
	labels: Set<string>;
	checksUnknown: boolean;
	failingRequiredChecks: Array<{ name: string; url?: string }>;
	unresolvedRequiredChecks: string[];
}

export type WardenAction =
	| { type: "add-label"; label: string }
	| { type: "remove-label"; label: string }
	| { type: "comment"; body: string }
	| { type: "update-branch" }
	| { type: "note"; benign: boolean; message: string };

export interface WardenError {
	message: string;
	benign: boolean;
}

export interface WardenResult {
	number: number | null;
	url: string | null;
	mergeStateStatus: string | null;
	applied: string[];
	errors: WardenError[];
}

export function fetchOpenPullRequests(
	fetcher: FetchFn,
	owner: string,
	name: string,
): Promise<{ prs: WardenPr[]; errors: string[] }>;
export function decideActions(pr: WardenPr): WardenAction[];
export function classifyActionFailure(
	action: WardenAction,
	pr: WardenPr,
	status: number,
): { benign: boolean; outcome: string | null };
export function applyAction(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	pr: WardenPr,
	action: WardenAction,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function runWarden(options: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
}): Promise<WardenResult[]>;
