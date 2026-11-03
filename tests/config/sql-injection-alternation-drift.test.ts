/**
 * #4804 review (F2, shape 83: a rule re-derived beside its owner). The SQL
 * statement alternation exists three times: in
 * `rules/ast-grep-rules/rules/no-sql-in-code-execute.yml`, in its `-js` twin,
 * and in `ts_sql_injection_sink` (`clients/tree-sitter-client.ts`). The
 * ast-grep copies carry two word boundaries the tree-sitter copy lacks, by
 * design (review on #1828); nothing else may drift, because a one-token edit to
 * either side leaves the two engines answering differently on the same source
 * text with no test failing. Verdict: tied here, not folded onto one source —
 * an ast-grep YAML rule cannot import a TypeScript post-filter.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const RULES_DIR = path.join(REPO_ROOT, "rules", "ast-grep-rules", "rules");
const TS_CLIENT = path.join(REPO_ROOT, "clients", "tree-sitter-client.ts");

interface RuleDoc {
	id: string;
	language: string;
	rule: Record<string, unknown>;
}

function loadRule(file: string): RuleDoc {
	const full = path.join(RULES_DIR, file);
	expect(fs.existsSync(full), `${file} is missing`).toBe(true);
	return yaml.load(fs.readFileSync(full, "utf8")) as RuleDoc;
}

/** The first string under `node` that holds the statement alternation. */
function prefixRegex(node: unknown): string | undefined {
	if (typeof node === "string") {
		return node.includes("(?:SELECT") ? node : undefined;
	}
	const children = Array.isArray(node)
		? node
		: node && typeof node === "object"
			? Object.values(node)
			: [];
	for (const child of children) {
		const found = prefixRegex(child);
		if (found) return found;
	}
	return undefined;
}

/** The alternation itself: from `(?:SELECT` to the regex's closing paren. */
function statementAlternation(regex: string, where: string): string {
	const start = regex.indexOf("(?:SELECT");
	const end = regex.lastIndexOf(")");
	expect(
		start,
		`${where}: statement alternation not found`,
	).toBeGreaterThanOrEqual(0);
	expect(end, `${where}: statement alternation not closed`).toBeGreaterThan(
		start,
	);
	return regex.slice(start, end + 1);
}

/** `ts_sql_injection_sink`'s `/^(?:...)/i` literal, re-wrapped as a group. */
function treeSitterAlternation(): string {
	const source = fs.readFileSync(TS_CLIENT, "utf8");
	const caseStart = source.indexOf('case "ts_sql_injection_sink"');
	expect(
		caseStart,
		"ts_sql_injection_sink case not found in clients/tree-sitter-client.ts",
	).toBeGreaterThanOrEqual(0);
	const match = source
		.slice(caseStart, caseStart + 6000)
		.match(/\/\^\(\?:([^/]*)\)\/i\.test\(/);
	expect(
		match,
		"ts_sql_injection_sink's statement regex literal not found",
	).not.toBeNull();
	return `(?:${(match as RegExpMatchArray)[1]})`;
}

describe("the SQL statement alternation has one text in three copies", () => {
	it("keeps the TypeScript and JavaScript twins' rule bodies identical", () => {
		const ts = loadRule("no-sql-in-code-execute.yml");
		const js = loadRule("no-sql-in-code-execute-js.yml");
		expect(ts.id).toBe("no-sql-in-code-execute");
		expect(js.id).toBe("no-sql-in-code-execute-js");
		expect(ts.language).toBe("TypeScript");
		expect(js.language).toBe("JavaScript");
		expect(js.rule).toEqual(ts.rule);
	});

	it("ties both twins' alternation to the tree-sitter sink's, minus two word boundaries", () => {
		const tsRegex = prefixRegex(loadRule("no-sql-in-code-execute.yml").rule);
		const jsRegex = prefixRegex(loadRule("no-sql-in-code-execute-js.yml").rule);
		expect(
			tsRegex,
			"no prefix-test regex in the TypeScript rule",
		).toBeDefined();
		expect(jsRegex).toBe(tsRegex);
		const ruleAlternation = statementAlternation(
			tsRegex as string,
			"no-sql-in-code-execute.yml",
		);
		// Exactly these two diverge; a third difference fails the equality below.
		expect(ruleAlternation).toContain("SELECT\\b[\\s\\S]");
		expect(ruleAlternation).toContain("WITH\\b[\\s\\S]*\\bSELECT\\b");
		expect(
			ruleAlternation.replace("SELECT\\b", "SELECT").replace("WITH\\b", "WITH"),
		).toBe(treeSitterAlternation());
	});
});
