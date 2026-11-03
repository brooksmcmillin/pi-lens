// Type declarations for refresh-flips.mjs (untyped .mjs imported from .ts tests).

export const BENIGN_MATRIX_COLUMNS: string[];

export function maskGeneratedDoc(docPath: string, text: string): string;

export function listRefreshFlips(
	headDocs: Record<string, string | null | undefined>,
	newDocs: Record<string, string | null | undefined>,
): string[];

export function buildRefreshPrBody(input: {
	flips: readonly string[];
	landing: "automerge" | "ci-only" | "manual";
	issuesUrl?: string;
	checkFailed?: boolean;
}): string;
