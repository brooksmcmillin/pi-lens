import type { EvaluatedRecord } from "./lib/assert-evaluated.mjs";

/** HEAD's text of a doc, null when HEAD has no such file; throws when git cannot read HEAD. */
export function gitHeadText(docPath: string, cwd?: string): string | null;
export function checkRecords(
	dir: string,
	headText?: (docPath: string) => string | null,
): EvaluatedRecord[];
export function checkDocs(
	root?: string,
	headText?: (docPath: string) => string | null,
): EvaluatedRecord[];
/** One record for a count a workflow step derived itself: `<producer>=<n>` against `floor`. */
export function checkCount(spec: string, floor: number): EvaluatedRecord;
/** Exit code: 0 ok, 1 below a floor or HEAD unreadable, 2 usage. */
export function main(
	argv: string[],
	headText?: (docPath: string) => string | null,
	root?: string,
): number;
