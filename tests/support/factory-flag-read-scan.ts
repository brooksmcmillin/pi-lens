/**
 * Detector for a flag read that runs while an extension factory runs (#4913).
 *
 * Recurrence this prevents (AGENTS.md shape 87, "factory-time read of a host
 * value pi sets after the factory"): pi applies the command-line values of an
 * extension's flags after every factory has run, so `pi.getFlag` inside the
 * factory answers the registered default. `index.ts` read `no-lens`,
 * `no-lens-context`, `lens-compact-tool-line` and `--no-tool` there, and
 * `pi --no-lens` still started language servers.
 *
 * Population: the function pi calls as the factory, which is the default
 * export's own function node (inline, or the module-level function that
 * `export default f` / `export { f as default }` names), AND, transitively,
 * every module-level function or function-valued constant those bodies call
 * while they run (a helper the factory calls synchronously is part of the
 * factory; today the chain reaches `activateExtension`). A default export the
 * scan cannot resolve to one such function throws instead of passing. The
 * module top level is not in it: it runs at import, before pi hands the
 * factory its API. It is parsed
 * from COMMENT-AND-STRING-BLANKED text (`stripSource`, so a comment that
 * quotes `getLensFlag(` is not a read), through the census AST seam
 * (`ast-census.ts`).
 *
 * ALLOWLIST (the round-4 redesign, #4917 F9: four rounds each found a new
 * spelling of a read, so the scan no longer enumerates reader spellings).
 * Inside the population, `pi` is the default export's first parameter, the
 * parameter of a population function that receives `pi` as a call argument,
 * and the result of a {@link PI_WRAPPERS} call. A use of `pi` that runs while
 * the factory runs is ADMITTED only as:
 *
 * - A1: `pi.<m>` with `m` in {@link HOST_REGISTRARS}, called or read, through
 *   type assertions and `?.`: each registers, and its handler runs later;
 * - A2: a direct argument of a call to a module-level function, which joins
 *   the population with that parameter as its `pi`;
 * - A3: `const x = withConsoleCaptureWindows(pi)`, whose `x` is `pi`.
 *
 * Every other use is REFUSED, however it is spelled: another member, a
 * destructuring (renamed, shorthand, nested, or a parameter), an alias, a
 * spread, a computed member, a shorthand property, an assignment, `pi` handed
 * to a function outside the population, and `arguments[0]`.
 *
 * A local closure is a READER when running it would make a refused use (its
 * own, a reader it calls, or a module function it hands `pi` to). A
 * factory-time reference to a reader is admitted only when it is handed to a
 * call that stores it (a call argument, or a pair value of an object-literal
 * call argument); a call to it, an alias, an assignment and every other form
 * is refused at the reference. That is how `getLensFlag("no-lens")`, the read
 * #4913 shipped, is caught at the call site.
 *
 * WHEN code runs (round 2, #4917 F2): a function only DEFERS its body when it
 * is a declaration, a function bound by `const f = () => ..`, or a function
 * (or an object literal holding one) handed to a known deferring registrar,
 * directly or through wrapper calls whose result is the registrar's argument
 * (`pi.on("x", wrap(fn))`). Every other function (an IIFE, an object method
 * the factory invokes, a `new Promise` executor, a synchronous array callback)
 * runs while the factory runs.
 *
 * A refused site is reported keyed `<function>:<binding>:<name>:<form>`; an
 * {@link FactoryFlagAdmission} row with that key carries the reason the tree
 * admits it and the number of sites it admits. A key with more sites than the
 * row states reports every one of them; with fewer, the row is stale (#4917
 * F11: a row admitted every site sharing its key, so a new read hid behind it).
 *
 * RESIDUALS, named. The call graph follows direct calls by name only: a helper
 * reached through a variable, a method or a dynamic `import()` is invisible. A
 * callee that runs a reader it was handed synchronously reads at factory time
 * unseen. A registrar name that a given object runs synchronously is trusted.
 * A flag read in a module the factory imports, or one reached through a value
 * an admission row lets out, is not scanned.
 */
import type { SgNode } from "@ast-grep/napi";
import { parseNodes } from "./ast-census.js";
import { stripSource } from "./sweep-kit.js";

/**
 * Members of the factory's `pi` whose use reads no flag value: each registers
 * a definition or a handler, and a handler runs after pi applied the flags
 * (allowlist form A1, #4917 round 4).
 */
const HOST_REGISTRARS = new Set([
	"on",
	"registerTool",
	"registerFlag",
	"registerCommand",
	"registerMessageRenderer",
]);

/**
 * Imported calls whose result is the factory's `pi`, wrapped (form A3):
 * `withConsoleCaptureWindows` returns a `Proxy` and reads no member while it
 * builds it (`clients/extension-log.ts`).
 */
const PI_WRAPPERS = new Set(["withConsoleCaptureWindows"]);

/** Refused sites the tree admits under one key: how many, and why none is a defect. */
export type FactoryFlagAdmission = Readonly<
	Record<string, { readonly count: number; readonly reason: string }>
>;

export interface FactoryFlagRead {
	readonly line: number;
	readonly reader: string;
	/** The enclosing declarator's name, or `<top>`. */
	readonly binding: string;
	/** `function:binding:name:form`, the admission key. */
	readonly key: string;
	/** How the name appears: `.member`, `callee()`, `call`, or the kind of the node holding it. */
	readonly form: string;
}

export interface FactoryFlagScan {
	/** Names of the functions whose bodies were scanned. */
	readonly population: readonly string[];
	/** Every refused site, admitted or not. */
	readonly sites: readonly FactoryFlagRead[];
	/** The sites no admission row covers, or every site of a key with more sites than its row admits. */
	readonly unadmitted: readonly FactoryFlagRead[];
	/** Admission keys with fewer sites than the row admits (a stale row). */
	readonly staleAdmissions: readonly string[];
}

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"function",
	"method_definition",
	"generator_function",
	"generator_function_declaration",
]);

/** Callee identifiers that defer the function they are handed. */
const DEFERRING_FUNCTIONS = new Set([
	"setTimeout",
	"setInterval",
	"setImmediate",
	"queueMicrotask",
]);

/** Member names that defer the function they are handed: host registrars. */
const DEFERRING_METHODS = new Set([
	"on",
	"once",
	"addListener",
	"addEventListener",
	"registerCommand",
	"registerTool",
	"registerFlag",
	"registerShortcut",
	"registerMessageRenderer",
	"registerProvider",
	"then",
	"catch",
	"finally",
]);

/** Expression wrappers that do not change what a function is passed to. */
const WRAPPER_KINDS = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
]);

const kindOf = (node: SgNode): string => String(node.kind());

const sameNode = (a: SgNode, b: SgNode): boolean =>
	a.range().start.index === b.range().start.index &&
	a.range().end.index === b.range().end.index &&
	kindOf(a) === kindOf(b);

/**
 * The nodes of a document-ordered array that start inside `outer`. The array
 * is a pre-order walk, so starts never decrease and one binary search plus a
 * forward run answers it; a rescan of the whole array per function was
 * quadratic over `index.ts` (about 100k nodes) and timed out.
 */
function within(nodes: readonly SgNode[], outer: SgNode): SgNode[] {
	const { start, end } = {
		start: outer.range().start.index,
		end: outer.range().end.index,
	};
	let low = 0;
	let high = nodes.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((nodes[mid] as SgNode).range().start.index < start) low = mid + 1;
		else high = mid;
	}
	const found: SgNode[] = [];
	for (
		let i = low;
		i < nodes.length && (nodes[i] as SgNode).range().start.index < end;
		i++
	)
		found.push(nodes[i] as SgNode);
	return found;
}

/** The identifier a declaration or declarator binds, if it has one. */
function boundName(node: SgNode): string | undefined {
	return node.field("name")?.text();
}

/** True when `child` is the node `parent` holds in field `name`. */
function isField(parent: SgNode, name: string, child: SgNode): boolean {
	const held = parent.field(name);
	return held !== null && sameNode(held, child);
}

function isFunctionValuedBinding(node: SgNode): boolean {
	if (kindOf(node) === "function_declaration") return true;
	if (kindOf(node) !== "variable_declarator") return false;
	const value = node.field("value");
	return value !== null && FUNCTION_KINDS.has(kindOf(value));
}

/** The function a module-level declaration or constant defines, if any. */
function moduleFunctionOf(node: SgNode): { name: string; fn: SgNode } | null {
	const parent = node.parent();
	if (!parent) return null;
	const atModule = (n: SgNode | null): boolean => {
		if (!n) return false;
		const holder = kindOf(n) === "export_statement" ? n.parent() : n;
		return holder !== null && kindOf(holder) === "program";
	};
	if (kindOf(node) === "function_declaration") {
		if (!atModule(parent)) return null;
		const name = boundName(node);
		return name ? { name, fn: node } : null;
	}
	if (kindOf(node) === "variable_declarator") {
		const declaration = parent;
		if (
			kindOf(declaration) !== "lexical_declaration" ||
			!atModule(declaration.parent())
		)
			return null;
		const value = node.field("value");
		const name = boundName(node);
		return value && name && FUNCTION_KINDS.has(kindOf(value))
			? { name, fn: value }
			: null;
	}
	return null;
}

/** A population function's reporting name; `<default>` for an inline default export. */
function nameOf(fn: SgNode): string {
	if (kindOf(fn) === "function_declaration")
		return boundName(fn) ?? "<anonymous>";
	let holder = fn.parent();
	while (holder && WRAPPER_KINDS.has(kindOf(holder))) holder = holder.parent();
	if (holder && kindOf(holder) === "export_statement") return "<default>";
	return holder && kindOf(holder) === "variable_declarator"
		? (boundName(holder) ?? "<anonymous>")
		: "<anonymous>";
}

/** True when `parent` is the node directly above `node`. */
function isChildOf(node: SgNode, parent: SgNode): boolean {
	const above = node.parent();
	return above !== null && sameNode(above, parent);
}

/** The node a module's default export names: its value, declaration or local name. */
function defaultExportValue(nodes: SgNode[]): SgNode {
	for (const statement of nodes) {
		if (kindOf(statement) !== "export_statement") continue;
		// `export default` always holds a declaration or a value.
		if (
			within(nodes, statement).some(
				(node) => kindOf(node) === "default" && isChildOf(node, statement),
			)
		)
			return (statement.field("declaration") ??
				statement.field("value")) as SgNode;
		const specifier = within(nodes, statement).find(
			(node) =>
				kindOf(node) === "export_specifier" &&
				(node.field("alias") ?? node.field("name"))?.text() === "default",
		);
		const local = specifier?.field("name");
		if (!local) continue;
		if (statement.field("source"))
			throw new Error(
				"factory-flag scan: the default export is re-exported from another module",
			);
		return local;
	}
	throw new Error("factory-flag scan: no default export found");
}

/**
 * The function pi calls as the factory: the default export's own node. An
 * inline function (through expression wrappers) is that node; a name
 * (`export default f`, `export { f as default }`) resolves to the module-level
 * function `f`. Anything else (a call, a class, a re-export, a name this module
 * does not define as a function) throws: the scan cannot say what runs, so it
 * does not pass (#4917 F6).
 */
function factoryFunction(
	nodes: SgNode[],
	moduleFunctions: ReadonlyMap<string, SgNode>,
): SgNode {
	let exported = defaultExportValue(nodes);
	// Each wrapper kind holds the expression it wraps as its first named child.
	while (WRAPPER_KINDS.has(kindOf(exported)))
		exported = within(nodes, exported).find(
			(node) => node.isNamed() && isChildOf(node, exported),
		) as SgNode;
	if (FUNCTION_KINDS.has(kindOf(exported))) return exported;
	const named =
		kindOf(exported) === "identifier"
			? moduleFunctions.get(exported.text())
			: undefined;
	if (!named)
		throw new Error(
			`factory-flag scan: the default export \`${exported.text()}\` is not a function this module defines`,
		);
	return named;
}

/** Every module-level function, by name. */
function moduleFunctionsOf(nodes: SgNode[]): Map<string, SgNode> {
	const moduleFunctions = new Map<string, SgNode>();
	for (const node of nodes) {
		const found = moduleFunctionOf(node);
		if (found && !moduleFunctions.has(found.name))
			moduleFunctions.set(found.name, found.fn);
	}
	return moduleFunctions;
}

/** The named nodes directly under `parent` (arguments, parameters), in order. */
function argumentsOf(nodes: SgNode[], parent: SgNode): SgNode[] {
	return within(nodes, parent).filter(
		(node) => node.isNamed() && isChildOf(node, parent),
	);
}

/** `fn`'s parameter at `index`: its bound node (an identifier or a pattern). */
function parameterAt(
	nodes: SgNode[],
	fn: SgNode,
	index: number,
): SgNode | undefined {
	const single = fn.field("parameter");
	if (single) return index === 0 ? single : undefined;
	const list = fn.field("parameters");
	const param = list ? argumentsOf(nodes, list)[index] : undefined;
	return param && kindOf(param) !== "identifier"
		? (param.field("pattern") ?? param)
		: param;
}

/** The outermost expression wrapper around `node` (`(pi as any)`), or `node`. */
function unwrapUp(node: SgNode): SgNode {
	let holder = node;
	for (
		let parent = holder.parent();
		parent && WRAPPER_KINDS.has(kindOf(parent));
		parent = holder.parent()
	)
		holder = parent;
	return holder;
}

/** True when `node` names a binding or a parameter rather than using one. */
function isDeclarationName(node: SgNode): boolean {
	const parent = node.parent() as SgNode;
	const parentKind = kindOf(parent);
	if (
		(parentKind === "variable_declarator" ||
			parentKind === "function_declaration") &&
		isField(parent, "name", node)
	)
		return true;
	if (parentKind === "arrow_function")
		return isField(parent, "parameter", node);
	return (
		parentKind === "formal_parameters" ||
		parentKind === "required_parameter" ||
		parentKind === "optional_parameter"
	);
}

/** True when `callee` is a known deferring registrar. */
function isDeferringCallee(callee: SgNode | null): boolean {
	if (!callee) return false;
	if (kindOf(callee) === "identifier")
		return DEFERRING_FUNCTIONS.has(callee.text());
	if (kindOf(callee) !== "member_expression") return false;
	const property = callee.field("property")?.text() ?? "";
	return DEFERRING_METHODS.has(property);
}

/**
 * True when the function only DEFERS its body (see the header): a declaration,
 * a function bound by a declarator, or one handed (directly or inside an
 * object literal argument) to a known deferring registrar. An immediately
 * invoked function is neither: its parent is the call that runs it. Every other
 * function is code that can run while the factory runs.
 */
function defersTheFunction(fn: SgNode): boolean {
	const fnKind = kindOf(fn);
	if (fnKind === "function_declaration") return true;
	if (fnKind === "generator_function_declaration") return true;
	let current: SgNode = fn;
	let viaObject = false;
	// Every kind the walk climbs through (a wrapper, a pair, an object, a call)
	// sits below the program node, so a parent always exists; the last
	// `return false` below is the fall-through for every other parent kind.
	for (;;) {
		const parent = current.parent() as SgNode;
		const parentKind = kindOf(parent);
		if (WRAPPER_KINDS.has(parentKind)) {
			current = parent;
			continue;
		}
		if (parentKind === "pair" && isField(parent, "value", current)) {
			current = parent;
			viaObject = true;
			continue;
		}
		if (parentKind === "object") {
			current = parent;
			viaObject = true;
			continue;
		}
		if (parentKind === "variable_declarator")
			return !viaObject && isField(parent, "value", current);
		if (parentKind === "arguments") {
			const call = parent.parent();
			if (!call || kindOf(call) !== "call_expression") return false;
			if (isDeferringCallee(call.field("function"))) return true;
			// `pi.on("x", wrap(async () => ..))`: a wrapper whose result is the
			// registrar's argument returns the handler it was given; follow the
			// wrapper call out to the registrar.
			current = call;
			viaObject = true;
			continue;
		}
		return false;
	}
}

/**
 * True when `node`, inside the function `root`, runs while `root` runs: no
 * function between them only defers its body.
 */
function runsWithin(node: SgNode, root: SgNode): boolean {
	for (let p = node.parent(); p && !sameNode(p, root); p = p.parent()) {
		if (FUNCTION_KINDS.has(kindOf(p)) && defersTheFunction(p)) return false;
	}
	return true;
}

/** The enclosing declarator's name, or `<top>`. */
function enclosingBinding(node: SgNode, root: SgNode): string {
	for (let p = node.parent(); p && !sameNode(p, root); p = p.parent()) {
		if (kindOf(p) === "variable_declarator") return boundName(p) ?? "<top>";
	}
	return "<top>";
}

/**
 * Classify one factory-time reference to a reader closure, or undefined when
 * it is admitted: handed to a call that stores it (a call argument, or a pair
 * value of an object-literal call argument).
 */
function closureForm(node: SgNode): string | undefined {
	if (kindOf(node) === "shorthand_property_identifier") return "shorthand";
	const parent = node.parent() as SgNode;
	const parentKind = kindOf(parent);
	if (parentKind === "call_expression" && isField(parent, "function", node))
		return "call";
	if (parentKind === "arguments") {
		// The argument of `new Promise(..)` or any other construct is not a
		// stored callback: only a call hands a reader to a callee.
		return kindOf(parent.parent() as SgNode) === "call_expression"
			? undefined
			: "new-argument";
	}
	if (parentKind === "pair" && isField(parent, "value", node)) {
		const around = parent.parent()?.parent();
		const call = around?.parent();
		return around &&
			kindOf(around) === "arguments" &&
			call &&
			kindOf(call) === "call_expression"
			? undefined
			: "pair-value";
	}
	return parentKind;
}

/**
 * Scan one source text. `admissions` carries the refused sites the tree
 * admits, each key with its site count and reason.
 */
export function scanFactoryFlagReads(
	source: string,
	admissions: FactoryFlagAdmission = {},
): FactoryFlagScan {
	const nodes = parseNodes(stripSource(source));
	const moduleFunctions = moduleFunctionsOf(nodes);
	const seed = factoryFunction(nodes, moduleFunctions);
	const site = (
		fn: SgNode,
		node: SgNode,
		reader: string,
		form: string,
	): FactoryFlagRead => {
		const binding = enclosingBinding(node, fn);
		return {
			line: node.range().start.line + 1,
			reader,
			binding,
			key: `${nameOf(fn)}:${binding}:${reader}:${form}`,
			form,
		};
	};

	/** The names holding `pi` in `fn` entered with `pi` at `indexes`, plus the sites a destructured parameter makes. */
	const enter = (fn: SgNode, indexes: Iterable<number>) => {
		const pi = new Set<string>();
		const sites: FactoryFlagRead[] = [];
		for (const index of indexes) {
			// `arguments[0]` is `pi` too, in any function that has its own.
			if (kindOf(fn) !== "arrow_function") pi.add("arguments");
			const param = parameterAt(nodes, fn, index);
			if (param && kindOf(param) === "identifier") pi.add(param.text());
			else if (param) sites.push(site(fn, param, "pi", kindOf(param)));
		}
		return { pi, sites };
	};

	const readsMemo = new Map<string, boolean>();
	/** True when running `fn`, with `pi` the names holding pi, makes a refused use. */
	const reads = (
		fn: SgNode,
		pi: ReadonlySet<string>,
		closures: ReadonlyMap<string, SgNode>,
	): boolean => {
		const key = `${fn.range().start.index}|${[...pi].sort().join(",")}`;
		const known = readsMemo.get(key);
		if (known !== undefined) return known;
		readsMemo.set(key, false);
		const found =
			usesIn(fn, new Set(pi), closures, (callee, index) =>
				readsModule(callee, index) ? "call" : undefined,
			).length > 0;
		readsMemo.set(key, found);
		return found;
	};
	const readsModule = (callee: SgNode, index: number): boolean => {
		const entered = enter(callee, [index]);
		return (
			entered.sites.length > 0 ||
			reads(callee, entered.pi, localClosures(callee))
		);
	};
	const localClosures = (fn: SgNode): Map<string, SgNode> => {
		const closures = new Map<string, SgNode>();
		for (const node of within(nodes, fn)) {
			const name = boundName(node);
			if (sameNode(node, fn) || !name || !isFunctionValuedBinding(node))
				continue;
			closures.set(
				name,
				kindOf(node) === "variable_declarator"
					? (node.field("value") as SgNode)
					: node,
			);
		}
		return closures;
	};

	/**
	 * The refused uses a run of `fn` makes. `intoModule` answers a module-level
	 * function handed `pi` (form A2): the population pass enqueues it, the
	 * reader check asks whether it reads.
	 */
	const usesIn = (
		fn: SgNode,
		pi: Set<string>,
		closures: ReadonlyMap<string, SgNode>,
		intoModule: (callee: SgNode, index: number) => string | undefined,
	): FactoryFlagRead[] => {
		const sites: FactoryFlagRead[] = [];
		for (const node of within(nodes, fn)) {
			const kind = kindOf(node);
			if (kind !== "identifier" && kind !== "shorthand_property_identifier")
				continue;
			const name = node.text();
			const closure = pi.has(name) ? undefined : closures.get(name);
			if (!pi.has(name) && !closure) continue;
			if (isDeclarationName(node) || !runsWithin(node, fn)) continue;
			const form = closure
				? reads(closure, pi, closures)
					? closureForm(node)
					: undefined
				: piForm(node, pi, intoModule);
			if (form !== undefined) sites.push(site(fn, node, name, form));
		}
		return sites;
	};

	/** Classify one factory-time use of `pi`, or undefined when the allowlist admits it. */
	const piForm = (
		node: SgNode,
		pi: Set<string>,
		intoModule: (callee: SgNode, index: number) => string | undefined,
	): string | undefined => {
		if (kindOf(node) === "shorthand_property_identifier") return "shorthand";
		const holder = unwrapUp(node);
		const parent = holder.parent() as SgNode;
		// A1: a registrar member, called or read.
		if (kindOf(parent) === "member_expression") {
			const member = (parent.field("property") as SgNode).text();
			return HOST_REGISTRARS.has(member) ? undefined : `.${member}`;
		}
		if (kindOf(parent) !== "arguments") return kindOf(parent);
		const call = parent.parent() as SgNode;
		const callee = call.field("function");
		const calleeName =
			callee && kindOf(callee) === "identifier" ? callee.text() : "";
		// A2: handed to a module-level function, which is scanned with it.
		const helper = moduleFunctions.get(calleeName);
		if (helper)
			return intoModule(
				helper,
				argumentsOf(nodes, parent).findIndex((arg) => sameNode(arg, holder)),
			);
		// A3: `const x = withConsoleCaptureWindows(pi)`: `x` is `pi`.
		const declarator = call.parent() as SgNode;
		const alias = declarator.field("name") as SgNode;
		if (
			PI_WRAPPERS.has(calleeName) &&
			kindOf(declarator) === "variable_declarator" &&
			kindOf(alias) === "identifier"
		) {
			pi.add(alias.text());
			return undefined;
		}
		return calleeName ? `${calleeName}()` : "arguments";
	};

	// The population pass: the default export entered with `pi` as its first
	// parameter, then every module-level function a run hands `pi` to (A2). A
	// function nobody hands `pi` holds no `pi` to use.
	const indexesOf = new Map<SgNode, Set<number>>();
	const sitesOf = new Map<SgNode, FactoryFlagRead[]>();
	const queue: SgNode[] = [];
	const enqueue = (fn: SgNode, index: number): undefined => {
		const indexes = indexesOf.get(fn) ?? new Set<number>();
		indexesOf.set(fn, indexes);
		if (!indexes.has(index)) queue.push(fn);
		indexes.add(index);
		return undefined;
	};
	enqueue(seed, 0);
	for (let fn = queue.shift(); fn; fn = queue.shift()) {
		const entered = enter(fn, indexesOf.get(fn) as Set<number>);
		sitesOf.set(fn, [
			...entered.sites,
			...usesIn(fn, entered.pi, localClosures(fn), enqueue),
		]);
	}
	const sites = [...sitesOf.values()].flat();
	const live = new Map<string, number>();
	for (const read of sites) live.set(read.key, (live.get(read.key) ?? 0) + 1);
	return {
		population: [...indexesOf.keys()].map(nameOf),
		sites,
		unadmitted: sites.filter(
			(read) =>
				(live.get(read.key) as number) > (admissions[read.key]?.count ?? 0),
		),
		staleAdmissions: Object.keys(admissions).filter(
			(key) => (live.get(key) ?? 0) < admissions[key].count,
		),
	};
}
