/**
 * One census seam for the AST governance sweeps (#4606 S0).
 *
 * Two sweeps read the same files and ask different questions:
 *
 * - (A) `tests/config/bounded-eviction-idiom-sweep.test.ts` — "is this a
 *   hand-rolled eviction program?" (#2442);
 * - (B) `tests/config/bounded-container-guard.test.ts` — "is this long-lived
 *   container bounded, or admitted with a reason?" (#2981).
 *
 * #4606's design makes (A) structural and keeps (B) on construction. Both need
 * the same two primitives, so this module owns them once and each sweep keeps
 * its own root list and its own admission table:
 *
 * 1. **The pre-order walk** ({@link walkAst}) and the one parse that feeds it
 *    ({@link parseNodes}, {@link parseRoot}). #3058 measured what happens when
 *    a predicate takes a source STRING instead: (B) re-parsed and re-walked
 *    each file up to six times per container occurrence — 302 occurrences over
 *    121 files, ~1,800 whole-file passes, 9,207 MB peak RSS against 62 MB of V8
 *    heap. An `@ast-grep/napi` root holds a native tree-sitter arena and every
 *    `children()` call materialises a NAPI handle per node, none of which V8
 *    accounts for. Passing the node array makes the per-call pass structurally
 *    impossible to re-introduce at a call site: a predicate has no source
 *    string to parse and no root to walk.
 * 2. **The census enumeration** ({@link censusSourceFiles}), including the
 *    `.js`-twin rule: `npm run build` emits a compiled `.js` beside every
 *    source `.ts` outside `tests/`, so requesting `.js` would read one file
 *    twice, under two identities and two content keys.
 *
 * A second traversal is behaviourally invisible (two identical recursions
 * visit the same nodes in the same order), so `ast-census.test.ts` classifies
 * every traversal site in this module and in both consumers: exactly one, in
 * {@link walkAst}, and each consumer must resolve THIS module file.
 */

import * as fs from "node:fs";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { listSourceFiles } from "./sweep-kit.js";

/** The parsed root of one TypeScript-grammar source text. */
export function parseRoot(source: string): SgNode {
	return parse(Lang.TypeScript, source).root();
}

/** The one pre-order walk: a node, then every child of it. */
export function walkAst(node: SgNode, visit: (node: SgNode) => void): void {
	visit(node);
	for (const child of node.children()) walkAst(child, visit);
}

/**
 * One parse and ONE pre-order walk per source text, as a document-ordered node
 * array. Every predicate reads this array instead of parsing or walking again.
 */
export function parseNodes(source: string): SgNode[] {
	const nodes: SgNode[] = [];
	walkAst(parseRoot(source), (node) => nodes.push(node));
	return nodes;
}

export interface CensusSourceOptions {
	/** File extensions to collect. Defaults to `[".ts"]`, like the walker. */
	extensions?: readonly string[];
	/** Drop `*.test.*` files. */
	skipTests?: boolean;
}

/**
 * Every census source file under `roots`, in root order, each root's files
 * sorted by `listSourceFiles`.
 *
 * A `.js` file is skipped when `<stem>.ts` is on disk: that is the compiled
 * twin of the same source, not a second source. A hand-written script with no
 * twin (`scripts/*.mjs`, whose `.d.mts` declarations `listSourceFiles` already
 * drops) stays in the census. A root that is not present contributes nothing,
 * so a tree with no `scripts/` directory needs no row.
 */
export function censusSourceFiles(
	roots: readonly string[],
	options: CensusSourceOptions = {},
): string[] {
	const extensions = options.extensions ?? [".ts"];
	const files: string[] = [];
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		const listed = fs.statSync(root).isDirectory()
			? listSourceFiles(root, {
					extensions: [...extensions],
					skipTests: options.skipTests ?? false,
				})
			: [root];
		for (const file of listed) {
			// A compiled `.js` twin is the same source under a second identity:
			// skipping it keeps one occurrence row (and one content key) per
			// source. A hand-written script with no twin stays.
			if (file.endsWith(".js") && fs.existsSync(`${file.slice(0, -3)}.ts`))
				continue;
			files.push(file);
		}
	}
	return files;
}
