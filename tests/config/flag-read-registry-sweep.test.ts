/**
 * Every flag name the code reads is a name the registry registers (#4946).
 *
 * RECURRENCE THIS PREVENTS: #4944 and #4946. `pi.getFlag("no-ast-grep")`,
 * `killSwitchFlag: "no-typos"` and `getFlag("lens-spotbugs")` were read while
 * no `clients/lens-flag-registry.ts` entry registered the name, so the host
 * answered `undefined` and the switch or opt-in behind it could not be set.
 * The detector, its admitted forms and its residuals are in
 * `tests/support/flag-read-scan.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LENS_FLAGS } from "../../clients/lens-flag-registry.js";
import { censusSourceFiles } from "../support/ast-census.js";
import {
	type FlagReadAdmission,
	scanFlagReads,
} from "../support/flag-read-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Refused sites the tree admits, each keyed `<file>:<form>`. `count` is the
 * number of sites the row admits: a key with more sites reds every one, one
 * with fewer reds as stale.
 */
const ADMITTED: FlagReadAdmission = {
	"clients/dispatch/auxiliary-lsp.ts:getFlag(profile.killSwitchFlag)": {
		count: 1,
		reason:
			"`profile` is an `AuxiliaryLspProfile`; its `killSwitchFlag` is only ever assigned by the profile table's pairs, each checked as a literal against the registry",
	},
	"clients/dispatch/auxiliary-lsp.ts:getFlag(profile.optInFlag)": {
		count: 1,
		reason:
			"`profile` is an `AuxiliaryLspProfile`; its `optInFlag` is only ever set by the profile table (one pair, `lens-fallow`, a registered literal), and the read is guarded by `!== undefined`",
	},
	"clients/runtime-session.ts:analyzerEnabled(flag)": {
		count: 1,
		reason:
			"`flag` is `no-${name}` for a startup task name; `opengrep` and `trivy` are excluded by the condition, and every other task name is a registry analyzer (`no-knip`, `no-jscpd`, ...)",
	},
	"index.ts:getLensFlag as right-hand side of an assignment": {
		count: 1,
		reason:
			"`_bridgeGetFlag = getLensFlag` stores the activation's reader for the bridges; the bridges pass it only the bridge's flag name",
	},
	"index.ts:getBridgeFlag(_bridgeGetFlag)": {
		count: 3,
		reason:
			"`getBridgeFlag(getter, bridge, name)` takes the getter first; its `name` defaults to the registered `no-read-guard` and is otherwise a forwarded parameter",
	},
};

function liveFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const file of censusSourceFiles([
		path.join(ROOT, "clients"),
		path.join(ROOT, "tools"),
		path.join(ROOT, "mcp"),
		path.join(ROOT, "index.ts"),
	])) {
		files[path.relative(ROOT, file).split(path.sep).join("/")] =
			fs.readFileSync(file, "utf8");
	}
	return files;
}

const registry = LENS_FLAGS.map((spec) => spec.name);

describe("flag reads name registered flags (#4946)", () => {
	it(
		"reads no flag name the registry does not register, apart from the admitted forms",
		() => {
			const scan = scanFlagReads(liveFiles(), registry, ADMITTED);
			expect(
				scan.unadmitted.map((s) => `${s.file}:${s.line} ${s.detail}`),
			).toEqual([]);
			expect(scan.staleAdmissions).toEqual([]);
			// A scan that read nothing would pass the case above for the wrong reason.
			expect(scan.literalReads.length).toBeGreaterThan(50);
			// The three names #4946 found are read, and read as registered ones.
			const read = new Set(scan.literalReads.map((r) => r.name));
			for (const name of ["no-typos", "no-zizmor", "lens-spotbugs"])
				expect(read.has(name), name).toBe(true);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

/** One source under a one-flag registry, with no admissions unless given. */
const scanOne = (source: string, admitted: FlagReadAdmission = {}) =>
	scanFlagReads({ "x.ts": source }, ["no-lsp"], admitted);
const refused = (source: string) =>
	scanOne(source).unadmitted.map((s) => s.detail);

describe("the detector's admitted forms and refusals (#4946)", () => {
	it("admits a registered literal and refuses an unregistered one (the #4946 shape)", () => {
		expect(refused('pi.getFlag("no-lsp");')).toEqual([]);
		expect(refused('pi.getFlag("no-typos");')).toEqual([
			"unregistered getFlag(...) `no-typos`",
		]);
		expect(refused('getLensFlag("lens-spotbugs");')).toEqual([
			"unregistered getLensFlag(...) `lens-spotbugs`",
		]);
		expect(refused('ctx.pi?.getFlag?.("no-zizmor");')).toEqual([
			"unregistered getFlag(...) `no-zizmor`",
		]);
		expect(refused('pi.getFlag(\n\t"no-zizmor",\n);')).toEqual([
			"unregistered getFlag(...) `no-zizmor`",
		]);
	});

	it("reads a template literal with no substitution as the literal it is", () => {
		expect(refused("pi.getFlag(`no-lsp`);")).toEqual([]);
		expect(refused("pi.getFlag(`no-typos`);")).toEqual([
			"unregistered getFlag(...) `no-typos`",
		]);
	});

	it("refuses an unregistered killSwitchFlag literal and admits a registered one", () => {
		expect(refused('const p = { killSwitchFlag: "no-typos" };')).toEqual([
			"unregistered killSwitchFlag `no-typos`",
		]);
		expect(refused('const p = { killSwitchFlag: "no-lsp" };')).toEqual([]);
		expect(refused("const p = { killSwitchFlag: name };")).toEqual([
			"killSwitchFlag without a literal name",
		]);
	});

	it("covers every <x>Flag profile field", () => {
		expect(refused('const p = { optInFlag: "no-lsp" };')).toEqual([]);
		expect(refused('const p = { optInFlag: "lens-fallow" };')).toEqual([
			"unregistered optInFlag `lens-fallow`",
		]);
		expect(refused("const p = { optInFlag: name };")).toEqual([
			"optInFlag without a literal name",
		]);
	});

	describe("a <x>Flag field is a flag name however it is written (#4946 review r1, F2)", () => {
		// Recurrence: r1 scanned only object-literal pairs and admitted any
		// `getFlag(<record>.<x>Flag)` once some pair of that name existed anywhere.
		// A member assignment, a shorthand field and a read off another record
		// passed with no site. Every name in a field position now goes through one
		// check, and a container the check does not list is a refusal.
		const ghost = "unregistered killSwitchFlag `no-ghost`";

		it("refuses a member assignment, plain, compound and string-keyed", () => {
			const record = "const p: Record<string, unknown> = {};\n";
			expect(refused(`${record}p.killSwitchFlag = "no-ghost";`)).toEqual([
				ghost,
			]);
			expect(refused(`${record}p["killSwitchFlag"] = "no-ghost";`)).toEqual([
				ghost,
			]);
			expect(refused(`${record}p.killSwitchFlag ??= "no-ghost";`)).toEqual([
				ghost,
			]);
			expect(refused(`${record}p.killSwitchFlag = "no-lsp";`)).toEqual([]);
			expect(refused(`${record}p.killSwitchFlag = name;`)).toEqual([
				"killSwitchFlag without a literal name",
			]);
		});

		it("refuses a shorthand field: it carries a binding, never a literal", () => {
			expect(
				refused(
					'const killSwitchFlag = "no-ghost";\nconst p = { killSwitchFlag };',
				),
			).toEqual(["killSwitchFlag without a literal name"]);
		});

		it("refuses a quoted, computed or class-field spelling of a pair", () => {
			expect(refused('const p = { "killSwitchFlag": "no-ghost" };')).toEqual([
				ghost,
			]);
			expect(refused('const p = { ["killSwitchFlag"]: "no-ghost" };')).toEqual([
				ghost,
			]);
			expect(refused('class A { killSwitchFlag = "no-ghost"; }')).toEqual([
				ghost,
			]);
			expect(refused('class A { killSwitchFlag = "no-lsp"; }')).toEqual([]);
		});

		it("refuses an accessor or method that defines the field: a getter returns the name", () => {
			expect(
				refused('const p = { get killSwitchFlag() { return "no-ghost"; } };'),
			).toEqual(["killSwitchFlag as form `method_definition`"]);
			expect(
				refused('class A { get optInFlag() { return "no-ghost"; } }'),
			).toEqual(["optInFlag as form `method_definition`"]);
		});

		it("refuses a destructured field: a read of the record's name", () => {
			expect(refused("const { killSwitchFlag } = p;")).toEqual([
				"killSwitchFlag as form `object_pattern`",
			]);
			expect(refused("const { killSwitchFlag: k } = p;")).toEqual([
				"killSwitchFlag as form `pair_pattern`",
			]);
			expect(refused('const { killSwitchFlag = "no-ghost" } = p;')).toEqual([
				ghost,
			]);
		});

		it("admits a record read only through a counted row, whichever record carries it", () => {
			const pair = 'const p = { killSwitchFlag: "no-lsp" };\n';
			// A pair of that name elsewhere no longer admits a read off another record.
			expect(
				refused(
					`${pair}const q: any = somewhere();\ngetFlag(q.killSwitchFlag);`,
				),
			).toEqual(["getFlag(q.killSwitchFlag)"]);
			expect(refused("getFlag(p.killSwitchFlag);")).toEqual([
				"getFlag(p.killSwitchFlag)",
			]);
			const row = {
				"x.ts:getFlag(q.killSwitchFlag)": { count: 1, reason: "test" },
			};
			const read = `${pair}getFlag(q.killSwitchFlag);`;
			expect(scanOne(read, row).unadmitted).toEqual([]);
			expect(scanOne(read, row).staleAdmissions).toEqual([]);
			// The row names one receiver and one count: another receiver or a second
			// site is refused.
			expect(
				scanOne(`${read}\ngetFlag(r.killSwitchFlag);`, row).unadmitted.map(
					(s) => s.detail,
				),
			).toEqual(["getFlag(r.killSwitchFlag)"]);
			expect(
				scanOne(`${read}\ngetFlag(q.killSwitchFlag);`, row).unadmitted,
			).toHaveLength(2);
		});

		it("admits a read that cannot pass the name on, and refuses one that can", () => {
			for (const read of [
				"if (p.killSwitchFlag) {}",
				"const a = !p.killSwitchFlag;",
				"const a = p.killSwitchFlag === undefined;",
				"const a = p.killSwitchFlag && ok;",
				"const a = p.killSwitchFlag ? 1 : 2;",
			])
				expect(refused(read), read).toEqual([]);
			expect(refused("const n = p.killSwitchFlag;")).toEqual([
				"p.killSwitchFlag read as form `variable_declarator`",
			]);
			expect(refused("const n = ok && p.killSwitchFlag;")).toEqual([
				"p.killSwitchFlag read as an operand of `&&`",
			]);
			expect(refused('const n = p.killSwitchFlag ?? "no-ghost";')).toEqual([
				"p.killSwitchFlag read as an operand of `??`",
			]);
			expect(refused("use(p.killSwitchFlag);")).toEqual([
				"p.killSwitchFlag read as an argument of `use`",
			]);
		});

		it("leaves type-level fields, methods and plain locals alone", () => {
			expect(refused("interface I { killSwitchFlag?: string }")).toEqual([]);
			expect(refused('pi.registerFlag("no-lsp", {});')).toEqual([]);
			expect(
				refused("const applyFlag = true;\nuse(applyFlag, !applyFlag);"),
			).toEqual([]);
		});
	});

	it("takes a registerFlag literal as a registered name", () => {
		expect(
			refused('pi.registerFlag("no-tool", {});\npi.getFlag("no-tool");'),
		).toEqual([]);
	});

	it("reads code, not prose: a comment or a string quoting a read is no read", () => {
		expect(
			refused('// pi.getFlag("no-typos")\n/* getFlag("no-zizmor") */'),
		).toEqual([]);
		expect(refused("const doc = 'call getFlag(\"no-typos\") first';")).toEqual(
			[],
		);
		expect(refused('const doc = `getFlag("no-typos")`;')).toEqual([]);
		// A template's substitution is code, so a read there is a read.
		expect(refused('const m = `${pi.getFlag("no-typos")}`;')).toEqual([
			"unregistered getFlag(...) `no-typos`",
		]);
	});

	describe("spellings the author did not design for", () => {
		it("refuses an alias bound to another name", () => {
			expect(refused('const g = pi.getFlag;\ng("no-typos");')).toEqual([
				"getFlag as right-hand side of a binding",
			]);
		});

		it("refuses an alias through a destructuring rename", () => {
			expect(refused('const { getFlag: g } = pi;\ng("no-typos");')).toEqual([
				"getFlag as form `pair_pattern`",
			]);
		});

		it("refuses an indirect call through call, apply and bind", () => {
			for (const via of ["call", "apply", "bind"])
				expect(refused(`pi.getFlag.${via}(pi, "no-typos");`), via).toEqual([
					"getFlag as object of `." + via + "`",
				]);
		});

		it("refuses a value reached through another binding", () => {
			expect(refused('const name = "no-typos";\npi.getFlag(name);')).toEqual([
				"pi.getFlag(name)",
			]);
			expect(refused("pi.getFlag(`no-${task}`);")).toEqual([
				"pi.getFlag(`no-${task}`)",
			]);
			expect(refused('pi.getFlag("no-" + task);')).toEqual([
				'pi.getFlag("no-" + task)',
			]);
		});

		it("refuses a string-keyed access to the reader", () => {
			expect(refused('pi["getFlag"]("no-typos");')).toEqual([
				"computed reader `[getFlag]`",
			]);
		});

		it("refuses a reader handed on under another key or returned", () => {
			expect(refused("const o = { read: getFlag };")).toEqual([
				"getFlag as pair value under another key `read`",
			]);
			expect(refused("const r = cond ? getFlag : other;")).toEqual([
				"getFlag as ternary branch",
			]);
		});

		it("follows a forwarder bound to a name, so its callers are scanned", () => {
			const forwarder =
				"const enabled = (flag: string): boolean => !deps.getFlag(flag);\n";
			expect(refused(`${forwarder}enabled("no-lsp");`)).toEqual([]);
			expect(refused(`${forwarder}enabled("no-typos");`)).toEqual([
				"unregistered enabled(...) `no-typos`",
			]);
			expect(
				refused(
					'function enabled(flag: string) { return pi.getFlag(flag); }\nenabled("no-typos");',
				),
			).toEqual(["unregistered enabled(...) `no-typos`"]);
		});
	});

	describe("an admission row admits a stated number of sites", () => {
		const twoSites = "pi.getFlag(a);\npi.getFlag(b);";
		const row = (count: number): FlagReadAdmission => ({
			"x.ts:pi.getFlag(a)": { count, reason: "test" },
			"x.ts:pi.getFlag(b)": { count, reason: "test" },
		});

		it("admits the stated count under each key", () => {
			const scan = scanOne(twoSites, row(1));
			expect(scan.unadmitted).toEqual([]);
			expect(scan.staleAdmissions).toEqual([]);
		});

		it("refuses every site of a key that has more sites than its row admits", () => {
			const scan = scanOne("pi.getFlag(a);\npi.getFlag(a);", {
				"x.ts:pi.getFlag(a)": { count: 1, reason: "test" },
			});
			expect(scan.unadmitted).toHaveLength(2);
		});

		it("reports a row that admits more sites than the tree has", () => {
			expect(scanOne(twoSites, row(2)).staleAdmissions).toEqual([
				"x.ts:pi.getFlag(a)",
				"x.ts:pi.getFlag(b)",
			]);
		});
	});
});
