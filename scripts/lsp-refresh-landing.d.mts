// Type declarations for lsp-refresh-landing.mjs (untyped .mjs imported from .ts tests).

export function landRefresh(input: {
	root: string;
	landing: "automerge" | "ci-only" | "manual";
	issuesUrl?: string;
	git?: (args: string[], options: { cwd: string }) => string;
}): { flipFree: boolean; flips: string[]; checkFailed: boolean; body: string };
