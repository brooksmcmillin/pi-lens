/**
 * The path-containment detector's own state table (#2556): one named case per
 * admitted reading, per refusal, and per plant its author did not design for
 * (an alias, an indirect call, a value reached through another binding;
 * AGENTS.md shape 69). The census over the repository's trees is
 * `tests/config/path-containment-sweep.test.ts`.
 *
 * Recurrence guarded: a hand-rolled containment test over a `path.relative`
 * result passes every lane while being wrong across Windows drives (#4878 F1:
 * `!rel.startsWith("..")` read an absolute cross-drive `rel` as inside, and
 * `Unit tests Windows` failed 26 cells on a head every other lane called
 * green). Each `site` row is a spelling that reached, or could reach, that
 * test; each `clean` row is a spelling the detector must NOT report, so a
 * widened needle that buries the population under spread syntax or prose is
 * caught here too.
 *
 * The PREDICATE rows exist because #4882 review F1 caught the first cut
 * enumerating ONE predicate: `split(sep)[0] === ".."`, `rel === ".."`,
 * `slice(0, 2) === ".."` and `rel[0] + rel[1] === ".."` all shipped green. The
 * rows below are the four the review named plus the rest of that family, and
 * the rule that reports them is a comparison/call analysis, not a list — which
 * is why the equality `rel === ".."` moved OUT of the `clean` table it was in.
 */
import { describe, expect, it } from "vitest";
import {
	mayHoldContainment,
	type PathContainmentSite,
	scanPathContainmentSites,
} from "./path-containment-scan.js";

function rows(source: string): PathContainmentSite[] {
	return scanPathContainmentSites(source);
}

function anchors(source: string): string[] {
	return rows(source).map((site) => site.anchor);
}

/** The #4878 F1 spelling, as it shipped in `tests/support/vi-mock-export-gate.ts`. */
const THE_4878_F1_SPELLING =
	"function isInside(file: string): boolean {\n" +
	"  const rel = path.relative(process.cwd(), file);\n" +
	'  return !rel.startsWith("..");\n' +
	"}\n";

describe("path containment detector (#2556)", () => {
	it("reports the direct, chained and bound readings", () => {
		const cases: Array<[string, string]> = [
			["direct chain", 'const inside = path.relative(a, b).startsWith("..");'],
			[
				"named sep operand",
				'const inside = !path.relative(a, b).startsWith(".." + path.sep);',
			],
			[
				"win32 separator literal",
				'const rel = path.relative(a, b);\nconst inside = !rel.startsWith("..\\\\");',
			],
			[
				"posix separator literal",
				'const rel = path.relative(a, b);\nconst inside = rel.startsWith("../");',
			],
			[
				"template with the platform separator",
				"const rel = path.relative(a, b);\nconst inside = rel.startsWith(`..${path.sep}`);",
			],
			[
				"separators folded, then tested",
				'const rel = path.relative(cwd, file).replace(/\\\\/g, "/");\n' +
					'const inside = rel.startsWith("../");',
			],
			[
				"through a local helper's argument",
				"const rel = toPosix(path.relative(cwd, file));\n" +
					'const inside = !rel.startsWith("..");',
			],
			[
				"split/join on the separator",
				"const rel = relative(cwd, file).split(sep).join(posix.sep);\n" +
					'if (rel.startsWith("../")) return false;',
			],
			[
				"two-statement binding, as six production sites spell it",
				"const rel = path.relative(root, dir);\n" +
					'if (rel.startsWith("..") || path.isAbsolute(rel)) break;',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBe(1);
	});

	/**
	 * #4882 review F1: a containment answer is any comparison or call where the
	 * relative value meets a parent-segment literal. These are the spellings the
	 * enumerated-predicate cut read as clean.
	 */
	it("reports every comparison spelling, not only the prefix method", () => {
		const cases: Array<[string, string]> = [
			[
				"first segment equals `..`",
				'const rel = path.relative(a, b);\nconst inside = rel.split(path.sep)[0] !== "..";',
			],
			[
				"equality plus the cross-drive arm",
				'const rel = path.relative(a, b);\nreturn rel === ".." || path.isAbsolute(rel);',
			],
			[
				"slice of the first two characters",
				'const rel = path.relative(a, b);\nreturn rel.slice(0, 2) === "..";',
			],
			[
				"two index reads",
				'const rel = path.relative(a, b);\nreturn rel[0] + rel[1] === "..";',
			],
			[
				"`at(0)` segment read",
				'const rel = path.relative(a, b);\nreturn rel.split(path.sep).at(0) === "..";',
			],
			[
				"indexOf against the prefix",
				'const rel = path.relative(a, b);\nreturn rel.indexOf("..") === 0;',
			],
			[
				"includes",
				'const rel = path.relative(a, b);\nreturn !rel.includes("..");',
			],
			[
				"endsWith",
				'const rel = path.relative(a, b);\nreturn rel.endsWith("..");',
			],
			[
				"`..`-anchored RegExp on the value",
				"const rel = path.relative(a, b);\nreturn /^\\.\\./.test(rel);",
			],
			[
				"`toMatch` with a `..` regex",
				"const rel = path.relative(a, b);\nexpect(rel).toMatch(/^\\.\\./);",
			],
			[
				"literal on the left of the comparison",
				'const rel = path.relative(a, b);\nreturn ".." === rel;',
			],
			[
				"less-than comparison against a `..` literal",
				'const rel = path.relative(a, b);\nreturn rel < "../a";',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBe(1);
	});

	/** A parent-segment literal reached through a name, or read by a borrowed method. */
	it("reports a `..` literal held in a binding or passed as an argument", () => {
		const cases: Array<[string, string]> = [
			[
				"named constant",
				'const UP = "..";\nconst rel = path.relative(a, b);\nreturn rel.startsWith(UP);',
			],
			[
				"named constant with the separator concatenated",
				'const UP = ".." + path.sep;\nconst rel = path.relative(a, b);\nreturn rel.startsWith(UP);',
			],
			[
				"named constant inside a template substitution",
				'const UP = "..";\nconst rel = path.relative(a, b);\nreturn rel.startsWith(`${UP}${path.sep}`);',
			],
			[
				"named constant interpolated into a second named constant",
				'const MARK = "..";\nconst UP = `${MARK}${path.sep}`;\n' +
					"const rel = path.relative(a, b);\nreturn rel.startsWith(UP);",
			],
			[
				"borrowed String method",
				'const rel = path.relative(a, b);\nreturn String.prototype.startsWith.call(rel, "..");',
			],
			[
				"hand-off to a helper with the marker",
				'const rel = path.relative(a, b);\nreturn outsideOf(rel, "..");',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBe(1);
	});

	it("reports a value reached through another binding or a whole-value rewrite", () => {
		const cases: Array<[string, string]> = [
			[
				"alias of the binding",
				'const rel = path.relative(a, b);\nconst alias = rel;\nalias.startsWith("..");',
			],
			[
				"binding of an alias of the callee",
				'const up = path.relative;\nconst rel = up(a, b);\nrel.startsWith("..");',
			],
			[
				"named import of the callee",
				'import { relative } from "node:path";\n' +
					"function f(a: string, b: string) {\n" +
					"  const rel = relative(a, b);\n" +
					'  return rel.startsWith("..");\n' +
					"}",
			],
			[
				"aliased named import",
				'import { relative as rel } from "node:path";\n' +
					'rel(a, b).startsWith("..");',
			],
			[
				"destructured callee",
				'const { relative: rel } = path;\nrel(a, b).startsWith("..");',
			],
			[
				"template concatenation of the value",
				'const rel = path.relative(a, b);\n`${rel}`.startsWith("..");',
			],
			[
				"segment extracted into its own binding",
				'const rel = path.relative(a, b);\nconst first = rel.split(path.sep)[0];\nreturn first === "..";',
			],
		];
		for (const [name, source] of cases)
			expect(rows(source).length, name).toBeGreaterThan(0);
	});

	it("reports the #4878 F1 spelling under the symbol it shipped in", () => {
		const [site] = rows(THE_4878_F1_SPELLING);
		expect(site?.anchor).toBe("isInside");
		expect(THE_4878_F1_SPELLING).toContain('rel.startsWith("..")');
	});

	/**
	 * #4882 verify r3 N1: the census's prefilter has ONE condition, so it can
	 * only skip work. A second condition on the marker's spelling
	 * (`source.includes("..")`) hid every admitted form written with escapes:
	 * `/^\.\./` and `"\u002e\u002e"` both reach the detector below and
	 * neither spells `..`, so the census called their file green.
	 */
	it("never skips a file whose parent-segment marker is written with escapes", () => {
		const cases: Array<[string, string]> = [
			[
				"an escaped RegExp literal",
				"function isInside(target: string): boolean {\n" +
					"\tconst UP = /^\\.\\./;\n" +
					'\tconst rel = path.relative("/a", target);\n' +
					"\treturn UP.test(rel);\n" +
					"}\n",
			],
			[
				"an escaped string literal",
				"function isInside(target: string): boolean {\n" +
					'\tconst UP = "\\u002e\\u002e";\n' +
					'\tconst rel = path.relative("/a", target);\n' +
					"\treturn UP.test(rel);\n" +
					"}\n",
			],
		];
		for (const [name, source] of cases) {
			expect(source.includes(".."), name).toBe(false);
			expect(scanPathContainmentSites(source).length, name).toBe(1);
			expect(mayHoldContainment(source), name).toBe(true);
		}
	});

	it("never reads a spread prefix, an unrelated value, or prose as a site", () => {
		const clean: Array<[string, string]> = [
			[
				"rest-element prefix (`...`), not a parent segment",
				'const rest = arg.slice(3);\nif (rest.startsWith("...")) rest = rest.slice(3);',
			],
			[
				"rest-element prefix on a relative value",
				'const rel = path.relative(a, b);\nif (rel.startsWith("...")) rel = "";',
			],
			[
				"the seam itself",
				'return !rel.startsWith("..") && !path.isAbsolute(rel);',
			],
			[
				"containment on a resolved path, not on a relative one",
				'const resolved = path.resolve(a, b);\nresolved.startsWith("..");',
			],
			[
				"a comment copy of the needle",
				'// const rel = path.relative(cwd, file);\n// return !rel.startsWith("..");',
			],
			[
				"a string copy of the needle",
				"const doc = 'const rel = path.relative(a, b); rel.startsWith(\"..\")';",
			],
			[
				"a `..`-leading DIRECTORY name, not a containment test",
				'const dirName = "..foo";\ndirName.startsWith("..");',
			],
			[
				"a `..`-leading directory name compared with a path",
				'const dirName = "..foo";\nconst rel = path.relative(a, b);\nreturn rel === dirName;',
			],
			[
				"a parameter's caller-supplied spelling (the cross-function hand-off)",
				"function inside(relative: string): boolean {\n" +
					'  return !relative.startsWith("..");\n' +
					"}\n" +
					"inside(path.relative(a, b));",
			],
			[
				"the cross-drive arm alone, with no `..` literal",
				"const rel = path.relative(a, b);\nreturn path.isAbsolute(rel);",
			],
			[
				"a `..` literal that never meets the relative value",
				'const rel = path.relative(a, b);\nconst other = "..";\nreturn other === "..";',
			],
			[
				"a `..` literal inside an unrelated string",
				'const rel = path.relative(a, b);\nconst label = "a..b";\nreturn label === "a..b";',
			],
		];
		for (const [name, source] of clean)
			expect(rows(source).length, name).toBe(0);
	});

	it("never reports a parameter's spelling, even when a sibling binds the name", () => {
		const source =
			"function first(a: string, b: string) {\n" +
			"  const target = toPosix(path.relative(a, b));\n" +
			"  return target;\n" +
			"}\n" +
			"function second(target: string) {\n" +
			'  return target.startsWith("../");\n' +
			"}\n";
		expect(rows(source).length).toBe(0);
	});

	it("names the enclosing symbol, so a second test in one file is distinct", () => {
		const source =
			"function outer(a: string, b: string) {\n" +
			"  function inner(c: string, d: string) {\n" +
			'    return path.relative(c, d).startsWith("..");\n' +
			"  }\n" +
			"  return inner(a, b);\n" +
			"}\n" +
			'const rel = path.relative("/a", "/b");\n' +
			'rel.startsWith("..");\n';
		expect(anchors(source)).toEqual(["inner", "<module>"]);
	});

	/**
	 * #4882 review F3 (the CodeRabbit thread): the walk from a site meets
	 * `method_definition` BEFORE `class_declaration`, so `Alpha.run` and
	 * `Beta.run` both keyed as `run` and the census reported a collision.
	 */
	it("names the enclosing class of a member, so two same-named methods are distinct", () => {
		const source =
			"class Alpha {\n" +
			"  run(a: string, b: string) {\n" +
			'    return path.relative(a, b).startsWith("..");\n' +
			"  }\n" +
			"}\n" +
			"class Beta {\n" +
			"  run(c: string, d: string) {\n" +
			'    return path.relative(c, d) === "..";\n' +
			"  }\n" +
			"}\n";
		expect(anchors(source)).toEqual(["Alpha.run", "Beta.run"]);
	});

	it("gives a second predicate in one symbol its own ordinal", () => {
		const source =
			'it("checks both directions", () => {\n' +
			"  const forward = path.relative(root, prefix);\n" +
			'  expect(forward.startsWith("..")).toBe(true);\n' +
			"  const back = path.relative(prefix, root);\n" +
			'  expect(back.startsWith("..")).toBe(true);\n' +
			"});\n";
		expect(anchors(source)).toEqual([
			"checks both directions",
			"checks both directions#2",
		]);
	});

	it("treats one boolean chain as one predicate", () => {
		const source =
			"function inside(root: string, file: string) {\n" +
			"  const relative = p.relative(root, file);\n" +
			'  return relative && relative !== ".." && !relative.startsWith(".." + p.sep);\n' +
			"}\n";
		expect(rows(source).length).toBe(1);
	});
});
