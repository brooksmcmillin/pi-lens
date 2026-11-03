export function blankMarkdown(
	text: string,
	options?: {
		indentedCode?: boolean;
		htmlBlocks?: boolean;
		codeSpans?: boolean;
	},
): string;
export function blankHtmlComments(text: string): string;
export function codeSpanMasked(text: string): string;
export function parseDefectShapes(catalogMarkdown: string): Map<number, string>;
export function issueNumbers(text: string): Set<number>;
export declare const HEADING: RegExp;
export function sourceWithoutFencedBlocks(
	source: string,
	options?: { indentedCode?: boolean },
): string;
