export declare function githubGet(
	path: string,
	fetchImpl: typeof fetch,
): Promise<Response>;
export declare function githubHeaders(
	token: string | undefined,
): Record<string, string>;
export declare function githubFetcher(
	token: string,
): (url: string, init?: RequestInit) => Promise<Response>;
