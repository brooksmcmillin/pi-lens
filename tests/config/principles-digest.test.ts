/**
 * The AGENTS.md principles digest points at the vendored file by anchor
 * (#4565).
 *
 * Recurrence: Greptile's custom context carried a pasted copy of the
 * engineering principles (`custom-context?memory=instruction-0`), so its
 * review threads cited rules the repo file had already reworded. Two copies
 * drift, and nothing read the pasted one. The digest names each principle in
 * one line and links the vendored file's own heading, so a renamed heading
 * reds here instead of leaving every link dead.
 *
 * The scan reads comment-blanked markdown. Digest entries and their links are
 * read with inline code blanked as well: a link quoted in an HTML comment, a
 * fence or an inline code span is an example, not a digest entry. Heading text
 * keeps its inline code, because GitHub slugs that content into the anchor, so
 * a heading's code span is a live title rather than an example. `stripSource`
 * does not apply to markdown (no string literals), so the comment half of the
 * detector rule is `blankMarkdown`.
 *
 * The digest's structure comes from the block's shape, not from one bullet
 * spelling (#4571 F-1): a list item at any indentation, written with `-`, `*`,
 * `+`, `1.` or `1)`, is an entry, and a non-blank line that is neither an item,
 * a continuation of one, nor one of the block's two framing sentences is an
 * offender, so a principle cannot hide as a plain paragraph.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { blankMarkdown } from "../../scripts/lib/defect-shapes.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const AGENTS_PATH = process.env.PI_LENS_AGENTS_PATH
	? path.resolve(process.env.PI_LENS_AGENTS_PATH)
	: path.join(REPO_ROOT, "AGENTS.md");
const PRINCIPLES_PATH = process.env.PI_LENS_PRINCIPLES_PATH
	? path.resolve(process.env.PI_LENS_PRINCIPLES_PATH)
	: path.join(REPO_ROOT, "docs/engineering-principles.md");

/** The sentence that opens the digest in AGENTS.md "How to use this file". */
const DIGEST_INTRO = "The principles, one line each";

/** The statement that makes the vendored copy authoritative. */
const VENDORED_WINS = "vendored file wins on any difference";

/**
 * The digest's two framing sentences, matched whole and never as a phrase
 * (#4571 round 4, PRRT_kwDORt8rec6tfuKa). Phrase containment classified any
 * line carrying one of the phrases as framing, so a list item that merely
 * quoted a phrase was exempt from the entry rule and from the structure rule;
 * both rules skip a framing line.
 */
const DIGEST_FRAMES = new Set([
	`${DIGEST_INTRO}, linked to their section of the vendored file.`,
	`The ${VENDORED_WINS} from this digest.`,
]);

/** A digest link to a heading of the vendored principles file. */
const PRINCIPLES_LINK =
	/\[(?<text>[^\]]*)\]\((?<file>docs\/engineering-principles\.md)#(?<anchor>[^)\s]+)\)/g;

/**
 * GitHub's heading anchor: lowercase, punctuation dropped, whitespace runs to
 * one hyphen. Letters and digits keep their Unicode form, as GitHub's slugger
 * does.
 */
export function headingSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s+/g, "-");
}

/**
 * Anchors of every ATX heading in `markdown`, read comment- and fence-blanked
 * but with inline code kept: GitHub slugs a heading's code span into its
 * anchor, so `` `TLA+` and config `` is `tla-and-config`.
 */
export function headingAnchors(markdown: string): Set<string> {
	const blanked = blankMarkdown(markdown);
	return new Set(
		[...blanked.matchAll(/^#{1,6}[ \t]+(?<text>.+?)[ \t]*$/gm)].map((match) =>
			headingSlug(match.groups?.text ?? ""),
		),
	);
}

/** Blank inline code spans, which carry examples rather than live links. */
export function blankInlineCode(markdown: string): string {
	// Line by line, so one unpaired backtick cannot blank the rest of the file.
	return markdown
		.split("\n")
		.map((line) =>
			line.replace(/(`+)(?!`)[^`]*?\1/g, (span) => " ".repeat(span.length)),
		)
		.join("\n");
}

/** The digest block of AGENTS.md, from its intro sentence to the next tag. */
export function digestBlock(agentsMarkdown: string): string {
	// Read blanked from the start: the intro sentence also appears inside the
	// HTML comment of a worked example, and a comment's link is not an entry.
	const blanked = blankInlineCode(blankMarkdown(agentsMarkdown));
	const start = blanked.indexOf(DIGEST_INTRO);
	if (start < 0) return "";
	const rest = blanked.slice(start);
	const end = rest.search(/^</m);
	return end < 0 ? rest : rest.slice(0, end);
}

/**
 * A digest list item (#4571 F-1): any indentation, and any of `-`, `*`, `+`,
 * `1.` or `1)`. Column-0 `- ` alone left every other spelling, and every
 * nested item, invisible to the one-link rule.
 */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** How one line of the digest block participates in its structure. */
type DigestLineKind = "item" | "continuation" | "intro" | "blank" | "stray";

/**
 * Classify every line of `block` once, so the entry rule and the structure
 * rule cannot drift apart (#4571 F-1). The order is the contract: a list item
 * in any spelling or indentation starts an entry and outranks the framing text,
 * a line that equals one of the block's two framing sentences frames it,
 * a blank line separates, an indented line after the first item continues one,
 * and anything else is stray (#4571 round 4).
 */
function classifyDigestLines(
	block: string,
): Array<{ kind: DigestLineKind; line: string }> {
	let seenItem = false;
	return block.split(/\r?\n/).map((line) => {
		let kind: DigestLineKind;
		if (line.trim() === "") kind = "blank";
		else if (LIST_ITEM.test(line)) kind = "item";
		else if (DIGEST_FRAMES.has(line.trim())) kind = "intro";
		else if (seenItem && /^[ \t]/.test(line)) kind = "continuation";
		else kind = "stray";
		if (kind === "item") seenItem = true;
		return { kind, line };
	});
}

/**
 * The digest entries of `block`: every list item, whatever its spelling or
 * indentation, plus its continuation lines. A link on a continuation line
 * belongs to the entry above it.
 */
export function digestEntries(block: string): string[] {
	const entries: string[][] = [];
	for (const { kind, line } of classifyDigestLines(block)) {
		if (kind === "item") entries.push([line]);
		else if (
			entries.length > 0 &&
			(kind === "continuation" || kind === "blank")
		)
			entries[entries.length - 1].push(line);
	}
	return entries.map((lines) => lines.join("\n"));
}

/**
 * Digest lines that carry no digest structure (#4571 F-1): neither a list item,
 * nor a continuation of one, nor one of the block's two framing sentences. A
 * principle hidden as a plain paragraph carries no link, so the per-entry rule
 * cannot see it; the block is checked for stray lines as well.
 */
export function digestStructureOffenders(block: string): string[] {
	return classifyDigestLines(block)
		.filter(({ kind }) => kind === "stray")
		.map(
			({ line }) =>
				`${line.trim()} -> neither a list item, a continuation, nor an intro sentence`,
		);
}

/** Every principle link in `block`: its label and the anchor it targets. */
export function principlesLinks(
	block: string,
): Array<{ text: string; anchor: string }> {
	return [...block.matchAll(PRINCIPLES_LINK)].map((match) => ({
		text: match.groups?.text ?? "",
		anchor: match.groups?.anchor ?? "",
	}));
}

/**
 * Digest entries that do not carry exactly one principles link (#4565 R2).
 * Moving one entry's link onto another keeps the block's totals, so the rule
 * is per entry, never "as many links as bullets".
 */
export function digestLinkOffenders(block: string): string[] {
	return digestEntries(block)
		.map((entry) => ({ entry, links: principlesLinks(entry) }))
		.filter(({ links }) => links.length !== 1)
		.map(
			({ entry, links }) =>
				`${entry.split("\n")[0].trim()} -> ${links.length} principles link(s)`,
		);
}

const agents = fs.readFileSync(AGENTS_PATH, "utf8");
const principles = fs.readFileSync(PRINCIPLES_PATH, "utf8");

describe("AGENTS.md principles digest (#4565)", () => {
	it("links every digest line to a heading the vendored file has", () => {
		const block = digestBlock(agents);
		expect(block, `no digest block: ${DIGEST_INTRO}`).not.toBe("");
		const anchors = headingAnchors(principles);
		expect(anchors.size).toBeGreaterThan(0);
		const links = principlesLinks(block);
		// Two-way: a link whose heading vanished, and a heading with no link, both
		// read as drift between the digest and the vendored file.
		const missing = links
			.filter((link) => !anchors.has(link.anchor))
			.map((link) => `${link.text} -> #${link.anchor}`);
		expect(
			missing,
			`digest links no heading of docs/engineering-principles.md: ${missing.join(", ")}; anchors there: ${[...anchors].join(", ")}`,
		).toEqual([]);
		expect(links.length).toBeGreaterThanOrEqual(12);
	});

	it("gives every digest entry exactly one principles link", () => {
		const block = digestBlock(agents);
		const entries = digestEntries(block);
		expect(entries.length).toBeGreaterThanOrEqual(12);
		const offenders = digestLinkOffenders(block);
		expect(
			offenders,
			`digest entries without exactly one principles link: ${offenders.join("; ")}`,
		).toEqual([]);
	});

	it("reads the one-link rule per entry, not per block", () => {
		// Recurrence: comparing total bullets with total links let one entry's
		// link move onto another, so an unlinked principle still passed
		// (PRRT_kwDORt8rec6tfaHk).
		const mixed = [
			"The principles, one line each.",
			"- Unlinked entry: no principles link here.",
			"- Double-linked entry ([§1](docs/engineering-principles.md#1-building))",
			"  ([§2](docs/engineering-principles.md#2-testing)).",
			"- Single-linked entry",
			"  ([§1](docs/engineering-principles.md#1-building)).",
			"",
		].join("\n");
		const block = digestBlock(mixed);
		const entries = digestEntries(block);
		expect(entries).toHaveLength(3);
		// The count comparison this guard replaced cannot see the defect.
		expect(principlesLinks(block)).toHaveLength(entries.length);
		expect(digestLinkOffenders(block)).toEqual([
			"- Unlinked entry: no principles link here. -> 0 principles link(s)",
			"- Double-linked entry ([§1](docs/engineering-principles.md#1-building)) -> 2 principles link(s)",
		]);
	});

	it("states that the vendored file wins on any difference", () => {
		expect(digestBlock(agents)).toContain(VENDORED_WINS);
	});

	it.each([
		["a star bullet", "* Starred entry: no principles link."],
		["a plus bullet", "+ Plussed entry: no principles link."],
		["an ordered marker", "1. Numbered entry: no principles link."],
		["a parenthesized marker", "1) Numbered entry: no principles link."],
		["an indented bullet", "  - Indented entry: no principles link."],
	])("counts a list item written as %s as an entry", (_name, spelling) => {
		// Recurrence: F-1 on #4571. `digestEntries` read only column-0 `- `
		// bullets, so an unlinked principle written any other way was
		// invisible to the one-link rule; the guard it replaced counted
		// /^- /gm too.
		const fixture = [
			`${DIGEST_INTRO}, linked.`,
			`The ${VENDORED_WINS} from this digest.`,
			"",
			"- Linked entry ([§1](docs/engineering-principles.md#1-building)).",
			spelling,
			"",
		].join("\n");
		const block = digestBlock(fixture);
		const offenders = digestLinkOffenders(block);
		expect(
			offenders,
			`digest entries without exactly one principles link: ${offenders.join("; ")}`,
		).toEqual([`${spelling.trim()} -> 0 principles link(s)`]);
	});

	it("ignores a link quoted in a comment or an inline code span", () => {
		// Recurrence: the self-excuse direction. A pasted example must never
		// satisfy the digest.
		const quoted = [
			"<!--",
			`${DIGEST_INTRO}, quoted.`,
			"- Link ([§1](docs/engineering-principles.md#gone))",
			"-->",
			`${DIGEST_INTRO}, linked.`,
			"- Link ([§1](docs/engineering-principles.md#1-building))",
			"- Quoted `[§2](docs/engineering-principles.md#gone)`",
			"",
		].join("\n");
		const block = digestBlock(quoted);
		expect(principlesLinks(block)).toEqual([
			{ text: "§1", anchor: "1-building" },
		]);
		// The quoting item is still an entry, and its blanked link does not count.
		expect(digestLinkOffenders(block)).toEqual([
			"- Quoted -> 0 principles link(s)",
		]);
	});

	it("refuses a digest line that is neither an item, a continuation nor the intro", () => {
		// Recurrence: F-1 on #4571. A principle written as a plain paragraph
		// carries no link, so the per-entry rule reads it as nothing at all and
		// the guard it replaced never looked at those lines either.
		expect(digestStructureOffenders(digestBlock(agents))).toEqual([]);
		const hidden = [
			`${DIGEST_INTRO}, linked to their section of the vendored file.`,
			`The ${VENDORED_WINS} from this digest.`,
			"",
			"- Linked entry ([§1](docs/engineering-principles.md#1-building)).",
			"",
			"A principle that hides as a plain paragraph.",
			"",
		].join("\n");
		const block = digestBlock(hidden);
		// Clean by the link rule, blocked only by this one.
		expect(digestLinkOffenders(block)).toEqual([]);
		expect(digestStructureOffenders(block)).toEqual([
			"A principle that hides as a plain paragraph. -> neither a list item, a continuation, nor an intro sentence",
		]);
	});

	it.each([
		[
			"the vendored-wins phrase",
			"- Ensure the vendored file wins on any difference.",
		],
		["the intro phrase", "- The principles, one line each, are linked below."],
	])("reads a list item carrying %s as an entry", (_name, item) => {
		// Recurrence: PRRT_kwDORt8rec6tfuKa. The classifier tested the two
		// framing phrases before the list marker, so a bullet added after the
		// twelve entries read as `intro`. Both rules skip `intro`, so an
		// unlinked principle passed the link rule and the structure rule, and
		// the 12-entry floors still held because it was never counted.
		const block = digestBlock(
			[
				`${DIGEST_INTRO}, linked to their section of the vendored file.`,
				`The ${VENDORED_WINS} from this digest.`,
				"",
				"- Linked entry ([§1](docs/engineering-principles.md#1-building)).",
				item,
				"",
			].join("\n"),
		);
		// The marker outranks the phrase: an entry, not framing text.
		expect(digestStructureOffenders(block)).toEqual([]);
		expect(digestLinkOffenders(block)).toEqual([
			`${item} -> 0 principles link(s)`,
		]);
	});

	it("matches the two framing sentences whole, never by phrase", () => {
		// Recurrence: PRRT_kwDORt8rec6tfuKa in the other direction. Containment
		// exempted any line carrying the phrase, so a reworded or padded framing
		// line stayed invisible instead of reading as drift.
		const reworded =
			"The vendored file wins on any difference from this digest, mostly.";
		const block = digestBlock(
			[
				`${DIGEST_INTRO}, linked to their section of the vendored file.`,
				`The ${VENDORED_WINS} from this digest.`,
				"",
				"- Linked entry ([§1](docs/engineering-principles.md#1-building)).",
				"",
				reworded,
				"",
			].join("\n"),
		);
		expect(digestLinkOffenders(block)).toEqual([]);
		expect(digestStructureOffenders(block)).toEqual([
			`${reworded} -> neither a list item, a continuation, nor an intro sentence`,
		]);
	});

	it("refuses a heading inside the digest block", () => {
		// Table row: a heading is neither an item, a continuation nor a framing
		// sentence, so a principle promoted to a heading reds rather than
		// escaping both rules.
		const block = digestBlock(
			[
				`${DIGEST_INTRO}, linked to their section of the vendored file.`,
				`The ${VENDORED_WINS} from this digest.`,
				"",
				"- Linked entry ([§1](docs/engineering-principles.md#1-building)).",
				"",
				"### 2. Testing",
				"",
			].join("\n"),
		);
		expect(digestLinkOffenders(block)).toEqual([]);
		expect(digestStructureOffenders(block)).toEqual([
			"### 2. Testing -> neither a list item, a continuation, nor an intro sentence",
		]);
	});
});

describe("headingSlug (#4565)", () => {
	it.each([
		["1. Building", "1-building"],
		["3. Reviewing and delegating", "3-reviewing-and-delegating"],
		["4. Honesty and records", "4-honesty-and-records"],
		[
			"Design shared state once, at design time",
			"design-shared-state-once-at-design-time",
		],
		["`TLA+` and config", "tla-and-config"],
		["Fixture adopts an ancestor root", "fixture-adopts-an-ancestor-root"],
	])("slugs %s as %s", (heading, slug) => {
		expect(headingSlug(heading)).toBe(slug);
	});

	it("slugs a heading's inline code through the real scan", () => {
		// Recurrence: blanking inline code before slugging turned
		// `## `TLA+` and config` into `and-config`, so a heading whose live
		// anchor GitHub publishes read dead here (PRRT_kwDORt8rec6tfaHl).
		const anchors = headingAnchors("## What it is\n\n## `TLA+` and config\n");
		expect(anchors.has("tla-and-config")).toBe(true);
		expect(anchors.has("and-config")).toBe(false);
	});

	it("reads anchors from the vendored file's real headings", () => {
		// Derived independently of the scan: the four sections the digest cites.
		const anchors = headingAnchors(principles);
		expect(anchors.has("1-building")).toBe(true);
		expect(anchors.has("2-testing")).toBe(true);
		expect(anchors.has("4-honesty-and-records")).toBe(true);
		expect(anchors.has("no-such-heading")).toBe(false);
	});
});
