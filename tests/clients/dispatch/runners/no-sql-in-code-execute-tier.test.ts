/**
 * #4804 review (F1, shape 83: a rule re-derived beside its owner). The
 * `.execute` arms live in their own rule pair (`no-sql-in-code-execute` /
 * `-js`) at `severity: warning`, so their findings are advisory; the `.query`
 * arms stay in `no-sql-in-code` / `-js` at `severity: error`, unchanged from
 * master. Recurrence: one rule carried both arms at `error`, so the 11 of 16
 * realistic non-SQL `.execute` shapes the review probed (`acl.execute("grant "
 * + role)`) were delivered as blocking-tier findings.
 *
 * The tier is read through the production evaluator, not the YAML text: a rule
 * only blocks when `evaluateAstGrepRules` maps its severity onto
 * `semantic: "blocking"` (clients/dispatch/runners/ast-grep-napi.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import {
	evaluateAstGrepRules,
	getLang,
	loadSg,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import { detectFileKind } from "../../../../clients/file-kinds.js";
import { removeTempDirSync } from "../../test-utils.js";

let sgModule: AstGrepNapi;
let cwd: string;

beforeAll(async () => {
	const loaded = await loadSg();
	if (!loaded) throw new Error("@ast-grep/napi failed to load");
	sgModule = loaded;
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sql-tier-"));
});

afterAll(() => {
	removeTempDirSync(cwd);
});

/** `rule|severity|semantic` for every ast-grep finding the snippet produces. */
function tiersOf(
	name: string,
	ext: string,
	content: string,
	blockingOnly = false,
): string[] {
	const filePath = path.join(cwd, `${name}.${ext}`);
	const root = getLang(filePath, sgModule)?.parse(content).root();
	expect(root, `${name}: napi could not parse the snippet`).toBeDefined();
	return evaluateAstGrepRules(
		filePath,
		root as NonNullable<typeof root>,
		cwd,
		detectFileKind(filePath),
		{ content, sgModule, blockingOnly },
	).map((d) => `${d.rule}|${d.severity}|${d.semantic}`);
}

describe("the .execute arms are advisory and the .query arms still block", () => {
	it("reports an interpolated .execute call in its own warning-tier rule", () => {
		expect(
			tiersOf(
				"execute",
				"ts",
				'db.execute("SELECT * FROM users WHERE id = " + id)',
			),
		).toEqual(["no-sql-in-code-execute|warning|warning"]);
	});

	it("keeps an interpolated .query call in the master rule at error", () => {
		expect(
			tiersOf(
				"query",
				"ts",
				'db.query("SELECT * FROM users WHERE id = " + id)',
			),
		).toEqual(["no-sql-in-code|error|blocking"]);
	});

	it("splits the same way for the JavaScript twins", () => {
		expect(
			tiersOf(
				"execute-js",
				"js",
				'db.execute("DELETE FROM t WHERE id = " + id)',
			),
		).toEqual(["no-sql-in-code-execute-js|warning|warning"]);
		expect(
			tiersOf("query-js", "js", 'db.query("DELETE FROM t WHERE id = " + id)'),
		).toEqual(["no-sql-in-code-js|error|blocking"]);
	});

	it("records the statement-shaped English the alternation still accepts", () => {
		// Pinned as invalid: rows in the fixtures too; the tier is the point
		// here, since these are the shapes that made `error` the wrong tier.
		for (const snippet of [
			'acl.execute("grant " + role)',
			'search.execute("create index " + field)',
			'config.execute("merge into " + base)',
		]) {
			expect(tiersOf("pinned", "ts", snippet), snippet).toEqual([
				"no-sql-in-code-execute|warning|warning",
			]);
		}
	});

	it("keeps the callee-name shapes and constant SQL quiet", () => {
		for (const snippet of [
			'runner.execute("delete " + id)',
			'command.execute("update " + name)',
			'db.execute("SELECT * FROM users")',
		]) {
			expect(tiersOf("quiet", "ts", snippet), snippet).toEqual([]);
		}
	});

	it("leaves both rules off the per-edit pass, where the complexity cap skips them", () => {
		// Neither rule is a per-edit blocker to begin with: the cap is 8
		// (MAX_BLOCKING_RULE_COMPLEXITY), master's `.query`-only body measures
		// 15 and this PR's `.execute` body measures 22, so `blockingOnly: true`
		// skipped both before and after the split. The split changes what the
		// full-analysis surfaces deliver, not what stops an edit.
		for (const snippet of [
			'db.execute("SELECT * FROM users WHERE id = " + id)',
			'db.query("SELECT * FROM users WHERE id = " + id)',
		]) {
			expect(tiersOf("blocking", "ts", snippet, true), snippet).toEqual([]);
		}
	});
});
