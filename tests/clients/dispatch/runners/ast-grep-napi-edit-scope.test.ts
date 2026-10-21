/**
 * #4481 — ast-grep must not turn unchanged, pre-existing findings into STOP
 * blockers on the first write to a file in a session.
 *
 * The delta baseline (`session.baseline.<file>`, clients/dispatch/dispatcher.ts)
 * only exists after a file's first dispatch, so on that first write every
 * finding counts as new. The tree-sitter runner already scoped its blocking
 * tier to the edited lines; the ast-grep-napi runner received the same
 * `ctx.modifiedRanges` and ignored them, so a `severity: error` rule on an
 * unchanged line blocked the agent (the reporter's `no-unknown-returns` STOP
 * after a one-constant edit). Both now gate on overlap between the match's
 * line span and the edited lines (`spanOverlapsModifiedRanges`), so an edit
 * inside a multi-line match still blocks (#4482 review r1 F1).
 *
 * These tests drive the real dispatcher (`createDispatchContext` +
 * `dispatchForFile`, one session fact store per file so the delta baseline
 * carries from one write to the next) with the real ast-grep-napi runner, the
 * real napi engine and the bundled rules, and the ranges a host `edit`
 * produces. Nothing is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { ModifiedRange } from "../../../../clients/dispatch/types.js";
import { resetNapiFallbackCoverageForTests } from "../../../../clients/lsp/pending-aux-coverage.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const RULE = "no-unknown-returns";

/** The reporter's shape: a constant on line 1 and a pre-existing
 *  `no-unknown-returns` (`severity: error`) violation on line 3. Line 2
 *  violates `no-any-type` (`severity: hint`), which only the substitute role
 *  evaluates. */
const SOURCE = [
	'export const CLIENT_VERSION = "1.0.50";',
	"export const loose: any = CLIENT_VERSION;",
	"export function dig(obj: Record<string, string>, key: string): unknown {",
	"\treturn obj[key];",
	"}",
	"",
].join("\n");
const CONSTANT_LINE = 1;
const HINT_RULE = "no-any-type";
const HINT_LINE = 2;
const FINDING_LINE = 3;
/** The line a later write appends after SOURCE's trailing newline. */
const LATER_LINE = 6;

/** `no-ast-grep` retires the auxiliary, so napi runs on the per-edit blocking
 *  floor; `no-lsp` keeps real language servers out of the suite. */
const PER_EDIT_FLAGS = {
	getFlag: (flag: string) => flag === "no-lsp" || flag === "no-ast-grep",
};
/** The auxiliary stays enabled but has not published, so napi runs as its
 *  substitute at the LSP's severity floor (#2336). */
const SUBSTITUTE_FLAGS = { getFlag: (flag: string) => flag === "no-lsp" };

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv();
});
afterAll(() => env?.cleanup());
beforeEach(() => {
	resetNapiFallbackCoverageForTests();
});

/** One file's session: the facts (and so the delta baseline) outlive a write. */
function session(flags: { getFlag: (flag: string) => boolean }) {
	const facts = new FactStore();
	const registry = new RunnerRegistry();
	registry.register(astGrepNapiRunner);
	return (filePath: string, ranges: ModifiedRange[], blockingOnly = true) =>
		dispatchForFile(
			createDispatchContext(
				filePath,
				env.cwd,
				flags,
				facts,
				blockingOnly,
				ranges,
			),
			[{ mode: "all", runnerIds: ["ast-grep-napi"] }],
			registry,
		);
}

function napiFindings(
	diagnostics: readonly { tool?: string; rule?: string; line?: number }[],
	rule = RULE,
): { rule?: string; line?: number }[] {
	return diagnostics.filter(
		(d) => d.tool === "ast-grep-napi" && d.rule === rule,
	);
}

// #4484 round 2: the edit-range gate decides delivery only, so what it
// withholds rides out as `stillObserved`, bounded like delivered matches.
describe("ast-grep-napi withheld matches (#4484 round 2)", () => {
	// Recurrence: the gate dropped what it withheld, so the record lost a
	// blocker an unrelated edit left in place (the witness's row 7).
	it("hands the withheld blocker on as still observed, stamped with its runner", async () => {
		const { filePath } = env.addFile("withheld-one.ts", SOURCE);

		const result = await session(PER_EDIT_FLAGS)(filePath, [
			{ start: CONSTANT_LINE, end: CONSTANT_LINE },
		]);

		expect(napiFindings(result.stillObserved ?? [])).toEqual([
			expect.objectContaining({
				rule: RULE,
				line: FINDING_LINE,
				runnerId: "ast-grep-napi",
			}),
		]);
	}, 30_000);

	// Recurrence: an unbounded withheld list on a file full of old findings
	// grows with the file, not with the edit.
	it("keeps at most the per-rule cap of withheld matches", async () => {
		const many = Array.from(
			{ length: 15 },
			(_, i) =>
				`export function dig${i}(obj: Record<string, string>, key: string): unknown {\n\treturn obj[key];\n}`,
		).join("\n");
		const { filePath } = env.addFile(
			"withheld-many.ts",
			`export const CLIENT_VERSION = "1.0.50";\n${many}\n`,
		);

		const result = await session(PER_EDIT_FLAGS)(filePath, [
			{ start: CONSTANT_LINE, end: CONSTANT_LINE },
		]);

		expect(napiFindings(result.stillObserved ?? [])).toHaveLength(10);
	}, 30_000);
});

describe.each([
	["per-edit floor", PER_EDIT_FLAGS],
	["LSP substitute", SUBSTITUTE_FLAGS],
])("ast-grep-napi edit scope (#4481, %s)", (label, flags) => {
	const slug = label.replace(/\W+/g, "-");

	// Recurrence: #4481 — a one-constant edit, the file's first dispatch this
	// session, STOPped on an unchanged `no-unknown-returns` line.
	it("does not block on an old finding at an unchanged line on the first write", async () => {
		const { filePath } = env.addFile(`first-write-${slug}.ts`, SOURCE);

		const result = await session(flags)(filePath, [
			{ start: CONSTANT_LINE, end: CONSTANT_LINE },
		]);

		expect(napiFindings(result.blockers)).toEqual([]);
		expect(result.blockerOutput).not.toContain(RULE);
	}, 30_000);

	// Recurrence: an edit-scope gate that drops in-range findings too (or keys
	// off the wrong line base) would hide a blocker the write itself introduced.
	it("still blocks a finding on the changed line, on the first and a later write", async () => {
		const { filePath } = env.addFile(`changed-line-${slug}.ts`, SOURCE);

		const write = session(flags);
		const first = await write(filePath, [
			{ start: FINDING_LINE, end: FINDING_LINE },
		]);
		expect(napiFindings(first.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);

		// A later write adds a second violation on a new line it changed: the
		// baseline now exists, and the new finding must still block.
		env.addFile(
			`changed-line-${slug}.ts`,
			`${SOURCE}export const read = (): unknown => undefined;\n`,
		);
		const later = await write(filePath, [
			{ start: LATER_LINE, end: LATER_LINE },
		]);
		expect(napiFindings(later.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: LATER_LINE }),
		]);
	}, 30_000);

	// Recurrence: a whole-file write (no partial ranges) must keep blocking —
	// for a genuinely new file the write introduced every line.
	it("blocks on a whole-file write", async () => {
		const { filePath } = env.addFile(`whole-file-${slug}.ts`, SOURCE);

		const result = await session(flags)(filePath, [
			{ start: 1, end: SOURCE.split("\n").length },
		]);

		expect(napiFindings(result.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);
	}, 30_000);
});

describe("ast-grep-napi edit scope outside the blocking tier (#4481)", () => {
	// Recurrence: a gate that also scoped warning-tier rules would cut the
	// substitute's LSP-equivalent coverage (#2336) on every unchanged line.
	it("keeps a hint finding on an unchanged line in the LSP substitute role", async () => {
		const { filePath } = env.addFile("hint-unchanged.ts", SOURCE);

		const result = await session(SUBSTITUTE_FLAGS)(filePath, [
			{ start: CONSTANT_LINE, end: CONSTANT_LINE },
		]);

		expect(napiFindings(result.warnings, HINT_RULE)).toEqual([
			expect.objectContaining({ rule: HINT_RULE, line: HINT_LINE }),
		]);
	}, 30_000);

	// Recurrence: a gate keyed off the ranges alone would drop findings from a
	// full (non-blocking) pass that happens to carry the write's ranges.
	it("keeps an unchanged-line error finding when the pass is not blocking-only", async () => {
		const { filePath } = env.addFile("full-pass.ts", SOURCE);

		const result = await session(PER_EDIT_FLAGS)(
			filePath,
			[{ start: CONSTANT_LINE, end: CONSTANT_LINE }],
			false,
		);

		expect(napiFindings(result.diagnostics)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);
	}, 30_000);
});

/** `no-implied-eval` (`severity: error`, inside the per-edit floor's rule
 *  set): the string-code `setTimeout(...)` call starts on line 2 and ends on
 *  line 5; the string argument sits on line 3. */
const EVAL_SOURCE = [
	"export function later() {",
	"\tsetTimeout(",
	'\t\t"tick()",',
	"\t\t10,",
	"\t);",
	"}",
	"",
].join("\n");
const EVAL_RULE = "no-implied-eval";
const EVAL_START = 2;

/** `array-callback-return` (the review's probe; outside the per-edit floor's
 *  complexity cap, so only the substitute evaluates it): the `.map` callback
 *  on lines 2-4 returns nothing. */
const CALLBACK_SOURCE = [
	"export function names(items: string[]) {",
	"\treturn items.map((item) => {",
	"\t\titem.trim();",
	"\t});",
	"}",
	"",
].join("\n");
const CALLBACK_RULE = "array-callback-return";

describe.each([
	["per-edit floor", PER_EDIT_FLAGS],
	["LSP substitute", SUBSTITUTE_FLAGS],
])("ast-grep-napi multi-line match span (#4481 r2, %s)", (label, flags) => {
	const slug = label.replace(/\W+/g, "-");

	// Recurrence: #4482 review r1 F1 — the edit put the string on line 3 and so
	// caused the finding, but it is anchored at the call's start line (2), so a
	// start-line gate dropped a blocker the edit introduced.
	it("blocks a match whose span contains the edit while its start line is unchanged", async () => {
		const { filePath } = env.addFile(`span-inside-${slug}.ts`, EVAL_SOURCE);

		const result = await session(flags)(filePath, [{ start: 3, end: 3 }]);

		expect(napiFindings(result.blockers, EVAL_RULE)).toEqual([
			expect.objectContaining({ rule: EVAL_RULE, line: EVAL_START }),
		]);
	}, 30_000);

	// Recurrence: a span gate that over-widened (every multi-line match, or the
	// whole file) would bring back the #4481 STOP on an untouched construct.
	it("does not block a multi-line match wholly outside the edit", async () => {
		const { filePath } = env.addFile(`span-outside-${slug}.ts`, EVAL_SOURCE);

		const result = await session(flags)(filePath, [{ start: 6, end: 6 }]);

		expect(napiFindings(result.blockers, EVAL_RULE)).toEqual([]);
	}, 30_000);
});

// Recurrence: #4482 review r1 F1 probe 1 verbatim — removing `return` inside
// the callback (line 3) dropped `array-callback-return@2` in the substitute.
it("blocks the review's array-callback-return probe in the LSP substitute role (#4481 r2)", async () => {
	const { filePath } = env.addFile("span-callback.ts", CALLBACK_SOURCE);

	const result = await session(SUBSTITUTE_FLAGS)(filePath, [
		{ start: 3, end: 3 },
	]);

	expect(napiFindings(result.blockers, CALLBACK_RULE)).toEqual([
		expect.objectContaining({ rule: CALLBACK_RULE, line: 2 }),
	]);
}, 30_000);

// Recurrence: the span's end line of a match inside an HTML `<script>` body is
// body-relative and must be mapped onto the file (#2347); an unmapped end
// would drop a blocker the edit caused inside the script.
it("blocks a multi-line match inside an HTML script body whose span contains the edit (#4481 r2)", async () => {
	const { filePath } = env.addFile(
		"span-script.html",
		[
			"<html>",
			"<script>",
			"setTimeout(",
			'\t"tick()",',
			"\t10,",
			");",
			"</script>",
			"</html>",
			"",
		].join("\n"),
	);

	const result = await session(PER_EDIT_FLAGS)(filePath, [
		{ start: 4, end: 4 },
	]);

	expect(napiFindings(result.blockers, "no-implied-eval-js")).toEqual([
		expect.objectContaining({ rule: "no-implied-eval-js", line: 3 }),
	]);
}, 30_000);
