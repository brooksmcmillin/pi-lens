// #4496: the literal prefilter may skip a rule only when the text lacks a
// literal that every match needs. Each case pins one rule shape.

import { describe, expect, it } from "vitest";
import { ruleCanMatchText } from "../../../../clients/dispatch/runners/ast-grep-literal-anchors.js";
import type {
	YamlRule,
	YamlRuleCondition,
} from "../../../../clients/dispatch/runners/yaml-rule-parser.js";

const rule = (
	condition: YamlRuleCondition,
	utils?: Record<string, YamlRuleCondition>,
): YamlRule => ({ id: "probe", rule: condition, utils });

describe("ruleCanMatchText", () => {
	it("requires pattern words and ignores metavariables", () => {
		const r = rule({ pattern: "$OBJ.readFileSync($$$ARGS)" });
		expect(ruleCanMatchText(r, "fs.readFileSync(p)")).toBe(true);
		expect(ruleCanMatchText(r, "fs.readFile(p)")).toBe(false);
	});

	it("requires a plain-literal regex, including an escaped dot", () => {
		expect(
			ruleCanMatchText(rule({ regex: "^modulusLength$" }), "modulus"),
		).toBe(false);
		const dotted = rule({ regex: "^fs\\.rm$" });
		expect(ruleCanMatchText(dotted, "fs.rm(x)")).toBe(true);
		expect(ruleCanMatchText(dotted, "fsXrm(x)")).toBe(false);
	});

	it("takes nothing from a regex with metacharacters", () => {
		const r = rule({ regex: "(?i)(token|secret)" });
		expect(ruleCanMatchText(r, "const x = 1")).toBe(true);
	});

	it("requires one branch of `any`, and nothing when a branch has no literal", () => {
		const either = rule({ any: [{ pattern: "foo()" }, { pattern: "bar()" }] });
		expect(ruleCanMatchText(either, "bar()")).toBe(true);
		expect(ruleCanMatchText(either, "baz()")).toBe(false);
		const open = rule({ any: [{ pattern: "foo()" }, { kind: "string" }] });
		expect(ruleCanMatchText(open, "baz()")).toBe(true);
		expect(ruleCanMatchText(rule({ any: [] }), "")).toBe(true);
	});

	it("requires every `all` member and every relational target", () => {
		const r = rule({
			all: [{ pattern: "Math.random()" }],
			inside: { pattern: "createToken($$$)" },
		});
		expect(ruleCanMatchText(r, "createToken(Math.random())")).toBe(true);
		expect(ruleCanMatchText(r, "f(Math.random())")).toBe(false);
	});

	it("takes nothing from `not`, `kind` or an object pattern", () => {
		const r = rule({
			kind: "call_expression",
			not: { pattern: "foo()" },
			has: {
				pattern: {
					context: "class A { m() {} }",
					selector: "method_definition",
				},
			},
		});
		expect(ruleCanMatchText(r, "")).toBe(true);
	});

	it("follows `matches` into the rule's own utils and stops on a cycle", () => {
		const r = rule(
			{ matches: "first" },
			{
				first: { all: [{ matches: "second" }] },
				second: {
					regex: "^eval$",
					any: [{ matches: "first" }, { pattern: "eval($X)" }],
				},
			},
		);
		expect(ruleCanMatchText(r, "eval(code)")).toBe(true);
		expect(ruleCanMatchText(r, "evaluate(code)")).toBe(true);
		expect(ruleCanMatchText(r, "run(code)")).toBe(false);
		expect(ruleCanMatchText(rule({ matches: "missing" }, {}), "")).toBe(true);
	});

	it("treats a null `utils` as no util and still runs the rule", () => {
		// #4501 r1: a bare `utils:` key loads as null; Object.hasOwn(null, ...) threw
		// out of evaluateAstGrepRules and dropped every ast-grep finding for the file.
		expect(ruleCanMatchText(rule({ matches: "foo" }, null as never), "")).toBe(
			true,
		);
	});
});
