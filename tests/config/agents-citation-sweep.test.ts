/**
 * Check C8 of the agent-contract audit (#4361): every `<contract>.md
 * "<section>"` or `<contract>.md, "<section>"` citation in tests/, scripts/,
 * .github/, docs/, clients/, .changelog/ and the repo-root config files must
 * name a live heading in the file it names. The contract documents are
 * `AGENTS.md`, `docs/defect-shapes.md`, `docs/pi-lens-orchestration.md`,
 * `docs/pi-lens-release.md` and every `docs/invariants/*.md`. Before #4361 the
 * sweep read AGENTS.md alone, which is what it checked while AGENTS.md held the
 * moved text; the split repointed 15 citations at the new files and none of
 * them was checked (review 4883 F3). The repo-root files read are dotfiles and
 * config-extension files (.toml, .json, .yml, .yaml, .cjs, .mjs); root markdown
 * (AGENTS, HISTORY, CHANGELOG, README) is not read. Compiled `.js` and `.d.ts`
 * next to a `.ts` source are skipped, since `npm run build` writes them in
 * place.
 *
 * Recurrence this prevents: PLAN_4361 (2026-10-18) measured five headings that
 * the agent docs still cited after AGENTS.md had moved them: "Probe hygiene",
 * "Detectors match code, not prose", "Runner process model", "Session-start
 * critical path" and "Test assessment and removal". Twelve call sites pointed
 * at them. A reader that follows a dangling pointer lands on no rule, so the
 * pointer silently stops enforcing anything.
 *
 * Per-needle policy: the citation is prose or a string literal, not code, so
 * the scan reads the raw text. It does not blank comments or strings, because
 * the comment or string IS the citation. A quoted section that wraps onto the
 * next comment line still counts, since the scan joins up to two continuation
 * lines before it matches; in markdown the continuation is the next prose
 * line. Two exclusions are deliberate: tests/fixtures/ holds
 * recorded probe and CI captures that must stay byte-true, and this file quotes
 * the citation form in its own header. A string-literal line in code never
 * joins onto the next line, so `" + "` concatenation is not read as a name.
 * An unquoted mention such as
 * `AGENTS.md Probe hygiene` is outside the form and is not swept. The path may
 * be backticked, as the reviewer table spells it
 * (`` `docs/invariants/paths-os.md` "Paths, data, and operating systems" ``).
 *
 * Two known misses, declared rather than fixed. A citation that names a shape
 * by its number (`docs/defect-shapes.md "shape 3"`) or by the shape's own
 * name (`docs/defect-shapes.md "Wrong argv transform"`) is outside the form:
 * the catalog's headings are its ten trigger groups, and a numbered entry is
 * not a heading, so such a citation reds as dangling. Live population 0 on
 * 2026-10-26 (this sweep is green at that head): resolving it needs a second
 * identity form for the catalog, which is a maintainer decision, so it is an
 * accepted residual (p3, review 4883 F11). Second, the form reads a quoted
 * name only; a bare link into a heading anchor is not read at all.
 *
 * Fail closed: a citation whose section is not a heading reds, a citation to a
 * document that is not in the tree reds, and so does an empty sweep (a dead
 * sweep passes everything).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, listSourceFiles } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SELF = path.relative(REPO_ROOT, import.meta.filename);
const SWEEP_ROOTS = [
	"tests",
	"scripts",
	".github",
	"docs",
	"clients",
	".changelog",
];
const ROOT_CONFIG_EXTENSIONS = new Set([
	".toml",
	".json",
	".yml",
	".yaml",
	".cjs",
	".mjs",
]);
const EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".js",
	".mjs",
	".cjs",
	".md",
	".yml",
	".yaml",
	".json",
	".toml",
	".sh",
	".txt",
]);
// A citation to any contract document: group 1 is the document (without `.md`),
// then an optional comma or closing backtick, then the quoted heading. Group 2
// is the quote, group 3 the heading. This alternation is the population: no
// second spelling of it exists elsewhere in the file.
const CITATION =
	/(AGENTS|docs\/(?:invariants\/[a-z0-9-]+|defect-shapes|pi-lens-orchestration|pi-lens-release))\.md[`,]{0,2}[ \t]+(["'])([^\n]+?)\2/g;
const COMMENT_PREFIX = /^[ \t]*(?:\/\/+|\*|#)[ \t]?/;

/** A compiled `.js` or `.d.ts` emitted next to its `.ts` source by the build. */
function isBuildOutput(dir: string, name: string): boolean {
	const source = name.endsWith(".d.ts")
		? name.replace(/\.d\.ts$/, ".ts")
		: name.endsWith(".js")
			? name.replace(/\.js$/, ".ts")
			: undefined;
	return source !== undefined && fs.existsSync(path.join(dir, source));
}

/**
 * Every swept source: the shared walker (`listSourceFiles`, which skips
 * `.git`, `node_modules`, `.claude` and `.probe-home`) over each root, then
 * the citation filters layered on top: fixture captures, build output and
 * this file are out.
 */
function sweptSources(): string[] {
	const files: string[] = [];
	for (const root of SWEEP_ROOTS) {
		const dir = path.join(REPO_ROOT, root);
		if (fs.existsSync(dir)) {
			files.push(
				...listSourceFiles(dir, {
					extensions: [...EXTENSIONS],
					skipDeclarations: false,
				}),
			);
		}
	}
	files.push(...rootConfigFiles());
	return files.filter((file) => {
		const rel = path.relative(REPO_ROOT, file);
		return (
			rel !== SELF &&
			!rel.split(path.sep).includes("fixtures") &&
			!isBuildOutput(path.dirname(file), path.basename(file))
		);
	});
}

/** Repo-root config files: dotfiles and config-extension files, not root markdown. */
function rootConfigFiles(): string[] {
	return fs
		.readdirSync(REPO_ROOT, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				(entry.name.startsWith(".") ||
					ROOT_CONFIG_EXTENSIONS.has(path.extname(entry.name))),
		)
		.map((entry) => path.join(REPO_ROOT, entry.name));
}

/**
 * The live headings of one contract document. A citation to a document that is
 * not in the tree resolves against an empty set, so it reds: a pointer to a
 * file nobody can open is as dead as a pointer to a missing section.
 */
function liveHeadings(target: string): Set<string> {
	const file = path.join(REPO_ROOT, target);
	const headings = new Set<string>();
	if (!fs.existsSync(file)) return headings;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const match = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
		if (match) headings.add(match[1]);
	}
	return headings;
}

/**
 * Every contract document a citation may name: AGENTS.md, the documents #4361
 * moved run text to, and every `docs/invariants/*.md` (read from the directory,
 * so a new seam file is swept without touching this list).
 */
function contractDocuments(): string[] {
	const invariants = fs
		.readdirSync(path.join(REPO_ROOT, "docs/invariants"))
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => `docs/invariants/${name}`);
	return [
		"AGENTS.md",
		"docs/defect-shapes.md",
		"docs/pi-lens-orchestration.md",
		"docs/pi-lens-release.md",
		...invariants,
	];
}

/** The headings of every contract document, keyed by the path a citation uses. */
function headingsByTarget(): Map<string, Set<string>> {
	return new Map(
		contractDocuments().map((target) => [target, liveHeadings(target)]),
	);
}

/**
 * The text a wrapped citation continues onto: the next comment line in code
 * (`// `, ` * `, `# `), or the next prose line in markdown. A string-literal
 * line in code (`"... " +`) is not a continuation, so `" + "` never reads as a
 * section name.
 */
function continuation(next: string, markdown: boolean): string | undefined {
	if (next.trim() === "") return undefined;
	const comment = COMMENT_PREFIX.exec(next);
	if (comment) return next.slice(comment[0].length);
	return markdown ? next.trim() : undefined;
}

/** Every quoted contract section cited from a line, with its document and line. */
function citationsIn(
	file: string,
): { line: number; target: string; name: string }[] {
	const text = fs.readFileSync(file, "utf8");
	const found: { line: number; target: string; name: string }[] = [];
	// A file that names no markdown document at all cannot hold a citation.
	if (!text.includes(".md")) return found;
	const lines = text.split("\n");
	const markdown = file.endsWith(".md");
	lines.forEach((line, index) => {
		if (!line.includes(".md")) return;
		const tail: string[] = [];
		for (const next of lines.slice(index + 1, index + 3)) {
			const text = continuation(next, markdown);
			if (text === undefined) break;
			tail.push(text);
		}
		const joined = [line, ...tail].join(" ");
		for (const match of joined.matchAll(CITATION)) {
			if ((match.index ?? 0) < line.length) {
				found.push({
					line: index + 1,
					target: `${match[1]}.md`,
					name: match[3].replace(/\s+/g, " ").trim(),
				});
			}
		}
	});
	return found;
}

/**
 * The resolver: the citations whose quoted name is not a live heading of the
 * document it names. The real sweep and the planted case both call this, so a
 * change to either the matcher or the resolver is seen by the planted case.
 */
function danglingCitations(
	citations: { file: string; line: number; target: string; name: string }[],
	headings: Map<string, Set<string>>,
): string[] {
	return citations
		.filter((hit) => !headings.get(hit.target)?.has(hit.name))
		.map((hit) => `${hit.file}:${hit.line} ${hit.target} "${hit.name}"`);
}

describe("contract document section citations resolve (#4361 C8)", () => {
	it(
		"every quoted contract section cited under the swept roots is a live heading",
		() => {
			const headings = headingsByTarget();
			const sweptFiles = sweptSources();
			const citations = sweptFiles.flatMap((file) =>
				citationsIn(file).map((hit) => ({
					file: path.relative(REPO_ROOT, file),
					...hit,
				})),
			);

			// A dead sweep passes everything: the headings, the files and the
			// citations must all be read. The citation floor catches a matcher
			// neutered to match nothing, which the other two floors cannot see.
			assertNonEmptyScan("contract document count", headings.size, 9);
			assertNonEmptyScan(
				"contract document headings read",
				[...headings.values()].reduce((sum, set) => sum + set.size, 0),
				20,
			);
			assertNonEmptyScan("citation sweep files", sweptFiles.length, 500);
			assertNonEmptyScan("contract citations read", citations.length, 15);

			expect(
				danglingCitations(citations, headings),
				"dangling contract document citations",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence (CodeRabbit, PR 4767 round 3): C8 derives its population from
	// the tree. A matcher or resolver that silently reports nothing keeps the
	// real sweep green, and the citation-count floor only catches zero matches.
	// This planted file carries a dangling and a live citation in both quote
	// spellings and in both targets: AGENTS.md and the documents #4361 moved
	// text to. The same matcher and resolver must report exactly the dangling
	// four, or the guard is not proven to red on a real miss. The fourth is
	// cross-document (review 4883 F10): `Test requirements` is a heading of
	// AGENTS.md and of no other contract document, so resolving it against any
	// document's headings rather than the one the citation names reds this case.
	it("reports a planted dangling citation through the same matcher and resolver", () => {
		const headings = headingsByTarget();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c8-planted-"));
		try {
			const planted = path.join(dir, "planted.ts");
			fs.writeFileSync(
				planted,
				[
					'// see AGENTS.md "No Such Planted Heading" for the rule',
					"// and AGENTS.md 'Another Missing Heading' too",
					'// live: AGENTS.md "Test requirements" still resolves',
					'// and `docs/invariants/paths-os.md` "Paths, data, and operating systems"',
					'// but docs/invariants/paths-os.md "No Such Planted Heading" does not',
					'// and docs/defect-shapes.md "a runner or tool outcome" is live',
					'// and docs/invariants/paths-os.md "Test requirements" holds only in AGENTS.md',
					"",
				].join("\n"),
			);
			const hits = citationsIn(planted).map((hit) => ({
				file: "planted.ts",
				...hit,
			}));
			expect(hits.map((hit) => `${hit.target} ${hit.name}`)).toEqual([
				"AGENTS.md No Such Planted Heading",
				"AGENTS.md Another Missing Heading",
				"AGENTS.md Test requirements",
				"docs/invariants/paths-os.md Paths, data, and operating systems",
				"docs/invariants/paths-os.md No Such Planted Heading",
				"docs/defect-shapes.md a runner or tool outcome",
				"docs/invariants/paths-os.md Test requirements",
			]);
			expect(danglingCitations(hits, headings)).toEqual([
				'planted.ts:1 AGENTS.md "No Such Planted Heading"',
				'planted.ts:2 AGENTS.md "Another Missing Heading"',
				'planted.ts:5 docs/invariants/paths-os.md "No Such Planted Heading"',
				'planted.ts:7 docs/invariants/paths-os.md "Test requirements"',
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
