// The `docs/defect-shapes.md` "Recurring defect shapes" catalog, parsed once
// (#4439). The PR
// body Detection lint (`Shape:` / `Enforcer:`) and the catalog-to-HISTORY.md
// governance test both read it here, so neither carries a private parser.
import { blankMarkdownRegions } from "./markdown-lexer.mjs";

/** A markdown section heading, levels 2 to 4: `## Title`. */
export const HEADING = /^#{2,4}\s+(.+?)\s*$/;

// Every reading below is the lexer's (`./markdown-lexer.mjs`, #4717): which
// lines are code, which text is a comment, and which backticks open a code
// span. Four review rounds each found one more spelling a hand-written scan of
// these missed, so this module keeps no scan of its own. Every function keeps
// each line's length, so line numbers and offsets still match the source.

/**
 * Blank fenced and indented code blocks, so a quoted example cannot satisfy a
 * body section (#4288 R3) or a catalog or history scan (#4439). With
 * `indentedCode: false` an indented block stays: a 4-space continuation of a
 * list item is content either way, because the lexer reads it as one.
 */
export function sourceWithoutFencedBlocks(source, options = {}) {
	return blankMarkdownRegions(source, {
		code: options.indentedCode === false ? "fenced" : "blocks",
	});
}

/** Blank inline code spans: what the reader sees as code, not prose. */
export function codeSpanMasked(text) {
	return blankMarkdownRegions(text, { codeSpans: true });
}

/**
 * Blank HTML comments: the comments inside a raw-HTML block (one that a line
 * opening `<!--` starts runs to the line holding `-->` or the end of its
 * container; the block's text after a comment's end stays, as GitHub shows it,
 * #4565) and an inline comment the lexer closes inside its paragraph. Every
 * other `<!--` is literal text the reader sees (#4717 V1, V4, V5).
 */
export function blankHtmlComments(text) {
	return blankMarkdownRegions(text, { html: "comments" });
}

/**
 * Blank code blocks and HTML comments in one lexer pass, so a reference or
 * heading quoted in an example or a comment never counts as real content.
 * `htmlBlocks: true` blanks every raw-HTML block, not only comments: GitHub
 * renders no heading inside one, so section text drops it (fail closed).
 * `codeSpans: true` blanks inline code too.
 */
export function blankMarkdown(text, options = {}) {
	return blankMarkdownRegions(text, {
		code: options.indentedCode === false ? "fenced" : "blocks",
		html: options.htmlBlocks ? "blocks" : "comments",
		codeSpans: Boolean(options.codeSpans),
	});
}

const CATALOG_HEADING = /^## Recurring defect shapes[ \t]*$/m;

/**
 * Map of shape number to the entry's text (the numbered line and its indented
 * continuation, comment-blanked). An entry ends at the first later line that is
 * not blank and not indented: the next shape, a `###` heading or a block tag.
 * Empty when the catalog heading is absent.
 */
export function parseDefectShapes(catalogMarkdown) {
	const blanked = blankMarkdown(catalogMarkdown);
	const start = blanked.search(CATALOG_HEADING);
	if (start < 0) return new Map();
	const rest = blanked.slice(start + 1);
	const end = rest.search(/^## /m);
	const lines = (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/);
	const shapes = new Map();
	let current = null;
	for (const line of lines) {
		const head = /^(\d+)\. \*\*/.exec(line);
		if (head) {
			current = { number: Number(head[1]), lines: [line] };
			shapes.set(current.number, current);
		} else if (current && (line.trim() === "" || /^\s/.test(line)))
			current.lines.push(line);
		else current = null;
	}
	return new Map(
		[...shapes].map(([number, entry]) => [number, entry.lines.join("\n")]),
	);
}

/** Issue and PR numbers in `text`: `#N` and `/issues|pull/N` URLs. */
export function issueNumbers(text) {
	return new Set(
		[...String(text ?? "").matchAll(/#(\d+)|\/(?:issues|pull)\/(\d+)/g)].map(
			(match) => Number(match[1] ?? match[2]),
		),
	);
}
