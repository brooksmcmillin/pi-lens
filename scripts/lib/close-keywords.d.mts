export declare const INVALID_CLOSE_KEYWORD_MESSAGE: string;
export declare const NEGATED_CLOSE_KEYWORD_MESSAGE: string;
export declare function stripNonSemanticMarkdown(body?: string): string;
export declare function parseCloseKeywords(body?: string): {
	issues: number[];
	commaLists: number[];
	offendingLines: string[];
	negatedLines: string[];
	negatedIssues: number[];
};
export declare function lintCloseKeywords(
	body?: string,
): ReturnType<typeof parseCloseKeywords> & { valid: boolean };
export declare function lintCloseKeywordPlacement(
	title?: string,
	body?: string,
): { valid: boolean; titleIssues: number[]; missingBodyIssues: number[] };
export declare function closeKeywordErrors(result: {
	commaLists: number[];
	offendingLines: string[];
	negatedLines: string[];
}): string[];
export declare function closeKeywordPlacementMessage(missing: number[]): string;
export declare const COMMIT_CLOSE_KEYWORD_MESSAGE: string;
export declare function lintCommitCloseKeywords(
	commits?: Array<{ sha: string; message: string }>,
	title?: string,
	body?: string,
): {
	valid: boolean;
	offenses: Array<{ sha: string; number: number; line: string }>;
};
export declare function commitCloseKeywordErrors(result: {
	valid: boolean;
	offenses: Array<{ sha: string; number: number; line: string }>;
}): string[];
