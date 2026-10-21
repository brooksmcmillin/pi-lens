/**
 * Ratchet scan for hand-rolled at-most-one-in-flight state — #1753.
 *
 * `clients/single-flight.ts` owns the four guards that the ten hand-rolled
 * copies kept getting wrong (#1690, #1674, #1687, #1722). A primitive nobody
 * reaches for is a primitive that decays, so this scan makes the NEXT copy
 * argue for itself: any new module-level or class-field declaration whose name
 * contains `inFlight` fails until it is either built on the primitive or listed
 * with a reason.
 *
 * It is a ratchet, not a migration. Everything the scan finds today is listed;
 * the list is the burn-down backlog, and each entry says why it is still there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { clientSourceFiles, clientsRelative } from "./session-state-scan.js";

/** One `inFlight`-named declaration the scan found. */
export interface InFlightDeclaration {
	/** `clients/`-relative posix path. */
	file: string;
	/** The declared identifier. */
	symbol: string;
	/** 1-based line number in the original source. */
	line: number;
	/** `file:symbol` — the key exemptions are written against. */
	key: string;
}

/** Every `inFlight` spelling in one source, classified or reported. */
export interface InFlightScan {
	declarations: InFlightDeclaration[];
	/** `unclassified spelling at <file>:<line>: <text> (<kind> under <parent>)`. */
	unclassified: string[];
}

/**
 * What the scan classifies (#4429: a population-deriving scanner fails closed).
 *
 * The needle is every identifier-like syntax node whose name contains
 * `inFlight` or `InFlight`, read from the TypeScript AST, so a comment or a
 * string that names one is not a node and never counts. Each node lands in
 * exactly one role, decided by the grammar position it fills:
 *
 * - `state`, counted: a variable declarator's binding outside every function
 *   (module state, destructured or not), a class field (any modifier set,
 *   `#private`, annotated or not, or a constructor parameter property), an
 *   interface or type member, and an
 *   object-literal key (the false-positive direction, kept from the regex scan
 *   this replaced: a person dismisses it with one exemption line).
 * - `local`: a binding inside a function (a plain parameter, a function-scoped
 *   declarator, a `catch` or `for…of` binding). State a factory closes over is
 *   the documented false negative: by shape it is any function local.
 * - `name`: the name of a function, method, class, interface, type or enum.
 * - `reference`: a read, a call, an assignment to an existing binding (the
 *   clear-in-finally), a member access, an import or export specifier, a type
 *   reference.
 *
 * A node in any other position is UNCLASSIFIED and reported with its file and
 * line, never skipped: a declaration form this table does not know must red
 * until it is classified here. The regex scan this replaced missed
 * `override`, `declare` and `accessor` fields, unannotated fields and
 * multi-declarator lines, and said nothing.
 */
const NEEDLE_KINDS = [
	"identifier",
	"property_identifier",
	"private_property_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
	"type_identifier",
] as const;

type Role = "state" | "local" | "name" | "reference";

/** Parents whose child identifier is always an expression or type use. */
const REFERENCE_PARENTS = new Set([
	"arguments",
	"array",
	"arrow_function",
	"as_expression",
	"assignment_expression",
	"augmented_assignment_expression",
	"await_expression",
	"binary_expression",
	"call_expression",
	"export_specifier",
	"expression_statement",
	"generic_type",
	"import_specifier",
	"member_expression",
	"new_expression",
	"non_null_expression",
	"object",
	"parenthesized_expression",
	"return_statement",
	"satisfies_expression",
	"sequence_expression",
	"spread_element",
	"subscript_expression",
	"template_substitution",
	"ternary_expression",
	"throw_statement",
	"type_annotation",
	"type_arguments",
	"type_query",
	"unary_expression",
	"union_type",
	"update_expression",
	"yield_expression",
]);

/** Declarations whose `name` field is a callable or type name, not state. */
const NAME_PARENTS = new Set([
	"abstract_class_declaration",
	"class_declaration",
	"enum_declaration",
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"interface_declaration",
	"method_definition",
	// A method SIGNATURE declares a callable, like `method_definition`, not a
	// field of at-a-time state: `hasNotifyInFlight?(filePath): boolean`
	// (`LSPClient`, #4532 gap 9 round 3) asks the queue a question.
	"method_signature",
	"type_alias_declaration",
]);

/** Ancestors that make a binding function-scoped. */
const FUNCTION_SCOPES = new Set([
	"arrow_function",
	"class_static_block",
	"function_declaration",
	"function_expression",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

/** Parameter children that make a constructor parameter a class field. */
const PARAMETER_PROPERTY_MODIFIERS = new Set([
	"accessibility_modifier",
	"override_modifier",
	"readonly",
]);

/** Destructuring wrappers a binding can sit inside. */
const PATTERN_KINDS = new Set([
	"array_pattern",
	"assignment_pattern",
	"object_assignment_pattern",
	"object_pattern",
	"pair_pattern",
	"rest_pattern",
]);

function sameNode(a: SgNode | null | undefined, b: SgNode): boolean {
	if (!a) return false;
	const ra = a.range();
	const rb = b.range();
	return ra.start.index === rb.start.index && ra.end.index === rb.end.index;
}

function insideFunction(node: SgNode): boolean {
	for (let up = node.parent(); up; up = up.parent()) {
		if (FUNCTION_SCOPES.has(String(up.kind()))) return true;
	}
	return false;
}

/** The role of a binding nested in a destructuring pattern, or undefined. */
function patternBindingRole(node: SgNode): Role | undefined {
	let child = node;
	let up = node.parent();
	while (up && PATTERN_KINDS.has(String(up.kind()))) {
		child = up;
		up = up.parent();
	}
	if (!up) return undefined;
	const kind = String(up.kind());
	if (kind === "variable_declarator" && sameNode(up.field("name"), child)) {
		return insideFunction(up) ? "local" : "state";
	}
	if (
		(kind === "required_parameter" || kind === "optional_parameter") &&
		sameNode(up.field("pattern"), child)
	) {
		return "local";
	}
	return undefined;
}

function roleOf(node: SgNode): Role | undefined {
	const parent = node.parent();
	if (!parent) return undefined;
	const kind = String(parent.kind());
	const fills = (field: string) => sameNode(parent.field(field), node);
	if (node.kind() === "shorthand_property_identifier_pattern") {
		return patternBindingRole(node);
	}
	if (PATTERN_KINDS.has(kind)) return patternBindingRole(node);
	switch (kind) {
		case "variable_declarator":
			if (!fills("name")) return "reference";
			return insideFunction(parent) ? "local" : "state";
		case "public_field_definition":
		case "property_signature":
			return fills("name") ? "state" : "reference";
		case "pair":
			return fills("key") ? "state" : "reference";
		case "required_parameter":
		case "optional_parameter":
			if (!fills("pattern")) return "reference";
			// A constructor parameter with an accessibility, `readonly` or
			// `override` modifier is a parameter property: a class field.
			return parent
				.children()
				.some((child) => PARAMETER_PROPERTY_MODIFIERS.has(String(child.kind())))
				? "state"
				: "local";
		case "catch_clause":
			// The grammar puts only the binding directly under the clause.
			return "local";
		case "for_in_statement":
			// `for (const x of y)` binds `x`; `for (x of y)` assigns an existing one.
			if (!fills("left")) return "reference";
			return parent.field("kind") ? "local" : "reference";
	}
	if (NAME_PARENTS.has(kind)) return fills("name") ? "name" : undefined;
	if (REFERENCE_PARENTS.has(kind)) return "reference";
	return undefined;
}

const NEEDLE_TEXT = /[iI]nFlight/;

/** Classify every `inFlight` spelling in one source text. */
export function classifyInFlightSpellings(
	file: string,
	source: string,
): InFlightScan {
	const scan: InFlightScan = { declarations: [], unclassified: [] };
	if (!NEEDLE_TEXT.test(source)) return scan;
	const lines = source.split("\n");
	const root = parse(Lang.TypeScript, source).root();
	const nodes = root.findAll({
		rule: {
			any: NEEDLE_KINDS.map((kind) => ({ kind, regex: NEEDLE_TEXT.source })),
		},
	});
	for (const node of nodes) {
		const line = node.range().start.line + 1;
		const role = roleOf(node);
		if (role === undefined) {
			scan.unclassified.push(
				`unclassified spelling at ${file}:${line}: ${lines[line - 1]?.trim() ?? ""} (${node.kind()} under ${node.parent()?.kind()})`,
			);
			continue;
		}
		if (role !== "state") continue;
		const symbol = node.text().replace(/^#/, "");
		scan.declarations.push({ file, symbol, line, key: `${file}:${symbol}` });
	}
	scan.declarations.sort((a, b) => a.line - b.line);
	return scan;
}

/** Find every `inFlight`-named module-state declaration in one source text. */
export function findInFlightDeclarations(
	file: string,
	source: string,
): InFlightDeclaration[] {
	return classifyInFlightSpellings(file, source).declarations;
}

/** The module that owns the primitive, which is exempt by definition. */
const PRIMITIVE_MODULE = "single-flight.ts";

/** Classify every `inFlight` spelling in every `clients/` source. */
export function scanInFlightSpellings(): InFlightScan {
	const total: InFlightScan = { declarations: [], unclassified: [] };
	for (const absolute of clientSourceFiles()) {
		const file = clientsRelative(absolute);
		if (path.posix.basename(file) === PRIMITIVE_MODULE) continue;
		const scan = classifyInFlightSpellings(
			file,
			fs.readFileSync(absolute, "utf8"),
		);
		total.declarations.push(...scan.declarations);
		total.unclassified.push(...scan.unclassified);
	}
	return total;
}

/** Scan every `clients/` source for hand-rolled in-flight declarations. */
export function scanInFlightDeclarations(): InFlightDeclaration[] {
	return scanInFlightSpellings().declarations;
}
