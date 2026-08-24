export const MAX_PAGES: number;
export const PAGE_SIZE: number;
export const MAX_COMMIT_DETAILS: number;
export const DETECTOR_ISSUE: number;
export interface StaleIssueCandidate {
	issue: {
		number: number;
		title: string;
		html_url: string;
		pull_request?: unknown;
	};
	evidence: string[];
}
export function detectStaleOpenIssues(options: {
	fetcher: (
		url: string,
		init?: RequestInit,
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	repository: string;
	branch?: string;
}): Promise<{ candidates: StaleIssueCandidate[]; truncatedCommits: number }>;
export function formatSummary(
	candidates: StaleIssueCandidate[],
	options?: { runUrl?: string; truncatedCommits?: number },
): string;
export function defaultFetcher(
	token: string,
): (url: string, init?: RequestInit) => Promise<Response>;
