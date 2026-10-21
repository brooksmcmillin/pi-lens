export declare const DEFAULT_KEEP: number;
export declare const KEEP_BY_PREFIX: Readonly<Record<string, number>>;
export declare const LIST_LIMIT: number;
export declare function cacheFamily(key: string): string;
export type CacheEntry = {
	id: number;
	key: string;
	ref: string;
	sizeInBytes: number;
	createdAt: string;
};
export declare function planPrune(input: {
	caches: CacheEntry[];
	openPulls: Iterable<number>;
	branches: Iterable<string>;
	defaultBranch?: string;
}): Array<CacheEntry & { reason: string }>;
export declare function prune(
	gh: (args: string[]) => string,
	options: { apply: boolean; defaultBranch: string },
): { planned: number; total: number; bytes: number; failed: number };
export declare function main(
	argv: string[],
	gh?: (args: string[]) => string,
): number;
