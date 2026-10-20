// #4496: every shipped `rule-tests/*-test.yml` `invalid:` snippet must still
// fire its rule through the napi evaluator. `ast-grep-rule-tests.test.ts`
// runs the same fixtures through the ast-grep CLI, which never reaches
// `evaluateAstGrepRules` or its literal prefilter.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "../../../../clients/deps/js-yaml.js";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import { buildEffectiveAstGrepCatalog } from "../../../../clients/dispatch/ast-grep-catalog.js";
import {
	evaluateAstGrepRules,
	getLang,
	loadSg,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import { detectFileKind } from "../../../../clients/file-kinds.js";
import { assertNonEmptyScan } from "../../../support/sweep-kit.js";
import { removeTempDirSync } from "../../test-utils.js";

const TEST_DIR = path.join(
	process.cwd(),
	"rules",
	"ast-grep-rules",
	"rule-tests",
);
// Languages the napi evaluator parses; the other fixtures belong to the CLI.
const NAPI_EXTENSION: Readonly<Record<string, string>> = {
	typescript: "ts",
	tsx: "tsx",
	javascript: "js",
	css: "css",
	html: "html",
};

let sgModule: AstGrepNapi;
let cwd: string;

beforeAll(async () => {
	const loaded = await loadSg();
	if (!loaded) throw new Error("@ast-grep/napi failed to load");
	sgModule = loaded;
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-tests-napi-"));
});

afterAll(() => {
	removeTempDirSync(cwd);
});

describe("shipped rule-test fixtures through the napi evaluator", () => {
	it("every invalid snippet fires its rule", () => {
		const catalog = buildEffectiveAstGrepCatalog(cwd);
		const missed: string[] = [];
		let checked = 0;
		for (const name of fs
			.readdirSync(TEST_DIR)
			.filter((f) => f.endsWith("-test.yml"))) {
			const fixture = yaml.load(
				fs.readFileSync(path.join(TEST_DIR, name), "utf8"),
			) as {
				id: string;
				invalid?: string[];
			};
			const language = catalog.effectiveRules.get(fixture.id)?.rule.language;
			const extension =
				NAPI_EXTENSION[(language ?? "typescript").toLowerCase()];
			if (!extension) continue;
			const filePath = path.join(cwd, `snippet.${extension}`);
			for (const content of fixture.invalid ?? []) {
				checked++;
				const root = getLang(filePath, sgModule)?.parse(content).root();
				const fired =
					root !== undefined &&
					evaluateAstGrepRules(filePath, root, cwd, detectFileKind(filePath), {
						content,
						sgModule,
					}).some((d) => d.rule === fixture.id);
				if (!fired) missed.push(`${fixture.id}: ${content}`);
			}
		}
		// 706 napi-language invalid snippets on 2026-10-15.
		assertNonEmptyScan("napi rule-test invalid snippets", checked, 600);
		expect(missed).toEqual([]);
		// About 2.8 s here; 706 whole-catalog evaluations need headroom under load.
	}, 30_000);

	it("skips the native call for a rule whose required literal is absent", () => {
		const target = buildEffectiveAstGrepCatalog(cwd).effectiveRules.get(
			"no-insecure-randomness",
		)?.rule.rule;
		expect(target).toBeDefined();
		const filePath = path.join(cwd, "snippet.ts");
		const targetCalls = (content: string): number => {
			const root = getLang(filePath, sgModule)?.parse(content).root();
			let calls = 0;
			const counting = {
				findAll(config: { rule?: unknown }) {
					if (config.rule === target) calls++;
					return root?.findAll(config as never) ?? [];
				},
			};
			evaluateAstGrepRules(filePath, counting, cwd, detectFileKind(filePath), {
				content,
				sgModule,
			});
			return calls;
		};
		expect(targetCalls("const token = crypto.randomUUID();")).toBe(0);
		expect(targetCalls("const token = Math.random();")).toBe(1);
	});
});
