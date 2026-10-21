/**
 * #4596: find every `catch` handler in a source text and derive whether a
 * failure it swallows is still observable. The ratchet that runs this over the
 * shipped trees is `tests/config/silent-catch-sweep.test.ts`; its header holds
 * the state table this rule implements.
 *
 * Recurrence (AGENTS.md shape 31, "pull-only observability"; the 2026-10-18
 * audit of 53 merged fixes): a runtime failure path ended in a bare
 * `catch { return "unknown" }`, `catch { continue; }` or
 * `.catch(() => {})`, so the shipped failure left no row in any log. Two of
 * them recorded an event that never happened: `deleted: 1` for a file that
 * still existed, and `failureKind: "success"` for a rejected save.
 *
 * What a site is:
 * - a `catch` clause of a `try` statement;
 * - the handler of a `<expr>.catch(…)` call, written as `.catch` or as a
 *   statically known subscript (`p["catch"](…)`, `` p[`catch`](…) ``);
 * - the SECOND argument of `<expr>.then(onOk, onRejected)`, which is the
 *   rejection handler an author reached for instead of `.catch`;
 * - a rejection member reached indirectly — `p.catch.call(…)`,
 *   `p.catch.apply(…)`, `p.catch.bind(…)`, or a local binding of `p.catch`
 *   that is then called — which is a site too, but `unclassified`: the scan
 *   cannot tell which argument is the handler (AGENTS.md shape 69).
 *
 * The rule, derived and never a hand list:
 * - A handler is `recorded` only when a record seam runs on the path the
 *   failure takes: the call must sit at the handler's top level (no
 *   conditional, loop, `try`, ternary or short-circuit between it and the
 *   handler body) and before any unconditional exit. A record behind
 *   `if (DEBUG)` publishes nothing on the path that swallows, so it is
 *   `silent`. A record seam is a call whose simple callee follows the repo's
 *   `record…`/`log…`/`increment…` naming convention.
 * - A handler `rethrows` only when a `throw` runs on every path through it:
 *   the `throw` must be unconditional in the same sense, and no `return`,
 *   `continue` or `break` may exist anywhere in the handler. A `throw` inside
 *   `if (fatal)` leaves the other branch swallowing, so the handler is
 *   `silent`.
 * - Any other handler is `silent` unless a comment carries `none: <reason>`,
 *   which makes it `declared-none` and states why the failure needs no row (a
 *   deliberate skip, an idempotent teardown). The marker counts only inside the
 *   handler actually judged — the `then` rejection argument for a `.then`, the
 *   handler for a `.catch`, the clause body for a `catch` — or on the comment
 *   line immediately above a handler that starts its own line. A marker in a SIBLING argument
 *   (`then(ok, …)` with the comment on `ok`) or inside a nested function the
 *   failure can never reach is NOT this handler's reason (#4603 review N1).
 * - A `.catch(…)` handler that is not a function this file can resolve
 *   (including an unresolved identifier or member) is `unclassified`, which
 *   fails loud in the ratchet and is never counted as recorded. A statically
 *   known subscript key that cannot be resolved (a template with a
 *   substitution, a concatenation, a file-local binding to a non-constant
 *   string) is `unclassified` too: the scan cannot rule out that it names a
 *   rejection handler.
 *
 * The scan parses comment-and-string-blanked source (`stripSource`, the
 * default `strings: "blank"` policy): a `catch` written in a comment is blank
 * before the parse, and a call named inside a string is not a call. The
 * `none:` marker is read from the RAW source and only counts where BOTH
 * strippings blanked the character, so a marker inside a string or in code is
 * not a comment.
 *
 * Handler names resolve in the scope the call sits in (the nearest enclosing
 * block that declares the name), never by a bare name index across the file:
 * an inner `function handler` shadowing an outer one is the inner one, and a
 * name declared twice in one scope is `unclassified` rather than a guess.
 *
 * Known limits, named: a record seam passed but never called
 * (`{ onError: logX }`) does not count, because only call expressions are
 * read; a handler that delegates to an identifier is followed to the
 * declaration visible at the call, and a delegation to an import, a member
 * expression or a parameter is `unclassified`, never `recorded`; an
 * indexed call whose key is a variable the file never binds (`arr[i]()`) is
 * not matched, because it is not evidence of a rejection handler and calling
 * every indexed call a handler would fail closed on the whole tree. An
 * indirect rejection member (`p.catch.call(…)`, `.apply`, `.bind`, a local
 * binding of `p.catch`) is a site but `unclassified`, never absent and never
 * guessed: the scan cannot tell which argument is the handler (#4603 review
 * N2). A member reached through a destructuring pattern (`const { catch: c } =
 * p`) or a later assignment to an existing binding is a residual the binding
 * pre-filter does not see; composed values (`p.catch || fallback`, ternaries,
 * `??`) and cross-file callee bindings/re-exports are residuals too (#4607).
 * The declaration form (`const c = p.catch`), including parentheses, is seen.
 */

import { createHash } from "node:crypto";
import { parseRoot, walkAst } from "./ast-census.js";
import { stripSource } from "./sweep-kit.js";

/** The napi node type is untyped, exactly as the sibling sweeps walk it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

/**
 * The repo's record-seam naming convention: `recordDegradationOnce`,
 * `incrementDegradationCount`, `logLatency`, `logCascade`, a logger's
 * `logX`. Deliberately a convention, not a hand list of the tree's exporters
 * (shape 34): a logger added tomorrow is admitted without editing this file,
 * and a handler that calls one publishes instead of swallowing.
 */
const RECORD_SEAM = /^(?:record|log|increment)[A-Z]\w*$/;

/** `// none: <reason>` or a block-comment `none: <reason>`. */
const NONE_MARKER = /\/\/\s*none:\s*\S|\/\*\s*none:\s*\S/g;

/**
 * Nodes that can skip the code under them on some path. `binary_expression`
 * joins them only for the short-circuit operators, handled in
 * {@link isConditional}. A nested `try`/`catch` counts: its own `catch` can
 * swallow a record seam's failure, and its body may not be reached at all.
 */
const CONDITIONAL_KINDS = new Set([
	"if_statement",
	"else_clause",
	"switch_statement",
	"switch_body",
	"switch_case",
	"switch_default",
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
	"ternary_expression",
	"try_statement",
	"catch_clause",
]);

/** The operators that run their right side only on some values. */
const SHORT_CIRCUIT = new Set(["&&", "||", "??"]);

/** Statements that leave the handler (or the failure) behind. */
const EXIT_KINDS = new Set([
	"return_statement",
	"continue_statement",
	"break_statement",
	"throw_statement",
]);

export type CatchVerdict =
	/** A record seam runs on the path the failure takes. */
	| "recorded"
	/** The handler rethrows on every path: the failure reaches the caller. */
	| "rethrows"
	/** The handler carries a `none: <reason>` comment. */
	| "declared-none"
	/** The handler swallows with no record and no stated reason. */
	| "silent"
	/** The handler is not a form this scan can follow. */
	| "unclassified";

export interface CatchSite {
	/** 1-based line of the `catch` keyword or the `.catch` property. */
	line: number;
	form: "catch-clause" | "promise-catch" | "promise-then";
	verdict: CatchVerdict;
	/** Record-seam callees the handler calls, in source order. */
	records: string[];
	/** First line of the handler, for a census a reader can act on. */
	snippet: string;
	/**
	 * Content identity of the handler: 8 hex of the whitespace-collapsed raw
	 * handler text. The ratchet pins this per site, so one silent handler added
	 * while another is removed cannot cancel out (AGENTS.md shape 36).
	 */
	identity: string;
	/** Why the site is `unclassified`; absent otherwise. */
	problem?: string;
}

/** Descendants of `node`, not descending into nested functions. */
function walkOwnBody(node: SgNode, visit: (node: SgNode) => void): void {
	for (const child of node.children()) {
		visit(child);
		if (!FUNCTION_KINDS.has(child.kind())) walkOwnBody(child, visit);
	}
}

/** The simple callee name of a call, for a plain or member call. */
function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression")
		return fn.field("property")?.text() ?? undefined;
	return undefined;
}

/**
 * Whether two nodes are the same source span. The napi binding hands back a
 * fresh wrapper on every field read, so identity is the range, not the object.
 */
function sameNode(a: SgNode, b: SgNode): boolean {
	const left = a.range();
	const right = b.range();
	return (
		left.start.index === right.start.index && left.end.index === right.end.index
	);
}

function isConditional(node: SgNode): boolean {
	if (CONDITIONAL_KINDS.has(node.kind())) return true;
	if (node.kind() !== "binary_expression") return false;
	const operator = node.field("operator")?.text();
	return operator !== undefined && SHORT_CIRCUIT.has(operator);
}

/**
 * Whether `node` runs on every path through `body`: no conditional, loop,
 * `try` or short-circuit sits between them. An arrow handler whose body IS
 * the expression (`(e) => logX(e)`) is unconditional by construction.
 */
function isUnconditional(body: SgNode, node: SgNode): boolean {
	if (sameNode(node, body)) return true;
	let cursor = node.parent();
	while (cursor !== undefined && cursor !== null) {
		if (sameNode(cursor, body)) return true;
		if (isConditional(cursor)) return false;
		cursor = cursor.parent();
	}
	return false;
}

/** The earliest statement that leaves the handler, conditional or not. */
function firstExit(body: SgNode): number | undefined {
	let earliest: number | undefined;
	walkOwnBody(body, (node: SgNode) => {
		if (!EXIT_KINDS.has(node.kind())) return;
		const at = node.range().start.index;
		if (earliest === undefined || at < earliest) earliest = at;
	});
	return earliest;
}

/** Record-seam calls that run on the path the failure takes. */
function unconditionalRecords(body: SgNode): string[] {
	const exits = firstExit(body);
	const records: string[] = [];
	const visitCall = (node: SgNode) => {
		if (node.kind() !== "call_expression") return;
		const name = calleeName(node);
		if (name === undefined || !RECORD_SEAM.test(name)) return;
		if (!isUnconditional(body, node)) return;
		const at = node.range().start.index;
		if (exits !== undefined && at > exits) return;
		records.push(name);
	};
	visitCall(body);
	walkOwnBody(body, visitCall);
	return records;
}

/**
 * Whether this handler lets the failure out on every path its own body takes.
 * The approximate clause rule is deliberate (this scan has no control-flow
 * graph) and it errs toward `silent`: a `throw` behind a conditional, beside
 * a `return`/`continue`/`break` anywhere, or inside a nested `try` is a
 * partial rethrow, and a partial rethrow asks for a record or a `none:` line.
 */
function rethrows(body: SgNode): boolean {
	let throws = false;
	let swallows = false;
	walkOwnBody(body, (child: SgNode) => {
		const kind = child.kind();
		if (kind === "throw_statement") {
			if (isUnconditional(body, child)) throws = true;
			return;
		}
		if (
			kind === "return_statement" ||
			kind === "continue_statement" ||
			kind === "break_statement"
		)
			swallows = true;
	});
	return throws && !swallows;
}

interface Strippings {
	raw: string;
	commentsBlanked: string;
	stringsBlanked: string;
}

/**
 * The ranges of the function bodies NESTED inside `scope`, which its `none:`
 * marker may not use: a comment in code the failure can never reach does not
 * explain the handler (#4603 review N1). The outer range covers an inner one,
 * so a function's body is recorded and its own nested functions skipped.
 */
function nestedFunctionSpans(scope: SgNode): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const collect = (current: SgNode): void => {
		for (const child of current.children()) {
			if (FUNCTION_KINDS.has(child.kind())) {
				const range = child.range();
				spans.push([range.start.index, range.end.index]);
				continue;
			}
			collect(child);
		}
	};
	collect(scope);
	return spans;
}

/**
 * The whole-line span immediately above `index`, when that line holds only a
 * comment or whitespace (`commentsBlanked` keeps the code and blanks the
 * comment, so a line with code survives the trim). The handler must itself
 * start its line; a marker above an enclosing statement is not its reason.
 */
function commentLineAbove(
	strippings: Strippings,
	index: number,
): [number, number] | undefined {
	const lineStart = strippings.raw.lastIndexOf("\n", index - 1) + 1;
	if (lineStart === 0) return undefined;
	if (strippings.raw.slice(lineStart, index).trim() !== "") return undefined;
	const previousStart = strippings.raw.lastIndexOf("\n", lineStart - 2) + 1;
	const previousEnd = lineStart - 1;
	if (previousEnd <= previousStart) return undefined;
	if (
		strippings.commentsBlanked.slice(previousStart, previousEnd).trim() !== ""
	)
		return undefined;
	return [previousStart, previousEnd];
}

/**
 * Whether the handler judged by `scope` carries a `none: <reason>` marker at a
 * COMMENT position within its own range — the `then` rejection argument, the
 * `.catch` handler, or the clause body — excluding nested function bodies, or
 * on the comment line immediately above it. Both strippings blank a comment
 * and nothing else in common, so a marker blanked in both is a comment: one
 * inside a string survives the `strings: "keep"` pass and is refused.
 */
function declaredNone(strippings: Strippings, scope: SgNode): boolean {
	const range = scope.range();
	const nested = nestedFunctionSpans(scope);
	const ranges: Array<[number, number]> = [
		[range.start.index, range.end.index],
	];
	const above = commentLineAbove(strippings, range.start.index);
	if (above !== undefined) ranges.push(above);
	for (const [start, end] of ranges) {
		const span = strippings.raw.slice(start, end);
		NONE_MARKER.lastIndex = 0;
		let match: RegExpExecArray | null = NONE_MARKER.exec(span);
		while (match !== null) {
			const at = start + (match.index ?? 0);
			const inNested = nested.some(([from, to]) => at >= from && at < to);
			if (
				!inNested &&
				strippings.commentsBlanked[at] === " " &&
				strippings.stringsBlanked[at] === " "
			)
				return true;
			match = NONE_MARKER.exec(span);
		}
	}
	return false;
}

/**
 * The declarations of `name` visible in `scope` itself: its direct statements,
 * and its own function name when it is the declaration being named (a
 * recursive reference). Declarations inside a nested function belong to that
 * function's scope, so they are not collected here.
 */
function declaredIn(scope: SgNode, name: string): SgNode[] {
	const found: SgNode[] = [];
	const binding = (pattern: SgNode | undefined): boolean => {
		if (!pattern) return false;
		if (
			["identifier", "shorthand_property_identifier_pattern"].includes(
				pattern.kind(),
			)
		)
			return pattern.text() === name;
		if (["required_parameter", "optional_parameter"].includes(pattern.kind()))
			return binding(pattern.field("pattern"));
		if (pattern.kind() === "assignment_pattern")
			return binding(pattern.field("left"));
		if (pattern.kind() === "pair_pattern")
			return binding(pattern.field("value"));
		if (
			[
				"formal_parameters",
				"object_pattern",
				"array_pattern",
				"rest_pattern",
				"object_assignment_pattern",
			].includes(pattern.kind())
		)
			return pattern.namedChildren().some((child: SgNode) => binding(child));
		return false;
	};
	if (FUNCTION_KINDS.has(scope.kind()) || scope.kind() === "catch_clause") {
		const parameters = scope.field("parameters") ?? scope.field("parameter");
		if (parameters && binding(parameters)) found.push(parameters);
		return found;
	}
	if (!["program", "statement_block"].includes(scope.kind())) return found;
	const collect = (node: SgNode): void => {
		if (node.kind() === "function_declaration") {
			if (node.field("name")?.text() === name) found.push(node);
			return;
		}
		if (node.kind() === "variable_declarator") {
			if (binding(node.field("name"))) found.push(node);
			return;
		}
		if (
			FUNCTION_KINDS.has(node.kind()) ||
			node.kind() === "statement_block" ||
			node.kind() === "catch_clause"
		)
			return;
		for (const child of node.namedChildren()) collect(child);
	};
	for (const child of scope.namedChildren()) collect(child);
	return found;
}

/**
 * The handler declaration visible where the call sits, as a scope-aware
 * lookup: the nearest enclosing node that declares the name wins. More than
 * one declaration in that scope is ambiguous, and the scan says so instead of
 * picking one.
 */
function resolveHandlerIdentifier(
	identifier: SgNode,
	callSite: SgNode,
): { declaration?: SgNode; ambiguous?: boolean } {
	const name = identifier.text();
	let cursor = callSite.parent();
	while (cursor !== undefined && cursor !== null) {
		const found = declaredIn(cursor, name);
		if (found.length > 1) return { ambiguous: true };
		if (found.length === 1) return { declaration: found[0] };
		cursor = cursor.parent();
	}
	return {};
}

/** The function node a declaration introduces, when its value is one. */
function declaredFunction(declaration: SgNode): SgNode | undefined {
	if (declaration.kind() === "function_declaration") return declaration;
	const value = declaration.field("value");
	return value && FUNCTION_KINDS.has(value.kind()) ? value : undefined;
}

/**
 * One handler body's verdict. `body` is the function body whose statements are
 * judged; `markerScope` is the node whose own range a `none:` marker may live
 * in — the `then` rejection argument, the `.catch` handler, or the clause —
 * so a marker on a sibling argument or in a nested closure is not borrowed.
 */
function judge(
	body: SgNode | undefined,
	markerScope: SgNode | undefined,
	strippings: Strippings,
): { verdict: CatchVerdict; records: string[] } {
	if (body) {
		const records = unconditionalRecords(body);
		if (records.length > 0) return { verdict: "recorded", records };
		if (rethrows(body)) return { verdict: "rethrows", records: [] };
	}
	if (markerScope !== undefined && declaredNone(strippings, markerScope))
		return { verdict: "declared-none", records: [] };
	return { verdict: "silent", records: [] };
}

function firstLine(text: string): string {
	return text.split("\n")[0].trim();
}

/** 8 hex of the whitespace-collapsed raw handler text. */
function handlerIdentity(raw: string, start: number, end: number): string {
	const collapsed = raw.slice(start, end).replace(/\s+/g, " ").trim();
	return createHash("sha256").update(collapsed).digest("hex").slice(0, 8);
}

/** A statically known string value, or why the scan cannot resolve one. */
type StaticKey =
	| { value: string }
	/** Provably a string, but not one this scan can read. */
	| { unresolved: string }
	/** Not evidence of a property name at all (`arr[i]`, `map[0]`). */
	| Record<string, never>;

/** The raw source text a parsed node spans, as the unstripped file wrote it. */
function rawText(raw: string, node: SgNode): string {
	const range = node.range();
	return raw.slice(range.start.index, range.end.index);
}

/** Unquote a string literal, or refuse one whose escapes hide its value. */
function stringLiteralValue(text: string): StaticKey {
	const body = text.slice(1, -1);
	if (body.includes("\\"))
		return {
			unresolved: `string key ${text} carries an escape sequence the scan does not decode`,
		};
	return { value: body };
}

/** The static string a key expression yields, when it yields one. */
function staticKey(
	key: SgNode,
	callSite: SgNode,
	raw: string,
	depth = 0,
): StaticKey {
	const kind = key.kind();
	// The parse reads a STRING-BLANKED copy (`strings: "blank"`), so a quoted
	// key parses as spaces. Its range still points at the raw text.
	if (kind === "string") return stringLiteralValue(rawText(raw, key));
	if (kind === "template_string") {
		const text = rawText(raw, key);
		if (text.includes("${"))
			return {
				unresolved: `template key ${text} is computed, so the scan cannot rule out a rejection handler`,
			};
		return stringLiteralValue(text);
	}
	if (kind === "binary_expression") {
		const operator = key.field("operator")?.text();
		if (operator !== "+") return {};
		return {
			unresolved: `concatenated key ${rawText(raw, key)} is a string the scan cannot resolve`,
		};
	}
	if (kind !== "identifier" || depth > 2) return {};
	const resolved = resolveHandlerIdentifier(key, callSite);
	if (resolved.ambiguous)
		return { unresolved: `key \`${key.text()}\` is declared twice here` };
	const declaration = resolved.declaration;
	if (!declaration) return {};
	const value =
		declaration.kind() === "variable_declarator"
			? declaration.field("value")
			: undefined;
	if (!value) return {};
	return staticKey(value, callSite, raw, depth + 1);
}

/**
 * The `catch`/`then` property an expression names, when the scan can read it:
 * a member (`p.catch`) or a statically known subscript (`p["catch"]`).
 */
function rejectionMemberOf(
	node: SgNode | undefined,
	raw: string,
	callSite: SgNode,
): string | undefined {
	if (node === undefined || node === null) return undefined;
	if (node.kind() === "parenthesized_expression")
		return rejectionMemberOf(node.namedChildren()[0], raw, callSite);
	if (node.kind() === "member_expression") {
		const property = node.field("property")?.text();
		return property === "catch" || property === "then" ? property : undefined;
	}
	if (node.kind() === "subscript_expression") {
		const key = node.field("index");
		if (key === undefined || key === null) return undefined;
		const statik = staticKey(key, callSite, raw);
		if (
			"value" in statik &&
			(statik.value === "catch" || statik.value === "then")
		)
			return statik.value;
	}
	return undefined;
}

/**
 * The `catch`/`then` property an identifier is bound to (`const c = p.catch`),
 * when a single declaration in its scope binds it to such a member.
 */
function boundRejectionMember(
	identifier: SgNode,
	raw: string,
	callSite: SgNode,
): string | undefined {
	const declaration = resolveHandlerIdentifier(
		identifier,
		callSite,
	).declaration;
	if (!declaration || declaration.kind() !== "variable_declarator")
		return undefined;
	// The key a subscript value names resolves in the DECLARATION's scope, not
	// the later call's: `const c = p[k]` and `c(fn)` can see different `k`.
	return rejectionMemberOf(declaration.field("value"), raw, declaration);
}

/**
 * The rejection-handler call site this call_expression is, when it is one:
 * `.catch`/`["catch"]`, the second argument of `.then`/`["then"]`, or an
 * indirect reach of either (`.call`/`.apply`/`.bind`, a local binding) that is
 * a site but `unclassified` (#4603 review N2).
 */
function rejectionHandlerCall(
	node: SgNode,
	raw: string,
	boundNames: ReadonlySet<string>,
):
	| {
			handler?: SgNode;
			property?: string;
			propertyNode?: SgNode;
			problem?: string;
	  }
	| undefined {
	const fn = node.field("function");
	if (fn === undefined || fn === null) return undefined;
	let property: string | undefined;
	let propertyNode: SgNode | undefined;
	let problem: string | undefined;
	if (fn.kind() === "member_expression") {
		const name = fn.field("property")?.text();
		if (name === "call" || name === "apply" || name === "bind") {
			const reached = rejectionMemberOf(fn.field("object"), raw, node);
			if (reached === undefined) return undefined;
			return {
				property: reached,
				propertyNode: fn.field("object"),
				problem: `\`.${reached}.${name}(…)\` reaches the rejection handler indirectly; the scan cannot tell which argument is the handler`,
			};
		}
		property = name;
		propertyNode = fn.field("property");
	} else if (fn.kind() === "subscript_expression") {
		const key = fn.field("index");
		if (key === undefined || key === null) return undefined;
		propertyNode = key;
		const statik = staticKey(key, node, raw);
		if ("value" in statik && typeof statik.value === "string")
			property = statik.value;
		else if ("unresolved" in statik) {
			problem = String(statik.unresolved);
		}
	} else if (fn.kind() === "identifier") {
		// A cheap file-level pre-filter (`boundNames`) keeps this resolution off
		// every ordinary call; only a name a file binds to a rejection member is
		// resolved, and then in its own scope.
		if (!boundNames.has(fn.text())) return undefined;
		const reached = boundRejectionMember(fn, raw, node);
		if (reached === undefined) return undefined;
		return {
			property: reached,
			propertyNode: fn,
			problem: `\`${fn.text()}\` is bound to a \`${reached}\` member and called indirectly; the scan cannot classify it`,
		};
	} else return undefined;
	if (property === undefined) {
		if (problem !== undefined) return { problem, propertyNode };
		return undefined;
	}
	if (property !== "catch" && property !== "then") return undefined;
	const args = node.field("arguments")?.namedChildren() ?? [];
	if (property === "catch") return { handler: args[0], property, propertyNode };
	// `.then(onOk, onRejected)`: only the second argument is a rejection
	// handler. A single argument leaves rejections to the next link, and an
	// explicit `undefined`/`null` passes them along too.
	if (args.length < 2) return undefined;
	const second = args[1];
	const text = second?.text();
	if (text === "undefined" || text === "null") return undefined;
	return { handler: second, property, propertyNode };
}

/** Every `catch` handler in one source text, with its derived verdict. */
export function scanSilentCatches(source: string): CatchSite[] {
	const stringsBlanked = stripSource(source, { strings: "blank" });
	const commentsBlanked = stripSource(source, { strings: "keep" });
	const root = parseRoot(stringsBlanked);
	const strippings: Strippings = {
		raw: source,
		commentsBlanked,
		stringsBlanked,
	};
	const sites: CatchSite[] = [];
	// Names a file binds to a `catch`/`then` member (`const c = p.catch`), so an
	// indirect call through one is a site without resolving every call's callee
	// (#4603 review N2). A subscript value adds the name unconditionally; the
	// scope-aware resolution decides whether it really names a member.
	const boundRejectionNames = new Set<string>();
	walkAst(root, (node: SgNode) => {
		if (node.kind() !== "variable_declarator") return;
		const name = node.field("name");
		if (name === undefined || name === null || name.kind() !== "identifier")
			return;
		let value = node.field("value");
		while (value?.kind() === "parenthesized_expression")
			value = value.namedChildren()[0];
		if (value === undefined || value === null) return;
		if (value.kind() === "subscript_expression") {
			boundRejectionNames.add(name.text());
			return;
		}
		if (value.kind() !== "member_expression") return;
		const property = value.field("property")?.text();
		if (property === "catch" || property === "then")
			boundRejectionNames.add(name.text());
	});
	walkAst(root, (node: SgNode) => {
		if (node.kind() === "catch_clause") {
			const body = node.field("body");
			const range = node.range();
			const span = { start: range.start.index, end: range.end.index };
			sites.push({
				line: range.start.line + 1,
				form: "catch-clause",
				// The marker scope is the clause BODY: a comment in the parameter
				// list (`catch (/* none: x */ e)`) is not the handler's reason.
				...judge(body, body ?? node, strippings),
				snippet: firstLine(body?.text() ?? node.text()),
				identity: handlerIdentity(source, span.start, span.end),
			});
			return;
		}
		if (node.kind() !== "call_expression") return;
		const call = rejectionHandlerCall(node, source, boundRejectionNames);
		if (call === undefined) return;
		const property = node.field("function");
		const line =
			(call.propertyNode?.range().start.line ??
				property?.range().start.line ??
				node.range().start.line) + 1;
		const span = {
			start: property?.range().start.index ?? node.range().start.index,
			end: node.range().end.index,
		};
		const form = call.property === "then" ? "promise-then" : "promise-catch";
		if (call.problem !== undefined) {
			sites.push({
				line,
				form,
				verdict: "unclassified",
				records: [],
				snippet: firstLine(node.text()),
				identity: handlerIdentity(source, span.start, span.end),
				problem: call.problem,
			});
			return;
		}
		const handler = call.handler;
		if (handler === undefined || handler === null) {
			sites.push({
				line,
				form,
				verdict: "unclassified",
				records: [],
				snippet: firstLine(node.text()),
				identity: handlerIdentity(source, span.start, span.end),
				problem: `\`.${call.property}()\` names no handler at all`,
			});
			return;
		}
		let target = handler;
		if (handler.kind() === "identifier") {
			const resolved = resolveHandlerIdentifier(handler, node);
			if (resolved.ambiguous) {
				sites.push({
					line,
					form,
					verdict: "unclassified",
					records: [],
					snippet: firstLine(handler.text()),
					identity: handlerIdentity(source, span.start, span.end),
					problem: `handler \`${handler.text()}\` is declared more than once in its scope, so the scan cannot tell which one runs`,
				});
				return;
			}
			const fn = resolved.declaration
				? declaredFunction(resolved.declaration)
				: undefined;
			if (fn !== undefined) target = fn;
		}
		if (!FUNCTION_KINDS.has(target.kind())) {
			sites.push({
				line,
				form,
				verdict: "unclassified",
				records: [],
				snippet: firstLine(handler.text()),
				identity: handlerIdentity(source, span.start, span.end),
				problem: `handler \`${firstLine(handler.text())}\` does not resolve to a function this scan can follow`,
			});
			return;
		}
		const body = FUNCTION_KINDS.has(target.kind())
			? target.field("body")
			: undefined;
		// The `none:` marker's scope is the handler actually judged: the
		// resolved function. Unresolved references returned unclassified above.
		const markerScope = FUNCTION_KINDS.has(target.kind()) ? target : handler;
		const targetRange = target.range();
		sites.push({
			line,
			form,
			...judge(body, markerScope, strippings),
			snippet: firstLine(handler.text()),
			identity: handlerIdentity(
				source,
				targetRange.start.index,
				targetRange.end.index,
			),
		});
	});
	return sites;
}
