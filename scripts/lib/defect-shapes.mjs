// The AGENTS.md "Recurring defect shapes" catalog, parsed once (#4439). The PR
// body Detection lint (`Shape:` / `Enforcer:`) and the catalog-to-HISTORY.md
// governance test both read it here, so neither carries a private parser.

/** A markdown section heading, levels 2 to 4: `## Title`. */
export const HEADING = /^#{2,4}\s+(.+?)\s*$/;

// Fenced (``` / ~~~) and 4-space indented code blocks are blanked line by line,
// so a quoted example cannot satisfy a body section (#4288 R3) or a catalog or
// history scan (#4439). A removed line keeps its length, so line numbers and
// offsets (LF text) still match the raw source. An indented block cannot
// interrupt a paragraph (CommonMark), so a 4-space line that follows body text
// stays: list continuations and nested bullets are content, not code. The
// closing fence must repeat the opener's character (>=3 of them).
export function sourceWithoutFencedBlocks(source, options = {}) {
	const indentedCode = options.indentedCode !== false;
	const lines = String(source ?? "").split(/\r?\n/);
	const output = [];
	let fenceChar = null;
	let fenceLength = 0;
	let inIndented = false;
	// "start" | "blank" | "heading" | "text": whether the previous emitted
	// line can precede an indented code block.
	let previous = "start";
	for (const line of lines) {
		if (fenceChar) {
			const close = new RegExp(`^\\s*\\${fenceChar}{${fenceLength},}\\s*$`);
			if (close.test(line)) {
				fenceChar = null;
				fenceLength = 0;
			}
			output.push(" ".repeat(line.length));
			continue;
		}
		const open = /^\s*(`{3,}|~{3,})/.exec(line);
		if (open) {
			fenceChar = open[1][0];
			fenceLength = open[1].length;
			inIndented = false;
			output.push(" ".repeat(line.length));
			previous = "blank";
			continue;
		}
		if (indentedCode && /^(?: {4,}|\t)/.test(line)) {
			if (
				inIndented ||
				previous === "start" ||
				previous === "blank" ||
				previous === "heading"
			) {
				inIndented = true;
				output.push(" ".repeat(line.length));
				continue;
			}
		} else {
			inIndented = false;
		}
		output.push(line);
		const trimmed = line.trim();
		if (trimmed === "") previous = "blank";
		else if (HEADING.test(line)) previous = "heading";
		else previous = "text";
	}
	return output.join("\n");
}

// The HTML spec's four comment ends, all of which GitHub renders
// (13.2.5.43-46): `-->` closes a comment (comment end state), `--!>` closes it
// too (comment end bang state), and `<!-->` and `<!--->` are complete empty
// comments closed abruptly (comment start, and comment start dash, states).
// Only a comment with none of them runs to the end of the text. Recurrence:
// this rule knew `-->` alone, so a body writing `<!-- note --!>` or `<!-->`
// blanked every line after it even though the reader sees that text, and a
// gating rule then read a visible answer as absent (CodeQL js/bad-tag-filter
// alert #70 flagged this class on a test fixture).
const COMMENT_END = /--!?>/;

/**
 * Index just past the end of the HTML comment whose `<!--` ends at `from`, or
 * -1 when it does not close in `text`. The two abrupt ends close inside the
 * opener, in the `>` or `->` the start already left behind, so they answer
 * only at the opener itself: a continuation line mid-comment starts in comment
 * state, where `->` is body data (13.2.5.43: `-` to comment end dash, `>`
 * appends `-` and reconsumes in comment state) and only `--!?>` closes it. The
 * one spelling of the comment-end rule: a consumer with its own copy is how a
 * renderer's spelling goes missing.
 */
export function htmlCommentEnd(text, from) {
	const source = String(text ?? "");
	const rest = source.slice(from);
	const atOpener = source.slice(Math.max(0, from - 4), from) === "<!--";
	if (atOpener && rest.startsWith(">")) return from + 1;
	if (atOpener && rest.startsWith("->")) return from + 2;
	const end = COMMENT_END.exec(rest);
	return end === null ? -1 : from + end.index + end[0].length;
}

/**
 * Blank HTML comments, keeping every line's length so line numbers and offsets
 * still match the raw source (LF text). A consumer that masks one line at a
 * time asks `htmlCommentEnd` rather than carrying its own end rule.
 */
export function blankHtmlComments(text) {
	const source = String(text ?? "");
	let output = "";
	let index = 0;
	while (index < source.length) {
		const start = source.indexOf("<!--", index);
		if (start === -1) {
			output += source.slice(index);
			break;
		}
		output += source.slice(index, start);
		const end = htmlCommentEnd(source, start + 4);
		const stop = end === -1 ? source.length : end;
		output += source.slice(start, stop).replace(/[^\n]/g, " ");
		index = stop;
	}
	return output;
}

/**
 * Blank fenced and indented code blocks (see `sourceWithoutFencedBlocks`) and
 * HTML comments (see `blankHtmlComments`), keeping line numbers. An
 * unterminated `<!--` runs to the end of the text, as GitHub renders it. A
 * reference or heading quoted in an example or a comment never counts as real
 * content. Fences go first: a `<!--` inside a fence is literal text.
 */
export function blankMarkdown(text, options = {}) {
	return blankHtmlComments(
		sourceWithoutFencedBlocks(String(text ?? ""), options),
	);
}

const CATALOG_HEADING = /^## Recurring defect shapes[ \t]*$/m;

/**
 * Map of shape number to the entry's text (the numbered line and its indented
 * continuation, comment-blanked). An entry ends at the first later line that is
 * not blank and not indented: the next shape, a `###` heading or a block tag.
 * Empty when the catalog heading is absent.
 */
export function parseDefectShapes(agentsMarkdown) {
	const blanked = blankMarkdown(agentsMarkdown);
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
