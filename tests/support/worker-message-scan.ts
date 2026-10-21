/**
 * #4402: find every worker, child-process and IPC `message` handler in a
 * source text and derive whether it is contained. The ratchet that runs this
 * over the shipped trees is tests/clients/worker-message-boundary-ratchet.test.ts;
 * its header holds the state table this rule implements.
 *
 * Recurrence (#4400): the project-snapshot host typed its worker `message`
 * listener as the result it expected and passed `result.stagePath` to
 * `fs.rmSync`. A message without that field threw inside the listener, which
 * is an uncaught exception, and pi exited. Nothing mechanical required the
 * listener to check the message or to keep a throw inside it.
 *
 * What a site is: a call `<receiver>.<on|once|addListener|prependListener|
 * prependOnceListener|addEventListener>("message", handler)` or an
 * assignment `<receiver>.onmessage = handler`, for any receiver (a `Worker`,
 * `parentPort`, a `MessagePort`, `process`, a forked child).
 *
 * The rule, derived and never a hand list:
 * - Shape: the message parameter is typed `unknown` and never cast (`as`,
 *   `<T>`). The type checker then refuses every field read until a check has
 *   narrowed it, so "reads only shape-checked fields" is tsc's verdict.
 * - Containment: the handler body is one `try` whose `catch` and `finally`
 *   do not throw, and the try block lets no promise rejection out. A call in
 *   the try that is neither awaited nor followed by `.catch` is judged by its
 *   callee's body when the callee is an async IIFE or a same-file async
 *   function, and is `unresolved` when it is voided and the callee is not a
 *   same-file function; a `.then` without `.catch` fails.
 * - A body that only delegates (`(m: unknown) => handle(m)`, `void (async ()
 *   => {…})()`) is contained when the function it delegates to is and every
 *   argument is the message itself or a literal: any other argument is
 *   evaluated in the listener, before the delegate's try (#4413 r1 F1).
 * - A handler the scan cannot follow (an imported function, a factory call)
 *   is `unresolved`, which fails loud: it is never counted as contained.
 * - A site's key names the nearest named function that encloses the
 *   registration in the AST, or `<module>` at top level; a repeated key gets
 *   ` #2`, ` #3` in source order.
 *
 * The scan parses comment-blanked source (`stripSource`, strings kept,
 * because the event name `"message"` is itself a string literal: the
 * per-needle policy). A `try` written in a comment is blank before the parse,
 * and one written in a string is a string node, so neither can satisfy the
 * rule.
 *
 * Known limits, named: a catch or finally body is the containment boundary
 * and is trusted not to throw beyond an explicit `throw` (a helper that
 * rethrows passes); a callback a handler schedules (`fs.rm(p, cb)`, a timer)
 * runs outside its try and is shape 53's hand screen; `const r: any = m`
 * widens without a cast; an event name is followed only to a same-file
 * declarator, and computed members (`worker["on"]`), `events.on(worker,
 * "message")` and `Object.assign(port, { onmessage })` are not sites.
 *
 * Covered elsewhere: this scan has no type information, so an un-voided call
 * to an imported async function, or to a sync function that returns a
 * promise, is invisible to it. `npm run lint:js:promises` (type-aware
 * `no-floating-promises` and `no-misused-promises` over `clients/`, `mcp/`,
 * `tools/` and `index.ts`, chained into the gating `npm run lint`) reds on
 * every such call; tests/scripts/lint-js.test.ts plants both forms.
 */

import { parseRoot, walkAst } from "./ast-census.js";
import { stripSource } from "./sweep-kit.js";

/** The napi node type is untyped, exactly as the socket sweep walks it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

const LISTENER_METHODS = new Set([
	"on",
	"once",
	"addListener",
	"prependListener",
	"prependOnceListener",
	"addEventListener",
]);

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

export type MessageHandlerVerdict = "contained" | "uncontained" | "unresolved";

export interface MessageHandlerSite {
	/**
	 * `<file>#<enclosing function or <module>> <receiver>.<method>`, with ` #N`
	 * on a repeat: stable under line churn.
	 */
	key: string;
	/** 1-based line of the registration. */
	line: number;
	verdict: MessageHandlerVerdict;
	/** Why the verdict is not `contained`; empty when it is. */
	problems: string[];
}

/** Descendants of `node`, not descending into nested functions. */
function walkOwnBody(node: SgNode, visit: (node: SgNode) => void): void {
	for (const child of node.children()) {
		visit(child);
		if (!FUNCTION_KINDS.has(child.kind())) walkOwnBody(child, visit);
	}
}

/** `"message"`, `'message'` or a substitution-free `` `message` ``. */
function isMessageLiteral(node: SgNode | undefined): boolean {
	if (!node) return false;
	if (node.kind() !== "string" && node.kind() !== "template_string") {
		return false;
	}
	const parts = node.namedChildren();
	return (
		parts.length === 1 &&
		parts[0].kind() === "string_fragment" &&
		parts[0].text() === "message"
	);
}

/** Names a same-file declarator binds to the `"message"` literal (#4413 r1 F5). */
function messageNameIndex(root: SgNode): Set<string> {
	const names = new Set<string>();
	walkAst(root, (node: SgNode) => {
		if (
			node.kind() === "variable_declarator" &&
			isMessageLiteral(node.field("value"))
		) {
			const name = node.field("name");
			if (name?.kind() === "identifier") names.add(name.text());
		}
	});
	return names;
}

const LITERAL_KINDS = new Set(["number", "true", "false", "null", "undefined"]);

/** An argument whose evaluation cannot throw: a literal (#4413 r1 F1). */
function isLiteral(node: SgNode): boolean {
	if (LITERAL_KINDS.has(node.kind())) return true;
	if (node.kind() === "identifier" && node.text() === "undefined") return true;
	if (node.kind() === "string") return true;
	return (
		node.kind() === "template_string" &&
		!node
			.namedChildren()
			.some((part: SgNode) => part.kind() === "template_substitution")
	);
}

function isAsync(fn: SgNode): boolean {
	return fn.child(0)?.text() === "async";
}

/** Is this call's promise awaited or caught? A rejection then stays in the try. */
function handled(call: SgNode): boolean {
	return unwrapParent(call)?.kind() === "await_expression" || caughtAfter(call);
}

function isVoided(call: SgNode): boolean {
	const parent = unwrapParent(call);
	return (
		parent?.kind() === "unary_expression" && parent.child(0)?.text() === "void"
	);
}

function unwrapParent(node: SgNode): SgNode | undefined {
	let parent = node.parent();
	while (parent?.kind() === "parenthesized_expression")
		parent = parent.parent();
	return parent;
}

/** The nearest named function enclosing `node`, or `<module>` (#4413 r1 F6). */
function enclosingName(node: SgNode): string {
	for (let current = node.parent(); current; current = current.parent()) {
		const kind = current.kind();
		if (
			kind === "function_declaration" ||
			kind === "generator_function_declaration" ||
			kind === "method_definition"
		) {
			const name = current.field("name")?.text();
			if (name) return name;
		} else if (FUNCTION_KINDS.has(kind)) {
			const holder = current.parent();
			if (holder?.kind() === "variable_declarator") {
				const name = holder.field("name")?.text();
				if (name) return name;
			}
		}
	}
	return "<module>";
}

/** Named functions in the file: declarations and `const f = (…) => …`. */
function functionIndex(root: SgNode): Map<string, SgNode[]> {
	const index = new Map<string, SgNode[]>();
	const add = (name: string | undefined, fn: SgNode) => {
		if (!name) return;
		index.set(name, [...(index.get(name) ?? []), fn]);
	};
	walkAst(root, (node: SgNode) => {
		if (node.kind() === "function_declaration") {
			add(node.field("name")?.text(), node);
		} else if (node.kind() === "variable_declarator") {
			const value = node.field("value");
			if (value && FUNCTION_KINDS.has(value.kind())) {
				add(node.field("name")?.text(), value);
			}
		}
	});
	return index;
}

function unwrapParens(node: SgNode | undefined): SgNode | undefined {
	let current = node;
	while (current?.kind() === "parenthesized_expression") {
		current = current.namedChildren()[0];
	}
	return current;
}

interface Parameter {
	name: string | undefined;
	type: string | undefined;
}

function parameters(fn: SgNode): Parameter[] {
	const single = fn.field("parameter");
	if (single) return [{ name: single.text(), type: undefined }];
	return (fn.field("parameters")?.namedChildren() ?? []).map((p: SgNode) => {
		const pattern = p.field("pattern") ?? p.namedChildren()[0];
		const annotation = p.field("type");
		return {
			name: pattern?.kind() === "identifier" ? pattern.text() : undefined,
			type: annotation?.namedChildren()[0]?.text(),
		};
	});
}

class Judge {
	private readonly visiting = new Set<SgNode>();
	unresolved = false;

	constructor(private readonly index: Map<string, SgNode[]>) {}

	resolve(node: SgNode | undefined): SgNode | undefined {
		const target = unwrapParens(node);
		if (!target) return undefined;
		if (FUNCTION_KINDS.has(target.kind())) return target;
		if (target.kind() !== "identifier") return undefined;
		const found = this.index.get(target.text()) ?? [];
		return found.length === 1 ? found[0] : undefined;
	}

	/** Problems for `fn` receiving the message as parameter `position`. */
	handler(fn: SgNode, position: number): string[] {
		if (this.visiting.has(fn)) return [];
		this.visiting.add(fn);
		const problems: string[] = [];
		const param = parameters(fn)[position];
		if (param !== undefined) {
			const label = param.name ?? "<pattern>";
			if (param.type !== "unknown") {
				problems.push(
					`message parameter "${label}" is typed ${param.type ? `"${param.type}"` : "implicitly"}; type it unknown so tsc requires a shape check before any field read (#4400)`,
				);
			}
			if (param.name !== undefined) {
				walkAst(fn, (node: SgNode) => {
					const kind = node.kind();
					if (
						(kind === "as_expression" || kind === "type_assertion") &&
						node
							.namedChildren()
							.some(
								(child: SgNode) =>
									child.kind() === "identifier" && child.text() === param.name,
							)
					) {
						problems.push(
							`message parameter "${param.name}" is cast (${node.text()}); a cast skips the shape check`,
						);
					}
				});
			}
		}
		problems.push(...this.body(fn.field("body"), param?.name));
		return problems;
	}

	private body(body: SgNode | undefined, param: string | undefined): string[] {
		if (!body) return ["handler has no body to judge"];
		if (body.kind() !== "statement_block") return this.delegation(body, param);
		const statements = body.namedChildren();
		if (statements.length === 1) {
			const only = statements[0];
			if (only.kind() === "try_statement") return this.tryStatement(only);
			if (
				only.kind() === "expression_statement" ||
				only.kind() === "return_statement"
			) {
				const expression = only.namedChildren()[0];
				if (expression) return this.delegation(expression, param);
			}
		}
		return [
			"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
		];
	}

	private delegation(expression: SgNode, param: string | undefined): string[] {
		let call = unwrapParens(expression);
		if (
			call?.kind() === "unary_expression" &&
			call.child(0)?.text() === "void"
		) {
			call = unwrapParens(call.namedChildren()[0]);
		}
		if (call?.kind() !== "call_expression") {
			return [
				"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
			];
		}
		const callee = unwrapParens(call.field("function"));
		const args = call.field("arguments")?.namedChildren() ?? [];
		if (callee && FUNCTION_KINDS.has(callee.kind()) && args.length === 0) {
			// An IIFE: its body runs as this handler's body.
			return this.body(callee.field("body"), param);
		}
		// #4413 r1 F1: arguments run in the listener, before the delegate's try.
		const evaluated = args
			.filter(
				(arg: SgNode) =>
					!isLiteral(arg) &&
					!(arg.kind() === "identifier" && arg.text() === param),
			)
			.map(
				(arg: SgNode) =>
					`argument ${firstLine(arg.text())} is evaluated before ${callee?.text() ?? "the delegate"}'s try runs; pass the message itself and read it inside the try`,
			);
		const target =
			callee?.kind() === "identifier" ? this.resolve(callee) : undefined;
		const position = args.findIndex(
			(arg: SgNode) => arg.kind() === "identifier" && arg.text() === param,
		);
		if (!target) {
			this.unresolved = true;
			return [
				...evaluated,
				`delegates to ${callee?.text() ?? "an expression"}, which this file does not define; the scan cannot follow it`,
			];
		}
		return [
			...evaluated,
			...this.handler(
				target,
				position < 0 ? Number.MAX_SAFE_INTEGER : position,
			),
		];
	}

	private tryStatement(statement: SgNode): string[] {
		const problems: string[] = [];
		const handler = statement
			.namedChildren()
			.find((child: SgNode) => child.kind() === "catch_clause");
		if (!handler) {
			problems.push("try has no catch: a throw still leaves the listener");
		} else {
			walkOwnBody(handler, (node: SgNode) => {
				if (node.kind() === "throw_statement") {
					problems.push(`catch rethrows (${node.text()})`);
				}
			});
		}
		// #4413 r1 F3: a throw in finally leaves the listener as one in catch does.
		const finalizer = statement
			.namedChildren()
			.find((child: SgNode) => child.kind() === "finally_clause");
		if (finalizer) {
			walkOwnBody(finalizer, (node: SgNode) => {
				if (node.kind() === "throw_statement") {
					problems.push(`finally throws (${node.text()})`);
				}
			});
		}
		const block = statement.field("body");
		if (block) {
			walkOwnBody(block, (node: SgNode) => {
				if (node.kind() !== "call_expression") return;
				const fn = node.field("function");
				if (
					fn?.kind() === "member_expression" &&
					fn.field("property")?.text() === "then" &&
					!caughtAfter(node)
				) {
					problems.push(
						`a .then() chain without .catch() lets a rejection out of the try (${firstLine(node.text())})`,
					);
				}
				problems.push(...this.floating(node));
			});
		}
		return problems;
	}

	/**
	 * A call in a try whose rejection is not awaited or caught (#4413 r1 F2):
	 * an async IIFE or a same-file async callee is judged by its body, as the
	 * listener body is; a voided call the scan cannot follow is unresolved.
	 */
	private floating(call: SgNode): string[] {
		if (handled(call)) return [];
		const fn = unwrapParens(call.field("function"));
		const property =
			fn?.kind() === "member_expression"
				? fn.field("property")?.text()
				: undefined;
		// `.then` has its own rule above; `.catch` handles the rejection.
		if (property === "then" || property === "catch") return [];
		const target =
			fn && FUNCTION_KINDS.has(fn.kind())
				? fn
				: fn?.kind() === "identifier"
					? this.resolve(fn)
					: undefined;
		if (target && (isAsync(target) || isVoided(call))) {
			if (this.visiting.has(target)) return [];
			this.visiting.add(target);
			const reason =
				target === fn
					? ""
					: `${firstLine(call.text())} is neither awaited nor caught, so its rejection leaves the try: `;
			const args = call.field("arguments")?.namedChildren() ?? [];
			const passed = args.findIndex(
				(arg: SgNode) => arg.kind() === "identifier",
			);
			const param = passed < 0 ? undefined : parameters(target)[passed]?.name;
			return this.body(target.field("body"), param).map(
				(problem) => `${reason}${problem}`,
			);
		}
		if (!target && isVoided(call)) {
			this.unresolved = true;
			return [
				`voided promise from ${fn?.text() ?? "an expression"}, which this file does not define; the scan cannot follow it`,
			];
		}
		return [];
	}
}

/** Is this `.then(…)` call the object of a later `.catch(…)` call? */
function caughtAfter(thenCall: SgNode): boolean {
	let current = thenCall;
	for (;;) {
		const member = current.parent();
		if (member?.kind() !== "member_expression") return false;
		const call = member.parent();
		if (call?.kind() !== "call_expression") return false;
		if (member.field("property")?.text() === "catch") return true;
		current = call;
	}
}

function firstLine(text: string): string {
	return text.split("\n")[0].trim();
}

/** Every `message` handler in one source text, with its derived verdict. */
export function scanMessageHandlers(
	source: string,
	relPath = "<source>",
): MessageHandlerSite[] {
	const stripped = stripSource(source, { strings: "keep" });
	if (!/["'`]message["'`]|\bonmessage\b/.test(stripped)) return [];
	const root = parseRoot(stripped);
	const index = functionIndex(root);
	const messageNames = messageNameIndex(root);
	const sites: MessageHandlerSite[] = [];
	const seen = new Map<string, number>();
	const judgeSite = (
		node: SgNode,
		receiver: SgNode,
		method: string,
		handler: SgNode | undefined,
	) => {
		const line = node.range().start.line;
		const base = `${relPath}#${enclosingName(node)} ${receiver.text().replace(/\s+/g, "")}.${method}`;
		const ordinal = (seen.get(base) ?? 0) + 1;
		seen.set(base, ordinal);
		const judge = new Judge(index);
		const fn = judge.resolve(handler);
		const problems = fn
			? judge.handler(fn, 0)
			: [
					`handler ${handler?.text() ?? "<missing>"} is not a function this file defines; the scan cannot follow it`,
				];
		const unresolved = !fn || judge.unresolved;
		sites.push({
			key: ordinal === 1 ? base : `${base} #${ordinal}`,
			line: line + 1,
			verdict:
				problems.length === 0
					? "contained"
					: unresolved
						? "unresolved"
						: "uncontained",
			problems,
		});
	};
	walkAst(root, (node: SgNode) => {
		if (node.kind() === "call_expression") {
			const fn = node.field("function");
			if (fn?.kind() !== "member_expression") return;
			const method = fn.field("property")?.text() ?? "";
			if (!LISTENER_METHODS.has(method)) return;
			const args = node.field("arguments")?.namedChildren() ?? [];
			const event = args[0];
			if (
				!isMessageLiteral(event) &&
				!(event?.kind() === "identifier" && messageNames.has(event.text()))
			) {
				return;
			}
			judgeSite(node, fn.field("object"), method, args[1]);
		} else if (node.kind() === "assignment_expression") {
			const left = node.field("left");
			if (
				left?.kind() !== "member_expression" ||
				left.field("property")?.text() !== "onmessage"
			) {
				return;
			}
			judgeSite(node, left.field("object"), "onmessage", node.field("right"));
		}
	});
	return sites;
}
