/**
 * The path identity detector's own state table (#4689): one named case per
 * admitted form, per refused form, and per plant its author did not design
 * for (an alias, an indirect call, a value reached through another binding;
 * AGENTS.md shape 69). The census over `clients/` is
 * `tests/config/path-identity-sweep.test.ts`.
 *
 * Recurrence guarded: a sweep that cannot see a spelling passes the defect it
 * exists to catch. Each `site` row is a form that once reached, or could
 * reach, a raw identity derivation outside `clients/path-utils.ts`; each
 * `clean` row is a form the sweep must not report, so a widened needle that
 * buries the population is caught here too.
 */
import { describe, expect, it } from "vitest";
import {
	type PathIdentityNeedle,
	scanPathIdentitySites,
} from "./path-identity-scan.js";

function needles(source: string): PathIdentityNeedle[] {
	return scanPathIdentitySites(source).map((site) => site.needle);
}

const SITE_ROWS: ReadonlyArray<[string, string, PathIdentityNeedle[]]> = [
	// raw-realpath, admitted forms
	["fs.realpathSync member call", "fs.realpathSync(p);", ["raw-realpath"]],
	["realpathSync.native", "fs.realpathSync.native(p);", ["raw-realpath"]],
	["fs.promises.realpath", "await fs.promises.realpath(p);", ["raw-realpath"]],
	[
		"named import",
		'import { realpath } from "node:fs/promises";',
		["raw-realpath"],
	],
	// plants: alias, indirect call, value through another binding
	[
		"plant: aliased import, then a call through the alias",
		'import { realpathSync as rp } from "node:fs";\nrp(x);',
		["raw-realpath"],
	],
	[
		"plant: indirect call through a bound reference",
		"const f = fs.realpathSync;\nf(x);",
		["raw-realpath"],
	],
	[
		"plant: computed member with a string key",
		'fs["realpathSync"](x);',
		["raw-realpath"],
	],
	[
		"plant: computed member with an escaped string key",
		'fs["realpath\\u0053ync"](x);',
		["raw-realpath"],
	],
	[
		"plant: Reflect.get with the member name",
		'Reflect.get(fs, "realpath")(x);',
		["raw-realpath"],
	],
	[
		"plant: value reached through a destructured binding",
		"const { realpath } = fs.promises;\nawait realpath(x);",
		["raw-realpath", "raw-realpath"],
	],
	[
		"plant: the realpath binary spawned",
		'spawnSync("realpath", [x]);',
		["raw-realpath"],
	],
	// path-resolve-keyed, admitted forms
	[
		"Map.set keyed by path.resolve",
		"m.set(path.resolve(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"Set.has keyed by path.resolve",
		"s.has(path.resolve(f));",
		["path-resolve-keyed"],
	],
	[
		"a cast does not change the key",
		"m.get(path.resolve(f) as string);",
		["path-resolve-keyed"],
	],
	[
		"subscript keyed by path.resolve",
		"byPath[path.resolve(f)] = 1;",
		["path-resolve-keyed"],
	],
	[
		"new Set over a resolve mapper",
		"new Set(xs.map((p) => path.resolve(p)));",
		["path-resolve-keyed"],
	],
	[
		"new Map over resolve pairs",
		"new Map([[path.resolve(a), 1]]);",
		["path-resolve-keyed"],
	],
	[
		"nodePath and path.posix namespaces",
		"m.set(nodePath.resolve(f), 1);\nm.set(path.posix.resolve(f), 1);",
		["path-resolve-keyed", "path-resolve-keyed"],
	],
	// plants: alias, indirect call, value through another binding
	[
		"plant: aliased resolve import",
		'import { resolve as r } from "node:path";\nm.set(r(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: destructured resolve alias",
		"const { resolve: r } = path;\nm.set(r(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: bound resolve reference",
		"const r = path.resolve;\nm.set(r(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: Map.prototype.set.call",
		"Map.prototype.set.call(m, path.resolve(f), 1);",
		["path-resolve-keyed"],
	],
	[
		"plant: a mapper passed by reference",
		"new Set(xs.map(path.resolve));",
		["path-resolve-keyed"],
	],
	[
		"plant: value reached through a const binding",
		"const k = path.resolve(f);\nm.set(k, 1);",
		["path-resolve-keyed"],
	],
	// plants: a member read through a bracket with a literal key (review r5
	// LOW, Greptile PRRT_kwDORt8rec6u2wF3; live population 0 on 2026-10-21)
	[
		"plant: resolve called through a bracket key",
		'm.set(path["resolve"](f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a key method called through a bracket key",
		'm["set"](path.resolve(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: both through escaped and template bracket keys",
		"m[`has`](path['res\\u006flve'](f));",
		["path-resolve-keyed"],
	],
	[
		"plant: a bound resolve read through a bracket key",
		'const r = path["resolve"];\nm.set(r(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a bracket-key .call of a key method",
		'Map.prototype["set"]["call"](m, path.resolve(f), 1);',
		["path-resolve-keyed"],
	],
	[
		"plant: a bracket-key mapper inside new Set",
		'new Set(xs["map"](path["resolve"]));',
		["path-resolve-keyed"],
	],
	[
		"plant: binding in an enclosing function scope",
		"function g(f) {\n\tconst k = path.resolve(f);\n\treturn () => m.has(k);\n}",
		["path-resolve-keyed"],
	],
	// hand-rolled-upward-walk (#4966), refused forms
	[
		"while loop assigning the parent",
		"let c = d;\nwhile (c !== root) {\n\tc = path.dirname(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"do loop with a bare dirname import",
		'import { dirname } from "node:path";\ndo {\n\tc = dirname(c);\n} while (c !== root);',
		["hand-rolled-upward-walk"],
	],
	[
		"C-style for loop climbing in its update",
		"for (let c = d; c !== root; c = path.dirname(c)) {\n\tprobe(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"for-of with a counter and a carried parent",
		"for (const _ of depth) {\n\tc = path.dirname(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"recursive climb",
		"function up(d) {\n\tif (has(d)) return d;\n\treturn up(path.dirname(d));\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: an import alias of dirname",
		'import { dirname as up } from "node:path";\nwhile (c !== root) {\n\tc = up(c);\n}',
		["hand-rolled-upward-walk"],
	],
	[
		"plant: an indirect call through a bound reference",
		"const up = path.dirname;\nwhile (c !== root) {\n\tc = up(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: a destructured dirname bound to another name",
		"const { dirname } = path;\nconst up = dirname;\nwhile (c !== root) {\n\tc = up(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: a bound name bound again",
		"const first = path.dirname;\nconst again = first;\nwhile (c !== root) {\n\tc = again(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: a destructured alias",
		"const { dirname: up } = path;\nwhile (c !== root) {\n\tc = up(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: a bracket read of dirname",
		'while (c !== root) {\n\tc = path["dirname"](c);\n}',
		["hand-rolled-upward-walk"],
	],
	[
		"plant: a comma-expression callee",
		"while (c !== root) {\n\tc = (0, dirname)(c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: dirname.call",
		"while (c !== root) {\n\tc = path.dirname.call(path, c);\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: the parent held in another binding, then carried",
		"while (c !== root) {\n\tconst next = path.dirname(c);\n\tc = next;\n}",
		["hand-rolled-upward-walk"],
	],
	[
		"plant: the parent spelled as a .. segment",
		'while (c !== root) {\n\tc = path.resolve(c, "..");\n}',
		["hand-rolled-upward-walk"],
	],
	[
		"plant: the parent read from path.parse",
		"while (c !== root) {\n\tc = path.parse(c).dir;\n}",
		["hand-rolled-upward-walk"],
	],
];

const CLEAN_ROWS: ReadonlyArray<[string, string]> = [
	["the seam's own export", "realpathOrResolve(p);"],
	[
		"a comment naming the needle",
		"// fs.realpathSync(p) and m.set(path.resolve(f))\nx();",
	],
	["prose in a string", 'log("realpath failed for " + p);'],
	["a key through the seam", "m.set(normalizeMapKey(path.resolve(f)), 1);"],
	["a resolve value outside a key position", "m.set(k, path.resolve(f));"],
	["path.relative is not resolve", "m.set(path.relative(root, f), 1);"],
	[
		"a binding shadowed by a parameter",
		"const k = path.resolve(f);\nfunction g(k) {\n\treturn m.has(k);\n}",
	],
	[
		"a binding shadowed by a loop variable",
		"const k = path.resolve(f);\nfor (const k of keys) m.has(k);",
	],
	["a raw template with a backslash", "x.replaceAll(String.raw`\\.`, '.');"],
	["a bracket key that is not resolve", 'm.set(path["relative"](root, f), 1);'],
	["a bracket key that is not a key method", 'm["push"](path.resolve(f));'],
	[
		"a per-item dirname with only member writes",
		"for (const f of files) {\n\trec.dir = path.dirname(f);\n\tmap[f] = rec;\n}",
	],
	["a one-shot dirname outside any loop", "const d = path.dirname(f);"],
	[
		"a bare name bound to something that is not dirname",
		"const up = other;\nwhile (c !== root) {\n\tc = up(c);\n}",
	],
	[
		"the seam's own loop",
		"for (const dir of walkUpDirs(start)) {\n\tif (has(dir)) return dir;\n}",
	],
	[
		"a per-item dirname with no carried assignment",
		"for (const f of files) {\n\tout.add(path.dirname(f));\n}",
	],
	[
		"the seam's own loop, even holding a parent value and an assignment",
		"for (const dir of walkUpDirs(start)) {\n\tlast = path.dirname(dir);\n}",
	],
	[
		"a dirname in the iterable of a for-of",
		"for (const d of list(path.dirname(f))) {\n\tx = d;\n}",
	],
	[
		"a loop in another function than the dirname",
		"while (c) {\n\tconst g = () => path.dirname(f);\n\tc = g;\n}",
	],
	["a comment naming the climb", "// while (c) { c = path.dirname(c); }\nx();"],
	[
		"path.join without a .. segment",
		"while (c) {\n\tc = path.join(c, 'a');\n}",
	],
];

describe("path identity detector state table (#4689)", () => {
	for (const [name, source, expected] of SITE_ROWS)
		it(`site: ${name}`, () => {
			expect(needles(source)).toEqual(expected);
		});

	for (const [name, source] of CLEAN_ROWS)
		it(`clean: ${name}`, () => {
			expect(needles(source)).toEqual([]);
		});
});
