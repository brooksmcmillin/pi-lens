/**
 * #4606 S1: the structural recognizer that owns the eviction question.
 *
 * ## Why structure, not spellings
 *
 * `tests/config/bounded-eviction-idiom-sweep.test.ts` grew five lexical
 * spellings (#2442, #2460, #4570, #4580) and each round found a neighbouring
 * shape the previous spelling could not see: accessor chains wrapped by the
 * formatter, an alias, an indirect accessor, a binding split across statements,
 * destructured iterator results, an ordering that finishes in a statement of
 * its own. That is AGENTS.md shape 69 by construction: a detector that lists
 * the spellings it knows passes every spelling it does not.
 *
 * This module asks the question semantically instead. An **eviction program**
 * is a statement that passes through four stages, and each stage is a shape in
 * the AST, not a token:
 *
 * | Stage | Structural evidence |
 * | --- | --- |
 * | **bound** | a cap comparison on a collection's size/length (`x.size > CAP`, the `x.size <= CAP` early-return complement, `occupied < getCeiling()`). The threshold must not be the literal `0`: `x.length > 0` is an emptiness check, not a cap. An accessor-chain `for…of` head carries its order stage in the walk itself, so it needs no separate bound. |
 * | **order** | `sort`/`toSorted`, insertion order (`keys()`/`values()`/`entries()`, or a bare `for…of` walk), or an explicit min/max scan over the container |
 * | **selection** | `[i]`, `.at()`, `.find()`, `.shift()`, `.pop()`, a destructured element (including an array-destructured iterator head, `const [oldest] = m.keys()`), an iterator's `.next()` head, a `for…of` head that breaks after its first victim, or a count-bounded `slice`/`length = cap` truncation |
 * | **effect** | a container removal (`.delete`/`.splice`/`.shift`/`.pop`), a filesystem removal (`rmSync`/`unlinkSync`/`rm`), a durable write of the survivors, or an in-place `length = cap` |
 *
 * The four admitted forms — `iterator-head`, `ordered-victim`, `ordered-scan`,
 * `count-truncation` — are exactly the table below, each with the live member
 * that needs it and an executable plant. The same table stands in
 * `STATE_TABLE.md`, the worktree record written before the first edit, as in
 * this repo's other state tables. Everything outside that table refuses:
 * there is no fallback arm and no "unknown shape" credit, so a new member the
 * table cannot describe is a miss this sweep must not silently absorb (#4606's
 * design, maintainer decision 2026-10-18, hybrid H1). The same table ships in
 * the sweep's `REFUSED_PROGRAMS` docblock for the refused side, and every
 * r1 narrowing the #4606 r2 review found is closed here:
 *
 * | Form | Bound | Order | Selection | Effect |
 * | --- | --- | --- | --- | --- |
 * | `iterator-head` | the enclosing loop's own ceiling comparison, or none for an accessor-chain walk | `keys()`/`values()`/`entries()` (chained, aliased, indirect, wrapped, optional), or a bare container walk | `.next()` head, an array-destructured head, or a `for…of` head that `break`s | removal of the victim or of a name derived from it |
 * | `ordered-victim` | a governing cap comparison | `sort`/`toSorted` over a spread, `Array.from`, a transform chain, an alias, or an in-place statement | `[i]`, `.at`, `.find`, `.shift`, `.pop`, destructuring, or a `for…of` over the ranking, each followed through aliases | removal, a hand-off to a retirement helper, or every victim removed |
 * | `ordered-scan` | a cap comparison in the loop or function | `for…of` over a container (bare, accessor, destructured) | a victim cursor assigned in the body, distinct from the loop variable | removal of that cursor |
 * | `count-truncation` | a guard cap, or a literal/derived count | `sort`/`toSorted`, or the truncation alone | `slice(0, N)`, `slice(-N)`, `x.length = N` | survivors persisted, rebuilt, iterated-and-removed, or a capped view |
 *
 * ## The parse, and why this asks the engine instead of walking
 *
 * The parse is the S0 census seam's (`parseRoot` in `./ast-census.ts`, one
 * parse per source text, `censusSourceFiles` for the file population). The
 * candidate nodes come from ONE native `findAll` over that same parsed root:
 * `parseNodes` (S0's document-ordered node array) materializes 2,451,462 NAPI
 * handles for this census and costs 11.0 s, while `parseRoot` plus one
 * eight-kind query returns the 157,601 candidate nodes in 2.3 s. Measured on
 * this tree, 2026-10-18, 789 census files. A second *traversal* is therefore
 * not a second *parse*, and the census guard's accessor census
 * (`tests/support/ast-census.test.ts`) keeps its one-walk rule over both.
 *
 * Line anchoring is uniform: an occurrence is reported at the first line of the
 * STATEMENT that introduces the ordered sequence (the `const victim = …`
 * declaration, the `for…of`, the truncation). That is what the sweep keys its
 * registry on, and it is what a human reads. A reference to a victim is read
 * from the AST's identifiers, never from a node's raw text, so a string or a
 * comment that spells a victim is not a reference to it (AGENTS.md shape 43).
 */

import type { SgNode } from "@ast-grep/napi";
import { parseRoot } from "./ast-census.js";

/** The rows of `STATE_TABLE.md`, in the order the sweep prints them. */
export const EVICTION_FORMS = [
	"iterator-head",
	"ordered-victim",
	"ordered-scan",
	"count-truncation",
] as const;

export type EvictionForm = (typeof EVICTION_FORMS)[number];

export interface EvictionProgram {
	/** Which admitted form recognised it. */
	readonly form: EvictionForm;
	/** 1-based line of the statement that introduces the ordered sequence. */
	readonly line: number;
}

/**
 * Candidate kinds, one native query. Kinds are the AST's own vocabulary, so a
 * form can never hide behind a syntactic spelling: every call, declarator,
 * loop, comparison, assignment and subscript in the file is offered to the
 * recognizer, which then decides by structure.
 */
const CANDIDATE_KINDS = [
	"call_expression",
	"variable_declarator",
	"for_in_statement",
	"assignment_expression",
	"binary_expression",
	"subscript_expression",
] as const;

/** Calls whose effect is "this entry leaves the container". */
const REMOVAL_METHODS = new Set(["delete", "splice", "shift", "pop"]);

/** Calls whose effect is "this entry leaves the disk". */
const REMOVAL_CALLEES = new Set(["rmSync", "unlinkSync", "rmdirSync", "rm"]);

/** Calls that persist survivors — the retention half of a truncation. */
const WRITE_CALLEES = new Set([
	"writeFileSync",
	"writeFile",
	"writeFileAtomic",
	"appendFileSync",
	"writeJsonSync",
	"writeJson",
]);

/**
 * Calls (and constructors) that retain a truncated value as a collection. A
 * retained COLLECTION is what separates a capped retention from a display
 * truncation of a string, which no admitted form covers.
 */
const REBUILD_CALLEES = new Set(["fromEntries", "fromKeys"]);
const REBUILD_CONSTRUCTORS = new Set(["Set", "Map", "Array"]);

/** Element selectors over an ordered sequence. */
const ELEMENT_METHODS = new Set(["at", "find"]);

/** Selectors that CONSUME an end of the ordered sequence in place. */
const END_SELECTORS = new Set(["shift", "pop"]);

/** `sort` family: the order stage. */
const ORDER_METHODS = new Set(["sort", "toSorted"]);

/** Cap comparisons, as the AST spells them. */
const CAP_OPERATORS = new Set([">", ">=", "<", "<="]);

const FUNCTION_KINDS: ReadonlySet<string | number> = new Set([
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"arrow_function",
	"method_definition",
	"program",
]);

/**
 * The block boundary a statement starts from. A node's anchor is the outermost
 * ancestor whose parent is one of these, which is the statement a human reads.
 */
const STATEMENT_PARENTS: ReadonlySet<string | number> = new Set([
	"statement_block",
	"program",
	"class_body",
	"if_statement",
	"while_statement",
	"for_statement",
	"for_in_statement",
	"else_clause",
	"switch_case",
	"try_statement",
	"catch_clause",
	"finally_clause",
	"labeled_statement",
]);

const IDENTIFIER = /[\w$]+/g;

/** The member names that read a collection's own count. */
const LENGTH_PROPERTIES = new Set(["size", "length"]);

/** Calls that hand back a collection's size or its entries. */
const SIZE_SOURCE_CALLS = new Set(["keys", "values", "entries"]);

/** `Math.min`/`Math.max`: a reduction over a key set. */
const MATH_EXTREMUM_CALLS = new Set(["min", "max"]);

/** Every whole identifier in `text`, deduplicated. */
function identifiers(text: string): string[] {
	return [...new Set(text.match(IDENTIFIER) ?? [])];
}

function nodeText(node: SgNode | null | undefined): string {
	return node === null || node === undefined ? "" : node.text();
}

function contains(outer: SgNode, inner: SgNode): boolean {
	const a = outer.range();
	const b = inner.range();
	return a.start.index <= b.start.index && b.end.index <= a.end.index;
}

function lineOf(node: SgNode): number {
	return node.range().start.line + 1;
}

/** The statement a node belongs to: outermost ancestor before a block edge. */
function statementOf(node: SgNode): SgNode {
	let current = node;
	for (let depth = 0; depth < 64; depth++) {
		const parent = current.parent();
		if (parent === null || STATEMENT_PARENTS.has(parent.kind())) return current;
		current = parent;
	}
	return current;
}

/** The enclosing function-like scope, else the program root. */
function enclosingFunction(node: SgNode): SgNode {
	let current = node.parent();
	while (current !== null) {
		if (FUNCTION_KINDS.has(current.kind())) return current;
		current = current.parent();
	}
	return node;
}

/**
 * The member name a call invokes: `<recv>.name(...)` or `<recv>["name"](...)`.
 * `undefined` for a bare or computed callee, which no admitted form relies on.
 */
function calleeName(call: SgNode): string | undefined {
	if (call.kind() !== "call_expression") return undefined;
	const callee = call.field("function");
	if (callee === null || callee === undefined) return undefined;
	if (callee.kind() === "member_expression")
		return callee.field("property")?.text();
	if (callee.kind() === "subscript_expression") {
		const index = callee.field("index");
		if (index === null || index === undefined) return undefined;
		const text = index.text();
		if (/^["'`]/.test(text)) return text.slice(1, -1);
	}
	return undefined;
}

/** The callee's own name for a bare call (`writeFileAtomic(...)`), else the member name. */
function invokedName(call: SgNode): string | undefined {
	const member = calleeName(call);
	if (member !== undefined) return member;
	const callee = call.field("function");
	if (callee === null || callee === undefined) return undefined;
	return callee.kind() === "identifier" ? callee.text() : undefined;
}

/**
 * The leftmost plain identifier of a receiver chain (`maps.byCall` → `maps`,
 * `[...keys]` → `undefined`). Used to resolve which declared collection a stage
 * talks about; an expression that is not a name chain contributes nothing.
 */
function rootName(node: SgNode | null | undefined): string | undefined {
	let current = node;
	for (let depth = 0; depth < 32; depth++) {
		if (current === null || current === undefined) return undefined;
		const kind = current.kind();
		if (kind === "identifier") return current.text();
		if (kind === "parenthesized_expression" || kind === "non_null_expression") {
			current = current.field("expression") ?? current.field("value");
			continue;
		}
		if (kind === "member_expression" || kind === "subscript_expression") {
			current = current.field("object");
			continue;
		}
		if (kind === "call_expression") {
			current = current.field("function");
			continue;
		}
		return undefined;
	}
	return undefined;
}

interface FileFacts {
	readonly calls: SgNode[];
	readonly declarators: SgNode[];
	readonly forOfs: SgNode[];
	readonly assignments: SgNode[];
	readonly subscripts: SgNode[];
	readonly capComparisons: SgNode[];
	/** Ceiling comparisons of any counter: the bound of an iterator-head loop. */
	readonly ceilingComparisons: SgNode[];
	/** Declarator name to the initializer node it was bound from. */
	readonly initializers: Map<string, SgNode>;
	/** Names declared with a numeric literal value (`const MAX = 16;`). */
	readonly numericConstants: Set<string>;
	/** Memo for {@link isSizeDerived}, per name. */
	readonly sizeDerivedMemo: Map<string, boolean>;
}

/** A call inside `node` (itself included) whose own name is one of `names`. */
function callsAny(
	node: SgNode,
	names: ReadonlySet<string>,
	filter?: (call: SgNode) => boolean,
): boolean {
	const test = (call: SgNode): boolean =>
		names.has(invokedName(call) ?? "") && (filter?.(call) ?? true);
	if (node.kind() === "call_expression" && test(node)) return true;
	return node
		.findAll({ rule: { kind: "call_expression" } })
		.some((call) => test(call));
}

/** True when an initializer reads a collection size or an iteration result. */
function readsSize(node: SgNode): boolean {
	const readsLength = (member: SgNode): boolean =>
		LENGTH_PROPERTIES.has(member.field("property")?.text() ?? "");
	if (node.kind() === "member_expression" && readsLength(node)) return true;
	if (
		node
			.findAll({ rule: { kind: "member_expression" } })
			.some((member) => readsLength(member))
	)
		return true;
	if (callsAny(node, SIZE_SOURCE_CALLS)) return true;
	return callsAny(node, MATH_EXTREMUM_CALLS, (call) => {
		const callee = call.field("function");
		return callee !== null && callee.field("object")?.text() === "Math";
	});
}

/** True when an initializer derives from an ordering call. */
function readsOrdering(node: SgNode): boolean {
	return callsAny(node, ORDER_METHODS);
}

/** A collection whose size the program reads, resolved through its binding. */
function isSizeDerived(name: string, facts: FileFacts): boolean {
	const cached = facts.sizeDerivedMemo.get(name);
	if (cached !== undefined) return cached;
	const initializer = facts.initializers.get(name);
	const derived = initializer !== undefined && readsSize(initializer);
	facts.sizeDerivedMemo.set(name, derived);
	return derived;
}

function collectFacts(root: SgNode): FileFacts {
	const candidates = root.findAll({
		rule: { any: CANDIDATE_KINDS.map((kind) => ({ kind })) },
	});
	const calls: SgNode[] = [];
	const declarators: SgNode[] = [];
	const forOfs: SgNode[] = [];
	const assignments: SgNode[] = [];
	const subscripts: SgNode[] = [];
	const comparisons: SgNode[] = [];
	for (const node of candidates) {
		const kind = node.kind();
		if (kind === "call_expression") calls.push(node);
		else if (kind === "variable_declarator") declarators.push(node);
		else if (kind === "for_in_statement") forOfs.push(node);
		else if (kind === "assignment_expression") assignments.push(node);
		else if (kind === "subscript_expression") subscripts.push(node);
		else if (kind === "binary_expression") comparisons.push(node);
	}

	// Facts are read from the initializer's NODES, never its text: a comment or
	// a string that spells `.sort(` or `.size` is not evidence (AGENTS.md shape
	// 43), and every name resolves through its own binding, so a sibling
	// function's declaration cannot answer for this one (#4606 r2).
	const initializers = new Map<string, SgNode>();
	const numericConstants = new Set<string>();
	for (const declarator of declarators) {
		const name = nodeText(declarator.field("name"));
		const value = declarator.field("value");
		if (name.length === 0 || value === null || value === undefined) continue;
		for (const identifier of identifiers(name)) {
			initializers.set(identifier, value);
			if (
				value.kind() === "number" &&
				Number(value.text().replace(/_/g, "")) !== 0
			)
				numericConstants.add(identifier);
		}
	}

	const facts: FileFacts = {
		calls,
		declarators,
		forOfs,
		assignments,
		subscripts,
		capComparisons: [],
		ceilingComparisons: [],
		initializers,
		numericConstants,
		sizeDerivedMemo: new Map(),
	};
	for (const comparison of comparisons) {
		if (isCapComparison(comparison, facts))
			facts.capComparisons.push(comparison);
		if (isCeilingComparison(comparison))
			facts.ceilingComparisons.push(comparison);
	}
	return facts;
}

/** True when the expression reads a collection size or length. */
function sizeMention(
	expression: SgNode | null | undefined,
	facts: FileFacts,
): boolean {
	if (expression === null || expression === undefined) return false;
	if (
		expression.kind() === "member_expression" &&
		LENGTH_PROPERTIES.has(expression.field("property")?.text() ?? "")
	)
		return true;
	const name = rootName(expression);
	return name !== undefined && isSizeDerived(name, facts);
}

/**
 * A cap's threshold. `0` is refused: at zero no victim exists to evict, so
 * `x.length > 0` is an emptiness check and never the bound of an eviction.
 */
function isCapThreshold(expression: SgNode | null | undefined): boolean {
	if (expression === null || expression === undefined) return false;
	const kind = expression.kind();
	if (kind === "identifier" || kind === "call_expression") return true;
	if (kind === "number")
		return Number(expression.text().replace(/_/g, "")) !== 0;
	return false;
}

/** `x.size > CAP`, `x.length >= CAP`, `occupied < getCeiling()`, and complements. */
function isCapComparison(comparison: SgNode, facts: FileFacts): boolean {
	const operator = comparison.field("operator")?.text();
	if (operator === undefined || !CAP_OPERATORS.has(operator)) return false;
	const left = comparison.field("left");
	const right = comparison.field("right");
	if (left === null || right === null) return false;
	const pairs: Array<[SgNode, SgNode]> = [
		[left, right],
		[right, left],
	];
	for (const [bound, threshold] of pairs) {
		if (!sizeMention(bound, facts)) continue;
		if (isCapThreshold(threshold)) return true;
	}
	return false;
}

/** The nearest `if`/`while`/`for` whose own condition carries a cap comparison. */
function enclosingBoundedControl(
	node: SgNode,
	facts: FileFacts,
): SgNode | undefined {
	let current = node.parent();
	while (current !== null) {
		const kind = current.kind();
		if (
			kind === "while_statement" ||
			kind === "for_statement" ||
			kind === "if_statement"
		) {
			const condition = current.field("condition");
			if (
				condition !== null &&
				facts.capComparisons.some((comparison) =>
					contains(condition, comparison),
				)
			)
				return current;
		}
		if (FUNCTION_KINDS.has(kind)) return undefined;
		current = current.parent();
	}
	return undefined;
}

/**
 * The nearest `if`/`while`/`for` whose condition carries ANY ceiling comparison
 * with a non-zero threshold. That is the bound of an iterator-head program: a
 * loop that removes one entry per iteration terminates only on its own
 * condition, so the comparison IS the cap however the counter is spelled
 * (`x.size > CAP`, `(retainedBytes ?? 0) > MAX_BYTES`).
 */
function enclosingCappedControl(
	node: SgNode,
	facts: FileFacts,
): SgNode | undefined {
	let current = node.parent();
	while (current !== null) {
		const kind = current.kind();
		if (
			kind === "while_statement" ||
			kind === "for_statement" ||
			kind === "if_statement"
		) {
			const condition = current.field("condition");
			if (
				condition !== null &&
				facts.ceilingComparisons.some((c) => contains(condition, c))
			)
				return current;
		}
		if (FUNCTION_KINDS.has(kind)) return undefined;
		current = current.parent();
	}
	return undefined;
}

/** The body a control statement runs: a block, or a bare statement. */
function controlBody(control: SgNode): SgNode | null {
	return control.field("body") ?? control.field("consequence");
}

/** The nearest `if`/`while` ancestor with a cap comparison in its condition. */
function enclosingCapGuard(node: SgNode, facts: FileFacts): SgNode | undefined {
	let current = node.parent();
	while (current !== null) {
		const kind = current.kind();
		if (
			kind === "while_statement" ||
			kind === "for_statement" ||
			kind === "if_statement"
		) {
			const condition = current.field("condition");
			if (
				condition !== null &&
				facts.capComparisons.some((comparison) =>
					contains(condition, comparison),
				)
			)
				return current;
		}
		if (FUNCTION_KINDS.has(kind)) return undefined;
		current = current.parent();
	}
	return undefined;
}

/** The cap thresholds one guard compares, as texts. */
function guardCapThresholds(guard: SgNode, facts: FileFacts): string[] {
	const condition = guard.field("condition");
	if (condition === null) return [];
	const thresholds: string[] = [];
	for (const comparison of facts.capComparisons) {
		if (!contains(condition, comparison)) continue;
		const left = comparison.field("left");
		const right = comparison.field("right");
		if (left !== null) thresholds.push(left.text().trim());
		if (right !== null) thresholds.push(right.text().trim());
	}
	return thresholds;
}

/** Names the node's own statement declares or assigns it to. */
function boundNames(node: SgNode): string[] {
	const statement = statementOf(node);
	const names: string[] = [];
	let current: SgNode | null = node;
	for (let depth = 0; depth < 64; depth++) {
		if (current === null) break;
		const kind = current.kind();
		if (kind === "variable_declarator") {
			names.push(...identifiers(nodeText(current.field("name"))));
		} else if (kind === "assignment_expression") {
			const left = current.field("left");
			if (left !== null && left.kind() === "identifier")
				names.push(left.text());
		}
		if (current === statement) break;
		current = current.parent();
	}
	return names;
}

/**
 * True when the node's EXECUTABLE text references any of `names`. Identifiers
 * are read from the AST, never from `node.text()`: a string or a comment that
 * spells a victim (`m.delete("oldest")`, a block comment naming `oldest` beside
 * `other`) is not a reference to it (AGENTS.md shape 43), and a member
 * expression's property (`other.oldest`) is a different name, not this
 * program's victim.
 */
function referencesAny(node: SgNode, names: ReadonlySet<string>): boolean {
	if (names.size === 0) return false;
	for (const identifier of node.findAll({ rule: { kind: "identifier" } })) {
		if (!names.has(identifier.text())) continue;
		const parent = identifier.parent();
		const property = parent?.field("property") ?? null;
		if (
			property !== null &&
			property.range().start.index === identifier.range().start.index
		)
			continue;
		return true;
	}
	return false;
}

/**
 * Victim names reachable from an ordered sequence's own binding: the binding
 * itself and names destructured or selected from it. A `for…of` over the
 * ordered name is NOT a victim derivation — it is the multi-victim arm of the
 * role below, and deriving its loop variable here would let any consumer of a
 * ranking count as a hand-off.
 */
function victimNames(seeds: readonly string[], facts: FileFacts): Set<string> {
	const names = new Set(seeds);
	for (let pass = 0; pass < 3; pass++) {
		const before = names.size;
		for (const declarator of facts.declarators) {
			const value = declarator.field("value");
			const source = rootName(value);
			if (source === undefined || !names.has(source)) continue;
			for (const identifier of identifiers(nodeText(declarator.field("name"))))
				names.add(identifier);
		}
		if (names.size === before) break;
	}
	return names;
}

/**
 * A comparison whose threshold is a non-zero bound, whatever it measures.
 * Used for a loop's own termination condition (see
 * {@link enclosingCappedControl}); the size-derived rule below is what admits a
 * guard standing OUTSIDE its program.
 */
function isCeilingComparison(comparison: SgNode): boolean {
	const operator = comparison.field("operator")?.text();
	if (operator === undefined || !CAP_OPERATORS.has(operator)) return false;
	const left = comparison.field("left");
	const right = comparison.field("right");
	if (left === null || right === null) return false;
	return isCapThreshold(left) || isCapThreshold(right);
}

/** True when a removal call in `region` names one of `victims`. */
function removesVictim(
	region: SgNode,
	victims: ReadonlySet<string>,
	facts: FileFacts,
): boolean {
	return facts.calls.some((call) => {
		if (!contains(region, call)) return false;
		const name = invokedName(call);
		if (name === undefined) return false;
		if (!REMOVAL_METHODS.has(name) && !REMOVAL_CALLEES.has(name)) return false;
		return referencesAny(call, victims);
	});
}

/**
 * True when a call in `region` hands a victim away. The comparator family's
 * live members evict through their OWN retirement helpers (`evictFile`,
 * `deleteDirMarker`, `retireClient`), which no removal-API name predicts, so
 * the hand-off is the evidence: the victim stops being this program's. The
 * ordering expression's OWN calls are not a hand-off (a ranking's `sort`
 * mentions the sequence by definition), so both the sort call's statement and
 * any call that encloses the ordering are excluded.
 */
function handsOffVictim(
	region: SgNode,
	victims: ReadonlySet<string>,
	facts: FileFacts,
	ordering: SgNode,
): boolean {
	const orderingStatement = statementOf(ordering);
	return facts.calls.some((call) => {
		if (!contains(region, call)) return false;
		if (contains(call, ordering) || contains(orderingStatement, call))
			return false;
		return referencesAny(call, victims);
	});
}

/** The argument expressions of a call, in source order. */
function callArguments(call: SgNode): SgNode[] {
	const argumentsNode = call.field("arguments");
	if (argumentsNode === null || argumentsNode === undefined) return [];
	return argumentsNode.namedChildren();
}

/** `[...x.keys()].sort(...)[0]`, `.at(0)`, `.find(...)` inside one statement. */
function selectsInPlace(sortCall: SgNode): boolean {
	const statement = statementOf(sortCall);
	let current: SgNode | null = sortCall;
	for (let depth = 0; depth < 64; depth++) {
		const parent: SgNode | null = current?.parent() ?? null;
		if (parent === null || !contains(statement, parent)) break;
		const kind = parent.kind();
		if (kind === "subscript_expression") {
			const index = parent.field("index");
			if (
				index !== null &&
				(index.kind() === "number" || index.kind() === "identifier")
			)
				return true;
		}
		if (kind === "call_expression") {
			const name = calleeName(parent);
			// `.shift()`/`.pop()` on the sorted temporary take an element as
			// surely as `[0]`, and the temporary has no root name for
			// `selectsByName` to follow (#4606 r2 review).
			if (
				name !== undefined &&
				(ELEMENT_METHODS.has(name) || END_SELECTORS.has(name))
			)
				return true;
		}
		if (kind === "variable_declarator" || kind === "lexical_declaration") break;
		current = parent;
	}
	return false;
}

/** A later statement that selects from one of `names`. */
function selectsByName(names: ReadonlySet<string>, facts: FileFacts): boolean {
	if (names.size === 0) return false;
	for (const subscript of facts.subscripts) {
		const source = rootName(subscript.field("object"));
		if (source === undefined || !names.has(source)) continue;
		const index = subscript.field("index");
		if (index === null) continue;
		if (index.kind() === "number" || index.kind() === "identifier") return true;
	}
	for (const call of facts.calls) {
		const name = calleeName(call);
		if (name === undefined) continue;
		if (!ELEMENT_METHODS.has(name) && !END_SELECTORS.has(name)) continue;
		const callee = call.field("function");
		if (callee === null) continue;
		const source = rootName(callee.field("object"));
		if (source !== undefined && names.has(source)) return true;
	}
	return false;
}

/** The declarator names of the ordered sequence a `sort` call belongs to. */
function orderedNames(sortCall: SgNode, facts: FileFacts): string[] {
	const statement = statementOf(sortCall);
	const names: string[] = [];
	for (const declarator of facts.declarators) {
		if (!contains(declarator, sortCall)) continue;
		names.push(...identifiers(nodeText(declarator.field("name"))));
	}
	if (names.length > 0) return names;
	if (statement.kind() === "variable_declarator")
		return identifiers(nodeText(statement.field("name")));
	const callee = sortCall.field("function");
	const source = rootName(callee?.field("object") ?? null);
	// An in-place statement (`candidates.sort(cmp)`) names its receiver; a
	// temporary spread has no receiver name and contributes no sequence.
	if (source === "this") return [];
	return source === undefined ? [] : [source];
}

/**
 * True when a loop walks an insertion-order accessor chain (`m.keys()`,
 * `this.byCall.entries()`, `state.paths?.values()`). The walk is then its own
 * order stage: the head of the chain is the first entry inserted. A loop over a
 * bare container or a helper call has no such evidence and needs the enclosing
 * cap instead, exactly as the retired lexical detector did.
 */
function accessorLoop(right: SgNode): boolean {
	let current: SgNode | null = right;
	for (let depth = 0; depth < 16 && current !== null; depth++) {
		const kind = current.kind();
		if (kind === "non_null_expression" || kind === "parenthesized_expression") {
			current = current.field("expression") ?? current.field("value");
			continue;
		}
		if (kind !== "call_expression") return false;
		const name = invokedName(current);
		return name === "keys" || name === "values" || name === "entries";
	}
	return false;
}

/** True when the body leaves its loop after the first removal. */
function breaksOut(body: SgNode): boolean {
	return body.findAll({ rule: { kind: "break_statement" } }).length > 0;
}

/** The iterator's `.next()` head, removed under the enclosing loop's ceiling. */
function recogniseNextHead(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const call of facts.calls) {
		if (calleeName(call) !== "next") continue;
		const control = enclosingCappedControl(call, facts);
		if (control === undefined) continue;
		const body = controlBody(control);
		if (body === null) continue;
		const statement = statementOf(call);
		const inline = facts.calls.some(
			(removal) =>
				contains(statement, removal) &&
				contains(removal, call) &&
				REMOVAL_METHODS.has(calleeName(removal) ?? ""),
		);
		const names = victimNames(boundNames(call), facts);
		const removed =
			inline || (names.size > 0 && removesVictim(body, names, facts));
		if (!removed) continue;
		report({ form: "iterator-head", line: lineOf(statement) });
	}
}

/** An array-destructured head (`const [oldest] = m.keys()`), removed under a cap. */
function recogniseDestructuredHead(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const declarator of facts.declarators) {
		const pattern = declarator.field("name");
		if (pattern === null || pattern.kind() !== "array_pattern") continue;
		const control = enclosingCappedControl(declarator, facts);
		if (control === undefined) continue;
		const body = controlBody(control);
		if (body === null) continue;
		const victims = victimNames(identifiers(pattern.text()), facts);
		if (victims.size === 0) continue;
		if (!removesVictim(body, victims, facts)) continue;
		report({ form: "iterator-head", line: lineOf(statementOf(declarator)) });
	}
}

/**
 * A `for…of` head that breaks after its first victim. An accessor walk is its
 * own order stage; a bare container walk needs the enclosing cap.
 */
function recogniseForOfHead(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const loop of facts.forOfs) {
		const right = loop.field("right");
		const left = loop.field("left");
		const body = loop.field("body");
		if (right === null || left === null || body === null) continue;
		const bounded = enclosingCappedControl(loop, facts);
		if (bounded === undefined && !accessorLoop(right)) continue;
		if (!breaksOut(body)) continue;
		// The victim must be the loop bindings themselves, not a name they were
		// assigned to: an assignment inside a guarded branch (`if (index >=
		// PROTECTED) { victim = key; break; }`) is a scan that skips a prefix,
		// which `ordered-scan` owns. Widening here would re-label that live
		// member's policy as a head eviction.
		const victims = new Set(identifiers(left.text()));
		if (victims.size === 0) continue;
		const region =
			bounded === undefined ? body : (controlBody(bounded) ?? body);
		if (!removesVictim(region, victims, facts)) continue;
		report({ form: "iterator-head", line: lineOf(loop) });
	}
}

/**
 * The insertion-order head, selected three ways: the iterator's `.next()`
 * result, an array-destructured accessor, or a `for…of` walk that breaks after
 * the first victim. Every spelling resolves the victim through
 * {@link victimNames}, so a second binding cannot hide it.
 */
function recogniseIteratorHead(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	recogniseNextHead(facts, report);
	recogniseDestructuredHead(facts, report);
	recogniseForOfHead(facts, report);
}

/** The side of a cap comparison that measures a size or length. */
function boundSide(comparison: SgNode, facts: FileFacts): SgNode | undefined {
	const left = comparison.field("left");
	const right = comparison.field("right");
	if (left !== null && sizeMention(left, facts)) return left;
	if (right !== null && sizeMention(right, facts)) return right;
	return undefined;
}

/** The expression an ordered sequence comes from: its value, or its receiver. */
function orderedExpression(sortCall: SgNode, facts: FileFacts): string {
	for (const declarator of facts.declarators) {
		if (!contains(declarator, sortCall)) continue;
		return nodeText(declarator.field("value"));
	}
	const callee = sortCall.field("function");
	return nodeText(callee?.field("object") ?? null);
}

/** The nearest `if` whose own condition holds this comparison. */
function guardOf(comparison: SgNode): SgNode | undefined {
	let current = comparison.parent();
	while (current !== null) {
		if (current.kind() === "if_statement") {
			const condition = current.field("condition");
			if (condition !== null && contains(condition, comparison)) return current;
		}
		if (FUNCTION_KINDS.has(current.kind())) return undefined;
		current = current.parent();
	}
	return undefined;
}

/** True when the `if` leaves the enclosing function. */
function returnsFromGuard(guard: SgNode): boolean {
	const body = controlBody(guard);
	if (body === null) return false;
	return (
		body.kind() === "return_statement" ||
		body.findAll({ rule: { kind: "return_statement" } }).length > 0
	);
}

/**
 * True when a cap comparison GOVERNS this ordered sequence, rather than merely
 * sharing its function. Three structural forms, each a live member's own shape:
 *
 * 1. a bounded control (`while (cache.size > CAP) { … sort … }`) encloses it;
 * 2. the comparison's subject is the collection the sequence derives from
 *    (`if (this.adoptedRootLastUsedAt.size < CAP) return true;` above a sort of
 *    `[...this.adoptedRootLastUsedAt.keys()]`);
 * 3. an early-return guard caps a size-derived local of the same function
 *    (`const occupied = occupiedKeys.size; if (occupied < getCeiling()) return;`
 *    above the sort of `[...this.clients.entries()]`).
 *
 * A cap that only lives elsewhere in the function is a different program's
 * bound, which is why a ranking beside an unrelated budget does not become an
 * eviction.
 */
function governsOrderedProgram(sortCall: SgNode, facts: FileFacts): boolean {
	if (enclosingBoundedControl(sortCall, facts) !== undefined) return true;
	const scope = enclosingFunction(sortCall);
	const expression = orderedExpression(sortCall, facts);
	for (const comparison of facts.capComparisons) {
		if (!contains(scope, comparison)) continue;
		const bound = boundSide(comparison, facts);
		if (bound === undefined) continue;
		const subject = bound
			.text()
			.replace(/\.\s*(?:size|length)\b.*$/, "")
			.trim();
		if (/^[\w$.]+$/.test(subject) && expression.includes(subject)) return true;
		const guard = guardOf(comparison);
		if (guard === undefined || !returnsFromGuard(guard)) continue;
		if (isSizeDerived(subject, facts)) return true;
	}
	return false;
}

/**
 * True when the ordered expression derives from a CONTAINER (a `Map`/`Set`
 * accessor chain) rather than an array of values. The hand-off-by-helper-call
 * arm exists for container entry retirement (`evictFile`, `retireClient`);
 * an ordered ARRAY of edits or rows is scanned, not evicted, so a consumer
 * call naming one of its elements proves nothing.
 */
function containerDerived(expression: string): boolean {
	return /\.\s*(?:keys|values|entries)\s*\(/.test(expression);
}

/**
 * True when every victim of an ordered sequence leaves through removal in a
 * `for…of` over it (`for (const [key] of victims) { files.delete(key) }`).
 */
function orderedLoopRemoves(
	names: ReadonlySet<string>,
	facts: FileFacts,
): boolean {
	return facts.forOfs.some((loop) => {
		const source = rootName(loop.field("right"));
		if (source === undefined || !names.has(source)) return false;
		const body = loop.field("body");
		if (body === null) return false;
		return facts.calls.some(
			(call) =>
				contains(body, call) &&
				REMOVAL_METHODS.has(invokedName(call) ?? "") &&
				referencesAny(call, new Set(identifiers(nodeText(loop.field("left"))))),
		);
	});
}

function recogniseOrderedVictim(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const call of facts.calls) {
		const name = calleeName(call);
		if (name === undefined || !ORDER_METHODS.has(name)) continue;
		const names = orderedNames(call, facts);
		if (names.length === 0) continue;
		if (!governsOrderedProgram(call, facts)) continue;
		const scope = enclosingFunction(call);
		// Derived names are resolved BEFORE selection: an alias of the ranking
		// (`const alias = ranked; m.delete(alias[0])`) selects a victim as surely
		// as the ranking itself, and a selection test against the seeds alone
		// cannot see it.
		const victims = victimNames(names, facts);
		const loopsRemove = orderedLoopRemoves(victims, facts);
		if (!loopsRemove && !selectsInPlace(call) && !selectsByName(victims, facts))
			continue;
		const handsOff =
			containerDerived(orderedExpression(call, facts)) &&
			handsOffVictim(scope, victims, facts, call);
		if (!handsOff && !removesVictim(scope, victims, facts) && !loopsRemove)
			continue;
		report({ form: "ordered-victim", line: lineOf(statementOf(call)) });
	}
}

function recogniseOrderedScan(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const loop of facts.forOfs) {
		const right = loop.field("right");
		const body = loop.field("body");
		const left = loop.field("left");
		if (right === null || body === null || left === null) continue;
		const source = rootName(right);
		const scope = enclosingFunction(loop);
		// Iterating an ORDERED ARRAY is the ordered-victim form's consumer, not
		// a container scan; counting it twice would split one program in two.
		// The binding must live in THIS loop's scope: a sibling function's
		// `const history = rows.sort(cmp)` says nothing about a Map parameter of
		// the same name here (#4606 r2).
		const ordered =
			source === undefined ? undefined : facts.initializers.get(source);
		if (
			ordered !== undefined &&
			contains(scope, ordered) &&
			readsOrdering(ordered)
		)
			continue;
		const bounded = enclosingBoundedControl(loop, facts);
		const hasBound =
			bounded !== undefined ||
			facts.capComparisons.some((comparison) => contains(scope, comparison));
		if (!hasBound) continue;
		const loopVariables = new Set(identifiers(left.text()));
		const cursors = new Set<string>();
		for (const assignment of facts.assignments) {
			if (!contains(body, assignment)) continue;
			const target = assignment.field("left");
			if (target === null || target.kind() !== "identifier") continue;
			const cursor = target.text();
			if (!loopVariables.has(cursor)) cursors.add(cursor);
		}
		if (cursors.size === 0) continue;
		const region =
			(bounded === undefined ? null : controlBody(bounded)) ?? scope;
		if (region === null) continue;
		if (!removesVictim(region, cursors, facts)) continue;
		report({ form: "ordered-scan", line: lineOf(loop) });
	}
}

/**
 * True when the truncated value itself survives: a call in `region` persists
 * one of `retained`, or the truncation is rebuilt into a collection. A write
 * call that mentions neither is a different value's write, which is what keeps
 * a string slice in a file-writing script out of the population.
 */
function persistsSurvivors(
	retained: ReadonlySet<string>,
	region: SgNode,
	facts: FileFacts,
): boolean {
	if (retained.size === 0) return false;
	return facts.calls.some((call) => {
		if (!contains(region, call)) return false;
		const name = invokedName(call);
		if (name === undefined || !WRITE_CALLEES.has(name)) return false;
		return referencesAny(call, retained);
	});
}

/**
 * True when the truncation is retained INTO a collection: `new Set(ranked.slice(
 * 0, n))`, `Object.fromEntries(entries.slice(…))`, a serialized record. A
 * string slice has no such ancestor, which is why a display truncation under a
 * length guard cannot ride the capped-retention row.
 */
function rebuildsTruncated(slice: SgNode): boolean {
	const statement = statementOf(slice);
	let current: SgNode | null = slice.parent();
	while (current !== null && contains(statement, current)) {
		const kind = current.kind();
		if (kind === "new_expression") {
			const constructor = current.field("constructor")?.text();
			if (constructor !== undefined && REBUILD_CONSTRUCTORS.has(constructor))
				return true;
		}
		if (kind === "call_expression") {
			const name = invokedName(current);
			if (name !== undefined && REBUILD_CALLEES.has(name)) return true;
		}
		current = current.parent();
	}
	return false;
}

/** True when a call in `region` persists anything at all. */
function persistsIn(region: SgNode, facts: FileFacts): boolean {
	return facts.calls.some((call) => {
		if (!contains(region, call)) return false;
		const name = invokedName(call);
		return name !== undefined && WRITE_CALLEES.has(name);
	});
}

/** True when a `for…of` iterates this truncation's prefix and removes from it. */
function truncationIteratedAndRemoved(
	slice: SgNode,
	facts: FileFacts,
): boolean {
	for (const loop of facts.forOfs) {
		const right = loop.field("right");
		const body = loop.field("body");
		if (right === null || body === null) continue;
		if (!contains(right, slice)) continue;
		const removal = facts.calls.some((call) => {
			if (!contains(body, call)) return false;
			const name = invokedName(call);
			return (
				name !== undefined &&
				(REMOVAL_METHODS.has(name) || REMOVAL_CALLEES.has(name))
			);
		});
		if (removal) return true;
	}
	return false;
}

/**
 * Calls that turn a value into a STRING. A string is capped for display, never
 * evicted, so a truncation reached by one of them must not ride a retention
 * row. This is what keeps `firstError.slice(0, 240)`,
 * `output.split("\n").slice(-TAIL_LINES).join("\n")` and
 * `new Date().toISOString().slice(0, 10)` out of the population — each is a
 * genuine bounded WINDOW of text, and no bounded collection class applies.
 */
const STRING_PRODUCERS = new Set([
	"split",
	"join",
	"trim",
	"trimEnd",
	"trimStart",
	"toString",
	"toISOString",
	"toLowerCase",
	"toUpperCase",
	"replace",
	"replaceAll",
	"padStart",
	"padEnd",
	"repeat",
	"String",
]);

/**
 * True when the truncation's value is text: an ancestor call produces a string
 * from it, or its receiver chain runs through one. Read structurally off the
 * call, never off a list of variable names (`path.join` is an ancestor of no
 * truncation here, and `array.slice(...).join("\n")` is).
 */
function stringShaped(slice: SgNode): boolean {
	const statement = statementOf(slice);
	let current: SgNode | null = slice.parent();
	while (current !== null && contains(statement, current)) {
		if (current.kind() === "template_string") return true;
		if (
			current.kind() === "binary_expression" &&
			current.field("operator")?.text() === "+"
		)
			return true;
		if (current.kind() === "call_expression") {
			const name = invokedName(current);
			if (name !== undefined && STRING_PRODUCERS.has(name)) return true;
		}
		current = current.parent();
	}
	let receiver: SgNode | null =
		slice.field("function")?.field("object") ?? null;
	for (let depth = 0; depth < 32 && receiver !== null; depth++) {
		const kind = receiver.kind();
		if (kind === "string" || kind === "template_string") return true;
		if (kind === "call_expression") {
			const name = invokedName(receiver);
			if (name !== undefined && STRING_PRODUCERS.has(name)) return true;
			receiver = receiver.field("function");
			continue;
		}
		if (kind === "member_expression") {
			receiver = receiver.field("object");
			continue;
		}
		break;
	}
	return false;
}

/** A count that bounds a truncation on its own: literal, constant, or derived. */
function isBoundingCount(count: string, facts: FileFacts): boolean {
	const bare = count.trim().replace(/^-/, "").trim();
	if (!/^[\w$]+$/.test(bare)) return false;
	return facts.numericConstants.has(bare) || isSizeDerived(bare, facts);
}

function recogniseCountTruncation(
	facts: FileFacts,
	report: (program: EvictionProgram) => void,
): void {
	for (const call of facts.calls) {
		if (calleeName(call) !== "slice") continue;
		const args = callArguments(call);
		let count: string | undefined;
		if (args.length === 2 && nodeText(args[0]).trim() === "0")
			count = nodeText(args[1]);
		else if (args.length === 1 && nodeText(args[0]).trim().startsWith("-"))
			count = nodeText(args[0]);
		if (count === undefined) continue;
		const guard = enclosingCapGuard(call, facts);
		const countIsBound = isBoundingCount(count, facts);
		const countNames = identifiers(count);
		const cappedByGuard =
			guard !== undefined &&
			guardCapThresholds(guard, facts).some((threshold) =>
				countNames.includes(threshold),
			);
		// A count that states a size is not a cap: `slice(0, 9)`, `slice(0, 240)`
		// and a string tail are sizes and windows, never retention policy.
		if (!countIsBound && !cappedByGuard) continue;
		if (stringShaped(call)) continue;
		// The bound alone is not the program: the survivors must actually leave
		// state. Three arms, each a live member's own retention evidence.
		const retained = new Set(boundNames(call));
		const scope = enclosingFunction(call);
		const iterated = truncationIteratedAndRemoved(call, facts);
		const retains =
			persistsSurvivors(retained, scope, facts) ||
			(rebuildsTruncated(call) &&
				(persistsIn(scope, facts) || cappedByGuard)) ||
			iterated;
		if (!retains) continue;
		report({ form: "count-truncation", line: lineOf(statementOf(call)) });
	}

	for (const assignment of facts.assignments) {
		const target = assignment.field("left");
		const value = assignment.field("right");
		if (target === null || value === null) continue;
		if (
			target.kind() !== "member_expression" ||
			target.field("property")?.text() !== "length"
		)
			continue;
		const guard = enclosingCapGuard(assignment, facts);
		if (guard === undefined) continue;
		const condition = guard.field("condition");
		if (condition === null) continue;
		const touchesLength = facts.capComparisons.some(
			(comparison) =>
				contains(condition, comparison) &&
				(sizeMention(comparison.field("left"), facts) ||
					sizeMention(comparison.field("right"), facts)),
		);
		if (!touchesLength) continue;
		// The write's own count must be a cap: a literal, a file constant, or the
		// very bound the guard compares. A runtime argument is not evidence of a
		// cap, so `function pushTop(array, item, max) { … array.length = max }`
		// stays a refusal with its live member recorded, not a silent pass.
		const writeCount = nodeText(value).trim();
		const writeCountIsBound =
			isBoundingCount(writeCount, facts) ||
			guardCapThresholds(guard, facts).includes(writeCount);
		if (!writeCountIsBound) continue;
		report({
			form: "count-truncation",
			line: lineOf(statementOf(assignment)),
		});
	}
}

/** Every eviction program in one TypeScript-grammar source text. */
export function findEvictionPrograms(source: string): EvictionProgram[] {
	const root = parseRoot(source);
	const facts = collectFacts(root);
	const byLine = new Map<number, EvictionProgram>();
	const report = (program: EvictionProgram): void => {
		if (!byLine.has(program.line)) byLine.set(program.line, program);
	};
	recogniseIteratorHead(facts, report);
	recogniseOrderedVictim(facts, report);
	recogniseOrderedScan(facts, report);
	recogniseCountTruncation(facts, report);
	return [...byLine.values()].sort((a, b) => a.line - b.line);
}
