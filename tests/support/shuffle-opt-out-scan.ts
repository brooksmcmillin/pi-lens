/**
 * The one reader of vitest's `shuffle` suite option (#4561 D1).
 *
 * A `describe` whose subject IS the order its cases run in opts out with
 * `{ shuffle: false }` and is registered in `scripts/shuffle-census-ratchet.json`
 * (`byDesign`). The registry is only worth having if a reader sees EVERY
 * spelling of the option, so this module is an ALLOWLIST over the parsed AST:
 * it admits one opt-out spelling and one harmless opt-in, and reports
 * everything else it cannot read. The state table in PR #4611 is the contract
 * this file implements; the lettered rows below cite its cells.
 *
 * Review r2 (#4611): the r1 version read a fixed set of syntactic spellings off
 * `stripSource`'s text, so a shorthand property (`{ shuffle }`, whose value is
 * the binding) was invisible to both the key census and the "other options
 * beside" check and passed silently, and an aliased callee (`const d =
 * describe`) with a computed key passed too. The same text census read string
 * CONTENTS as code, so `const s = "{ shuffle: false }"` and a `{ shuffle:
 * boolean }` type red the gate. Structure now comes from `oxc-parser` (#4616:
 * an enumerated detector is replaced by one derived from the syntax tree): the
 * reader reads AST property nodes of object literals, so a string or a type
 * member is not a property and cannot be a finding.
 *
 * Review r3 (#4611 MEDIUM-1, Greptile P2 r4307007027): an options object is a
 * SEQUENCE, not a set. Vitest evaluates a literal left to right, so the value
 * that wins is the LAST key naming `shuffle`, and any spread or unnameable
 * computed key may override what the reader already read. The r2 reader
 * stopped at the first readable `shuffle: true`, so `{ shuffle: true, ...{
 * [KEY]: false } }` opted out invisibly. The one read below now refuses an
 * options object holding ANY spread or ANY computed key it cannot name, even
 * beside a readable `shuffle`, and takes the effective value last-key-wins:
 * an object's effective shuffle value is readable only when no key can
 * override it. Callee aliases are the second half of the same defect: a
 * binding was recorded only when its initializer was already a test-callee
 * NAME, so `const a = describe; const b = a` was dropped and the chain loop
 * could never add an entry. Every callee-shaped binding is recorded now and
 * resolved to a fixed point (any hop count, `const d = V.describe` included),
 * and a binding the resolver cannot follow that is called with an options
 * argument refuses instead of being ignored.
 *
 * liveness (whether a run reaches the suite at all) stays owned by
 * `testDeclarations` in `sweep-kit.ts`, matched to the call by its opening
 * parenthesis: one owner answers "does vitest run this", and an opt-out this
 * reader cannot tie to a live, registered declaration refuses.
 */
import { parseSync, Visitor, type Node } from "oxc-parser";

import {
	lineOf,
	nextNonSpace,
	testDeclarations,
	type TestDeclaration,
} from "./sweep-kit.js";
import { vitestCollects } from "./vitest-collection.js";

export interface ShuffleOptOutFinding {
	/** 1-based line in the source the finding was read from. */
	line: number;
	message: string;
}

export interface ShuffleOptOutAudit {
	/** Titles of `describe`s that opt out with the admitted spelling, and run. */
	admitted: string[];
	findings: ShuffleOptOutFinding[];
}

/** Callees that declare a suite or a case. Only the suite pair is inspected. */
const TEST_CALLEES = new Set(["describe", "suite", "it", "test"]);
const SUITE_CALLEES = new Set(["describe", "suite"]);

/** A source range, so the net below can skip what the structural read judged. */
interface Span {
	start: number;
	end: number;
}

/** A property key, as far as this reader can name it (STATE_TABLE C rows). */
type KeyName =
	| { name: string; form: "bare" | "quoted" | "computed-literal" }
	| { name: undefined; form: "computed-unresolved" };

const REASON_SPREAD =
	"its options spread another object, so a shuffle opt-out carried in that object, and which object wins, is not readable here";
const REASON_COMPUTED =
	"its options hold a computed key whose name this reader cannot resolve, so an opt-out behind it is unattributable";
const REASON_SHORTHAND =
	"its shuffle property is written as a shorthand (`{ shuffle }`), so the value is the binding, not a literal this census can read";
const REASON_ACCESSOR =
	"its shuffle property is an accessor, not a value this census can read";
const REASON_UNREADABLE_VALUE =
	"the value of its shuffle property is not a literal true/false (it is read from a binding or a call), so whether it opts out is unattributable";
const REASON_UNSPELLED =
	"its shuffle key is spelled as a quoted or computed key; only the bare `shuffle` key is admitted";
const REASON_EXTRA_OPTIONS =
	"the shuffle opt-out is not the only property of its options object; an opt-out is admitted only as the minimal `{ shuffle: false }` marker, so the exemption stays visible";
const REASON_ALIASED =
	"it opts out of shuffle through a callee alias (`%callee%`), which this census cannot tie to a live, registered `describe`";
const REASON_NOT_LIVE =
	"opts out of shuffle but vitest never runs it (a skip or todo modifier, or an enclosing skipped suite), so its registry row would vouch for a suite the run does not include";
const REASON_OPTIONS_NOT_LITERAL =
	"its options are not a plain object literal in this file (an identifier bound elsewhere, a cast, a call, or a conditional), so a shuffle opt-out in them is unattributable";
const REASON_OUTSIDE =
	"a shuffle option key outside any describe options object: a shared options object, a helper, or a config is not attributable, so this census cannot tell which suite it opts out";
const REASON_UNCALLEABLE =
	"its callee `%callee%` is a local binding this census cannot follow to a test callee (`describe`/`suite`), and the call passes an options argument, so whether it opts out of shuffle is unattributable";

/** `node` as a plain field bag: oxc's `Node` union is narrower than its runtime shape. */
function fields(node: Node): Record<string, unknown> {
	return node as unknown as Record<string, unknown>;
}

/** A field that may hold one node or an array of them. */
function nodes(value: unknown): Node[] {
	const list = Array.isArray(value) ? value : [value];
	return list.filter(
		(child): child is Node =>
			child !== null && typeof child === "object" && "type" in child,
	);
}

/** A field that holds a node, when it holds one (oxc writes `null` for absent). */
function nodeField(value: unknown): Node | undefined {
	return value !== null && typeof value === "object" && "type" in value
		? (value as Node)
		: undefined;
}

/** The property key `property` declares, or `undefined` for a non-member. */
function keyName(property: Node): KeyName | undefined {
	if (property.type !== "Property") return undefined;
	const key = nodeField(fields(property).key);
	if (key === undefined) return undefined;
	if (fields(property).computed === true) {
		const value = fields(key).value;
		return typeof value === "string"
			? { name: value, form: "computed-literal" }
			: { name: undefined, form: "computed-unresolved" };
	}
	if (key.type === "Identifier")
		return { name: String(fields(key).name), form: "bare" };
	const value = fields(key).value;
	return typeof value === "string"
		? { name: value, form: "quoted" }
		: { name: undefined, form: "computed-unresolved" };
}

/** A literal `true`/`false`, or `undefined` when the value is computed. */
function booleanLiteral(node: Node | undefined): boolean | undefined {
	if (node === undefined || node.type !== "Literal") return undefined;
	const value = fields(node).value;
	return typeof value === "boolean" ? value : undefined;
}

/**
 * What the local bindings say about a call's callee, read once per file
 * (STATE_TABLE C3-C6). Every binding is recorded by SHAPE, then resolved:
 * a binding a call can reach through (`const b = a`, `const d = V.describe`)
 * is an edge, and an edge that ends at a test-callee name resolves to it. A
 * callee-shaped binding that does not (`const s = wrap(describe)`, `const b =
 * q`) is `unresolved`, so a call through it with an options argument refuses
 * rather than being ignored (r3 rule 2).
 */
interface CalleeBindings {
	/** local name -> the name it stands for (`const b = a`, `const d = describe`). */
	edges: Map<string, string>;
	/** namespace imports of `vitest` (`import * as V from "vitest"`). */
	namespaces: Set<string>;
	/** local names a declarator binds, which therefore are not the global callee. */
	shadowed: Set<string>;
	/** local names bound to a callee-shaped value that resolves to no test callee. */
	unresolved: Set<string>;
	/** local name -> the object literal it is bound to (STATE_TABLE F2). */
	literals: Map<string, Node>;
}

/** The name a chain of local bindings stands for, or `undefined` if it never
 * reaches a test callee. A name a declarator BINDS is never the bare callee it
 * spells, and a cycle never resolves: this reader cannot follow either. */
function resolveName(
	name: string,
	bindings: CalleeBindings,
): string | undefined {
	const seen = new Set<string>();
	let current = name;
	while (!seen.has(current)) {
		seen.add(current);
		const next = bindings.edges.get(current);
		if (next === undefined)
			return !bindings.shadowed.has(current) && TEST_CALLEES.has(current)
				? current
				: undefined;
		current = next;
	}
	return undefined;
}

/**
 * The root callee name of a chain (`describe`, `suite`, or whatever a binding
 * resolves to), following local aliases to a fixed point.
 */
function resolveCallee(
	callee: Node | undefined,
	bindings: CalleeBindings,
): string | undefined {
	let current = callee;
	for (let hops = 0; current !== undefined && hops < 64; hops++) {
		const record = fields(current);
		if (current.type === "Identifier")
			return resolveName(String(record.name), bindings);
		if (current.type === "MemberExpression") {
			const object = record.object as Node | undefined;
			const property = record.property as Node | undefined;
			// `V.describe(...)` through a vitest namespace import names the callee
			// by its property; any other member chain is not this reader's to
			// resolve (`V.suite` would otherwise attribute a foreign object).
			if (
				object?.type === "Identifier" &&
				bindings.namespaces.has(String(fields(object).name))
			)
				return memberName(property);
			current = object;
			continue;
		}
		if (current.type === "CallExpression") {
			current = record.callee as Node | undefined;
			continue;
		}
		return undefined;
	}
	return undefined;
}

/** A member expression's static property name, when it has one. */
function memberName(property: Node | undefined): string | undefined {
	if (property === undefined) return undefined;
	if (property.type === "Identifier") return String(fields(property).name);
	const value = fields(property).value;
	return typeof value === "string" ? value : undefined;
}

/**
 * Every local binding a call could reach a test callee through, collected by
 * the SHAPE of its initializer rather than by its name (`describe` itself was
 * the r2 filter, which dropped `const b = a` before the chain loop could run).
 */
function calleeBindings(bindings: readonly Node[]): CalleeBindings {
	const record: CalleeBindings = {
		edges: new Map(),
		namespaces: new Set(),
		shadowed: new Set(),
		unresolved: new Set(),
		literals: new Map(),
	};
	for (const node of bindings) {
		const nodeFields = fields(node);
		if (node.type === "ImportDeclaration") {
			const source = nodeFields.source as Node | undefined;
			if (source === undefined || fields(source).value !== "vitest") continue;
			for (const specifier of nodes(nodeFields.specifiers)) {
				const specifierFields = fields(specifier);
				const local = fields(specifierFields.local as Node).name as string;
				if (specifier.type === "ImportNamespaceSpecifier") {
					record.namespaces.add(local);
					continue;
				}
				if (specifier.type !== "ImportSpecifier") continue;
				// `import { describe } from "vitest"` binds the name to itself; only a
				// RENAME is an alias this reader has to resolve.
				const imported = fields(specifierFields.imported as Node)
					.name as string;
				if (local !== imported) record.edges.set(local, imported);
			}
			continue;
		}
		if (node.type !== "VariableDeclarator") continue;
		const id = nodeField(nodeFields.id);
		const init = nodeField(nodeFields.init);
		if (id?.type !== "Identifier" || init === undefined) continue;
		const local = String(fields(id).name);
		record.shadowed.add(local);
		// A local that SHADOWS a callee name is an edge like any other: if it
		// resolves to a test callee the name keeps its meaning, and if it does
		// not (`const suite = wrap(describe)`) the call refuses rather than
		// reading as vitest's own `suite` (r3 rule 2).
		if (init.type === "ObjectExpression") {
			record.literals.set(local, init);
			continue;
		}
		if (init.type === "Identifier") {
			record.edges.set(local, String(fields(init).name));
			continue;
		}
		if (init.type === "MemberExpression") {
			const object = fields(init).object as Node | undefined;
			const property = memberName(fields(init).property as Node | undefined);
			if (
				object?.type === "Identifier" &&
				record.namespaces.has(String(fields(object).name)) &&
				property !== undefined &&
				TEST_CALLEES.has(property)
			) {
				record.edges.set(local, property);
				continue;
			}
			record.unresolved.add(local);
			continue;
		}
		if (init.type === "CallExpression" || init.type === "NewExpression")
			record.unresolved.add(local);
	}
	// A name is unresolved when the fixed point of its chain is no test callee,
	// whether the chain ends at a callee-shaped value or at a bare identifier.
	for (const local of [...record.edges.keys(), ...record.unresolved]) {
		if (resolveName(local, record) === undefined) record.unresolved.add(local);
	}
	return record;
}

/** The `(` that opens a call, from its callee's last token. */
function callParen(
	source: string,
	callee: Node | undefined,
): number | undefined {
	if (callee === undefined) return undefined;
	const at = nextNonSpace(source, callee.end);
	return source[at] === "(" ? at : undefined;
}

/** Whether `span` lies inside any of `spans`. */
function inside(span: Span, spans: readonly Span[]): boolean {
	return spans.some(
		(outer) => span.start >= outer.start && span.end <= outer.end,
	);
}

/** What one options object literal says, read once for both paths (row F3). */
interface OptionsRead {
	/** The first property this reader cannot attribute, in source order. */
	problem?: { at: number; reason: string };
	/** The LAST property naming `shuffle`: vitest evaluates the literal in order. */
	shuffle?: { at: number; value: boolean | undefined; count: number };
	/** How many properties the literal holds (row P9 needs exactly one). */
	propertyCount: number;
}

/**
 * Read one options object literal as a SEQUENCE (STATE_TABLE F3/P2-P12).
 *
 * An object's EFFECTIVE shuffle value is readable only when nothing in it can
 * override it: no spread, no computed key this reader cannot name, and a
 * `shuffle` value that is a literal. The effective value of several `shuffle`
 * keys is the last one, so a readable `shuffle: true` early is not proof: a
 * spread or an unnameable key after it may set `false`. That is why a problem
 * is recorded even when a readable `shuffle` key is also present, and why the
 * two paths (the describe options slot and the net) share this one read.
 */
function readOptions(properties: readonly Node[]): OptionsRead {
	const read: OptionsRead = { propertyCount: properties.length };
	const refuse = (at: number, reason: string) => {
		read.problem ??= { at, reason };
	};
	for (const property of properties) {
		if (property.type === "SpreadElement") {
			refuse(property.start, REASON_SPREAD); // P8
			continue;
		}
		const key = keyName(property);
		if (key === undefined) continue; // P11
		if (key.form === "computed-unresolved") {
			refuse(property.start, REASON_COMPUTED); // P7
			continue;
		}
		if (key.name !== "shuffle") continue; // P11
		const propertyFields = fields(property);
		const at = property.start;
		const count = (read.shuffle?.count ?? 0) + 1;
		if (propertyFields.kind !== "init") {
			read.shuffle = { at, value: undefined, count };
			refuse(at, REASON_ACCESSOR); // P10
			continue;
		}
		if (propertyFields.shorthand === true) {
			read.shuffle = { at, value: undefined, count };
			refuse(at, REASON_SHORTHAND); // P4
			continue;
		}
		const value = booleanLiteral(propertyFields.value as Node | undefined);
		read.shuffle = { at, value, count };
		if (value === undefined) {
			refuse(at, REASON_UNREADABLE_VALUE); // P3
			continue;
		}
		if (!value && key.form !== "bare") refuse(at, REASON_UNSPELLED); // P5, P6
	}
	return read;
}

/** What one file's audit accumulates while it walks the tree. */
interface Audit {
	source: string;
	bindings: CalleeBindings;
	/** Options objects the structural read judged; the net adds nothing there. */
	inspected: Span[];
	admitted: string[];
	findings: ShuffleOptOutFinding[];
	report(at: number, message: string): void;
	/** liveness for the call opening at `paren`, from the shared owner. */
	declarationOf(paren: number | undefined): TestDeclaration | undefined;
}

/**
 * One `describe`/`suite` call (STATE_TABLE A/B/C/D rows): admit its opt-out, or
 * report why the options object is not readable. Returns nothing; a call
 * outside the suite pair is the net's business.
 */
function judgeSuiteCall(node: Node, audit: Audit): void {
	const record = fields(node);
	const callee = record.callee as Node | undefined;
	const resolved = resolveCallee(callee, audit.bindings);
	if (resolved === undefined || !SUITE_CALLEES.has(resolved)) return;
	const args = nodes(record.arguments);
	// B1/B2: no options slot. A body passed by name is silent; an object
	// literal in the body slot is judged by the net.
	if (args.length < 3) return;
	const options = args[1] as Node;
	audit.inspected.push({ start: options.start, end: options.end });

	if (options.type !== "ObjectExpression") {
		// F2: an options binding this file gives an object literal is that
		// literal's read, reported here once. The net must not report it again.
		const bound = audit.bindings.literals.get(
			options.type === "Identifier" ? String(fields(options).name) : "",
		);
		if (bound !== undefined)
			audit.inspected.push({ start: bound.start, end: bound.end });
		audit.report(
			options.start,
			`describe options: ${REASON_OPTIONS_NOT_LITERAL}`,
		); // B4
		return;
	}

	const read = readOptions(nodes(fields(options).properties));
	const declaration = () =>
		audit.declarationOf(callParen(audit.source, callee));
	if (read.problem !== undefined) {
		audit.report(
			options.start,
			`describe "${declaration()?.title ?? "?"}": ${read.problem.reason}`,
		);
		return;
	}
	if (read.shuffle === undefined) return; // B2
	if (read.shuffle.value === true) return; // P2: a readable opt-in, no row needed
	const owner = declaration();
	const title = owner?.title ?? "?";
	if (read.propertyCount > 1) {
		audit.report(
			read.shuffle.at,
			`describe "${title}": ${REASON_EXTRA_OPTIONS}`,
		); // P9
		return;
	}
	if (owner === undefined) {
		audit.report(
			options.start,
			`describe "${title}": ${REASON_ALIASED.replace("%callee%", resolved)}`,
		); // D2
		return;
	}
	if (!owner.live) {
		audit.report(options.start, `describe "${title}": ${REASON_NOT_LIVE}`); // D1
		return;
	}
	audit.admitted.push(title);
}

/**
 * A call through a local binding the resolver cannot follow, with an options
 * argument (STATE_TABLE C6). The binding may be the `describe` this census
 * needs, or a helper that wraps one; either way the census cannot say, so the
 * call refuses instead of passing as "not a describe" (r3 rule 2).
 */
function judgeUnresolvedCallee(node: Node, audit: Audit): void {
	const record = fields(node);
	const callee = record.callee as Node | undefined;
	if (callee?.type !== "Identifier") return;
	const name = String(fields(callee).name);
	if (!audit.bindings.unresolved.has(name)) return;
	const args = nodes(record.arguments);
	// Three arguments is the suite shape; with two the second is the body.
	if (args.length < 3) return;
	const options = args[1] as Node;
	// "Options-shaped" is an object literal, or a name this file binds to one: an
	// identifier at the second position of any three-argument call is just an
	// argument (`appendFile(file, data, options)`), and refusing those would red
	// ordinary tests. A foreign module's options object stays out of reach here.
	const literal =
		options.type === "ObjectExpression"
			? options
			: options.type === "Identifier"
				? audit.bindings.literals.get(String(fields(options).name))
				: undefined;
	if (literal === undefined) return;
	audit.inspected.push({ start: options.start, end: options.end });
	audit.inspected.push({ start: literal.start, end: literal.end });
	// An options-shaped object with nothing to attribute (no `shuffle` key, no
	// spread, no unnameable key) cannot be hiding an opt-out from this reader,
	// so the unresolved callee alone is not a finding.
	const read = readOptions(nodes(fields(literal).properties));
	if (read.shuffle === undefined && read.problem === undefined) return;
	audit.report(options.start, REASON_UNCALLEABLE.replace("%callee%", name));
}

/**
 * Every `describe` opt-out the caller sets, and every `shuffle` key this reader
 * cannot attribute. Pass the file's raw source, and its path when the extension
 * decides the grammar (`.ts`/`.tsx`/`.js`).
 */
export function auditShuffleOptOuts(
	source: string,
	file = "source.ts",
): ShuffleOptOutAudit {
	const admitted: string[] = [];
	const findings: ShuffleOptOutFinding[] = [];
	const parsed = parseSync(file, source);
	const firstError = parsed.errors[0];
	if (firstError !== undefined) {
		// H1: a file this reader cannot parse must never pass.
		findings.push({
			line: lineOf(source, firstError.labels[0]?.start ?? 0),
			message: `this file does not parse (${firstError.message}), so no shuffle opt-out in it is attributable`,
		});
		return { admitted, findings };
	}

	// liveness is the expensive read (it re-blanks the file inside
	// `testDeclarations`), so it is resolved lazily: the census sweeps every
	// tracked test file, and almost none of them name the option at all.
	let declarations: Map<number, TestDeclaration> | undefined;
	const audit: Audit = {
		source,
		bindings: {
			edges: new Map(),
			namespaces: new Set(),
			shadowed: new Set(),
			unresolved: new Set(),
			literals: new Map(),
		},
		inspected: [],
		admitted,
		findings,
		report: (at, message) =>
			findings.push({ line: lineOf(source, at), message }),
		declarationOf: (paren) => {
			if (paren === undefined) return undefined;
			declarations ??= new Map(
				testDeclarations(source).map((declaration) => [
					declaration.callParen,
					declaration,
				]),
			);
			return declarations.get(paren);
		},
	};

	const bindings: Node[] = [];
	const calls: Node[] = [];
	const literals: Node[] = [];
	new Visitor({
		ImportDeclaration: (node) => bindings.push(node),
		VariableDeclarator: (node) => bindings.push(node),
		CallExpression: (node) => calls.push(node),
		ObjectExpression: (node) => literals.push(node),
	}).visit(parsed.program);
	audit.bindings = calleeBindings(bindings);

	for (const call of calls) {
		judgeSuiteCall(call, audit);
		judgeUnresolvedCallee(call, audit);
	}

	// F1: the net. An object literal that names a `shuffle` key and is not an
	// options slot the structural read judged is not attributable to a suite, so
	// it reds instead of passing unclassified. It reads the SAME options read as
	// the slot (r3 rule 1): a literal with a spread or an unnameable key refuses
	// even when a readable `shuffle: true` sits beside it, because the later key
	// can override it.
	for (const literal of literals) {
		const span: Span = { start: literal.start, end: literal.end };
		if (inside(span, audit.inspected)) continue;
		const read = readOptions(nodes(fields(literal).properties));
		if (read.shuffle === undefined) continue; // nothing names the option
		if (read.problem !== undefined) {
			audit.report(read.problem.at, read.problem.reason);
			continue;
		}
		// P2: a readable opt-in needs no row, here as at a describe.
		if (read.shuffle.value === true) continue;
		audit.report(read.shuffle.at, REASON_OUTSIDE);
	}

	return { admitted, findings };
}

export interface ShuffleOptOutCensus {
	/** `${file}::${describe}` for every admitted, registered-shaped opt-out. */
	optedOut: Set<string>;
	/** `${file}:${line}: ${message}`, in the order the files were read. */
	findings: string[];
}

/**
 * The census population: every tracked file a vitest project collects
 * (#4611 review r3 LOW-1). Which extensions a test file may have is the
 * collection config's question, asked of its owner, never a list restated
 * here: `endsWith(".ts")` dropped `.tsx`, `.mts`, `.cts` and the JS
 * extensions vitest collects, so an opt-out in one of those was invisible.
 */
export function shuffleCensusPopulation(files: Iterable<string>): string[] {
	return [...files].filter((file) => vitestCollects(file));
}

/**
 * The census over a set of sources, as the gate reads it: one entry per file,
 * the admitted opt-outs keyed by file, and every finding flattened with its
 * location. `tests/scripts/ci-shuffle-census.test.ts` runs it over the tracked
 * tests tree, and over the planted fixtures that prove each rejected spelling
 * reds (#4611 review r1 M2, M3; r2 M-a, M-b).
 */
export function censusShuffleOptOuts(
	entries: Iterable<{ file: string; source: string }>,
): ShuffleOptOutCensus {
	const optedOut = new Set<string>();
	const findings: string[] = [];
	for (const { file, source } of entries) {
		const audit = auditShuffleOptOuts(source, file);
		for (const title of audit.admitted) optedOut.add(`${file}::${title}`);
		for (const finding of audit.findings)
			findings.push(`${file}:${finding.line}: ${finding.message}`);
	}
	return { optedOut, findings };
}

/**
 * The gate's verdict over a census and the registry's rows: every issue the
 * population raises, in one list, so the tree sweep and the planted spellings
 * assert the same thing. Empty means every opt-out in the population is the
 * admitted spelling, registered, and matched by a row that still names a live
 * describe.
 */
export function judgeShuffleOptOuts(
	census: ShuffleOptOutCensus,
	registered: Iterable<string>,
): string[] {
	const rows = new Set(registered);
	const issues = [...census.findings];
	for (const key of census.optedOut) {
		if (!rows.has(key))
			issues.push(`${key}: opts out of shuffle but is not registered`);
	}
	for (const key of rows) {
		if (!census.optedOut.has(key))
			issues.push(
				`${key}: registered, but no live describe in that file opts out`,
			);
	}
	return issues;
}
