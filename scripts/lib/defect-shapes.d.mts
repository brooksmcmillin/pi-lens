export function blankMarkdown(
	text: string,
	options?: { indentedCode?: boolean },
): string;
export function blankHtmlComments(text: string): string;
export function htmlCommentEnd(text: string, from: number): number;
export function parseDefectShapes(agentsMarkdown: string): Map<number, string>;
export function issueNumbers(text: string): Set<number>;
export declare const HEADING: RegExp;
export function sourceWithoutFencedBlocks(
	source: string,
	options?: { indentedCode?: boolean },
): string;
