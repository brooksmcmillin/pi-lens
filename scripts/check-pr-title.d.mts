export declare const MISSING_PREFIX_MESSAGE: string;
export declare const MISSING_ISSUE_REF_MESSAGE: string;
export declare function lintPrTitle(
	title?: string,
	body?: string,
): { valid: boolean; errors: string[] };
