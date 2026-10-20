/**
 * #4597: a record the `## Observability` section names must be read back by a
 * test. `docs/pi-lens-fixer.md:117` required it and nothing checked it, so 3 of
 * the 29 record-naming bodies the 2026-10-11..2026-10-18 audit read named a
 * record no test reads (`cascade_pending_rendered` and
 * `blocker-position-unaligned` live in this repository's own history).
 *
 * The rule is driven through `lintPrBody`, the seam every host calls, with the
 * two probes it uses injected: `headFiles` supplies the head tree's bytes and
 * `git` answers the two `grep -l` calls. Nothing here re-implements the rule's
 * own decisions, so a case fails when the rule changes, not when a helper does.
 */
import { describe, expect, it, vi } from "vitest";
import { lintPrBody } from "../../scripts/check-pr-body.mjs";
import { vitestCollects } from "../support/vitest-collection.js";

// A docs-only diff: truthy, so the rule runs, and holding no runtime hunk, so
// the record-naming rule beside it stays out of the way.
const DOCS_DIFF = [
	"diff --git a/docs/notes.md b/docs/notes.md",
	"index 1111111..2222222 100644",
	"--- a/docs/notes.md",
	"+++ b/docs/notes.md",
	"@@ -1,0 +1,1 @@",
	"+a note",
].join("\n");

const RUNTIME_FILE = "clients/fixture-records.ts";
const TEST_FILE = "tests/clients/fixture-records.test.ts";

function body(observability: string): string {
	return [
		"## Summary",
		"The rule refuses a body that names a record no test reads.",
		"",
		"## Tests",
		"Covered by the cases in this file.",
		"",
		"## Blast radius",
		"Limited to the PR-body lint.",
		"",
		"## Class sweep",
		"none: no runtime code is touched by this fixture.",
		"",
		"## Observability",
		observability,
	].join("\n");
}

/** The runtime source a candidate record must be harvested from. */
function runtimeSource(records: readonly string[]): string {
	return records
		.map(
			(record) =>
				`export function emit${record.replace(/\W/g, "")}() {\n\tlogLatency({ phase: "${record}", result: "ok" });\n}`,
		)
		.join("\n");
}

type Case = {
	observability: string;
	records?: readonly string[];
	/** Runtime source in place of `records`' `logLatency` rows (a wrapper whose
	 *  field is not a record identity, for instance). */
	runtime?: string;
	tests?: Readonly<Record<string, string>>;
	/** Files the tests-side grep reports, in place of the real one. */
	testHits?: readonly string[];
	git?: (args: string[]) => string;
};

function lint({
	observability,
	records = [],
	runtime,
	tests = {},
	testHits = Object.keys(tests),
	git,
}: Case) {
	const headFiles = new Map<string, string>();
	if (runtime !== undefined) headFiles.set(RUNTIME_FILE, runtime);
	else if (records.length) headFiles.set(RUNTIME_FILE, runtimeSource(records));
	for (const [file, source] of Object.entries(tests))
		headFiles.set(file, source);
	return lintPrBody(body(observability), {
		diff: DOCS_DIFF,
		cwd: process.cwd(),
		headFiles,
		git:
			git ??
			((args: string[]) => {
				if (args[0] !== "grep") throw new Error(`unexpected git ${args[0]}`);
				return args.includes("tests") ? testHits.join("\n") : RUNTIME_FILE;
			}),
	});
}

function ruleErrors(result: { errors: string[] }): string[] {
	return result.errors.filter((error) => error.includes("#4597"));
}

describe("#4597 a named observability record must be read by a test", () => {
	it("refuses a record literal no test reads", () => {
		const result = lint({
			observability:
				"The record is `fixture_record_emitted`, sent to latency.log.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'it("notes the phase", () => {\n\tconst note = "elsewhere";\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([
			expect.stringContaining(
				"`fixture_record_emitted`, which no test under tests/ reads",
			),
		]);
		expect(result.valid).toBe(false);
	});

	it("does not count a comment that quotes the record", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'it("records the phase", () => {\n\t// fixture_record_emitted names the row\n\texpect(1).toBe(1);\n});\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it("does not count a string the test never asserts or matches", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'it("keeps a note", () => {\n\tconst note = "fixture_record_emitted";\n\tnotice(note);\n});\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it("does not count a record shipped inside a static fixture", () => {
		// The #4550 shape: the phase reaches an assertion only through a
		// captured log file, so renaming the emission would leave the test green.
		const fixture = "tests/fixtures/logs/latency.log";
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[fixture]:
					'{"type":"phase","phase":"fixture_record_emitted","result":"ok"}\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it("does not count a checked-in PR-body fixture", () => {
		// #3013: a body under test lives under the scanned `tests/` root, so an
		// unread fixture body would let a PR pass on its own quoted text.
		const fixture = "tests/fixtures/ci-pr-bodies/pr-9999.md";
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[fixture]:
					'## Observability\n\n    expect(row.phase).toBe("fixture_record_emitted");\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it.each([
		[
			"a matcher argument",
			'it("reads the phase", () => {\n\texpect(rows.map((row) => row.phase)).toContain("fixture_record_emitted");\n});\n',
		],
		[
			"an equality against the record key",
			'it("filters the phase", () => {\n\tconst kept = rows.filter((row) => row.phase === "fixture_record_emitted");\n\texpect(kept).toHaveLength(1);\n});\n',
		],
		[
			"a helper call inside the assertion",
			'it("reads the rows", async () => {\n\texpect(await rows(target, "fixture_record_emitted")).toHaveLength(1);\n});\n',
		],
		[
			"an assertion on the raw NDJSON line",
			'it("reads the sink", () => {\n\tconst lines = readFileSync(logPath, "utf8").split("\\n");\n\texpect(lines.filter((line) => line.includes(\'"fixture_record_emitted"\'))).toHaveLength(1);\n});\n',
		],
		[
			"an expected row",
			'it("matches the row", () => {\n\texpect(rows).toEqual([{ phase: "fixture_record_emitted" }]);\n});\n',
		],
		[
			"a case label",
			'it("classifies the phase", () => {\n\tswitch (row.phase) {\n\t\tcase "fixture_record_emitted":\n\t\t\treturn 1;\n\t}\n\treturn 0;\n});\n',
		],
	])("counts %s as a read-back", (_name, source) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: { [TEST_FILE]: source },
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("counts a record bound to a constant the test compares", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'const RECORD_PHASE = "fixture_record_emitted";\n\nit("reads the phase", () => {\n\tconst kept = rows.filter((row) => row.phase === RECORD_PHASE);\n\texpect(kept).toHaveLength(1);\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("counts a record spelled in test code", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'import { fixture_record_emitted } from "./module.js";\n\nit("reads the phase", () => {\n\texpect(fixture_record_emitted).toBe("row");\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("names only the records that are missing", () => {
		const result = lint({
			observability:
				"The records are `fixture_record_read` and `fixture_record_unread`.",
			records: ["fixture_record_read", "fixture_record_unread"],
			tests: {
				[TEST_FILE]:
					'it("reads one phase", () => {\n\texpect(row.phase).toBe("fixture_record_read");\n});\n',
			},
		});
		const [error] = ruleErrors(result);
		expect(error).toContain("`fixture_record_unread`");
		expect(error).not.toContain("`fixture_record_read`");
	});

	it("leaves `none: <reason>` and a section with no record literal alone", () => {
		const result = lint({
			observability:
				"none: this fixture adds no runtime record and no failure path.",
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("ignores a span that is not a record literal", () => {
		const result = lint({
			observability:
				"See `docs/pi-lens-fixer.md:117`, `classifyJsTsGlobalScope` and `npm run lint`.",
			records: ["fixture_record_emitted"],
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("ignores a record-shaped span the runtime never emits", () => {
		// The shape alone is not a record: a hand-written literal that no
		// `logLatency`/`logCascade`/ledger call carries cannot be read back, so
		// the rule has nothing to require of it.
		const result = lint({
			observability: "The record is `no_runtime_emits_this_4597`.",
			records: ["fixture_record_emitted"],
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("ignores a record literal named only inside a fenced block", () => {
		const result = lint({
			observability:
				"```text\nThe record is `fixture_record_emitted`.\n```\nNo record is named here.",
			records: ["fixture_record_emitted"],
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	// F1 (review round 1): a title, a `todo` and any other call argument are not
	// read-backs. Each of these put the name where the reviewed head matched, and
	// a rename of the emission left the suite green.
	it.each([
		[
			"a test title",
			'it("fixture_record_emitted", () => {\n\texpect(1).toBe(1);\n});\n',
		],
		["an `it.todo` title", 'it.todo("fixture_record_emitted");\n'],
		[
			"a describe title",
			'describe("fixture_record_emitted", () => {\n\tit("notes it", () => {\n\t\texpect(1).toBe(1);\n\t});\n});\n',
		],
		[
			"a console.log argument",
			'it("logs the phase", () => {\n\tconsole.log("fixture_record_emitted");\n\texpect(1).toBe(1);\n});\n',
		],
		[
			"a template-literal title",
			"it(`fixture_record_emitted ${count}`, () => {\n\texpect(1).toBe(1);\n});\n",
		],
		[
			"a call argument nobody asserts",
			'it("notes the rows", async () => {\n\tconst [row] = await rows(target, "fixture_record_emitted");\n\texpect(row).toBeDefined();\n});\n',
		],
		// The plant nobody listed: a title that compares the name, and a chain of
		// two modifiers where only the first is one the rule can prove live.
		[
			"a record compared inside a title",
			'it(String(count) === "fixture_record_emitted" ? "a" : "b", () => {\n\texpect(1).toBe(1);\n});\n',
		],
		[
			"a test behind a chain that ends in `.skip`",
			'it.concurrent.skip("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
	])("does not count %s as a read-back", (_name, source) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: { [TEST_FILE]: source },
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	// F2 (review round 1): AGENTS.md "Test requirements" counts only live
	// declarations, and `vitest.config.ts` decides which files run at all.
	it.each([
		[
			"a skipped test",
			'it.skip("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"a conditionally skipped test",
			'it.skipIf(true)("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"a test under a skipped describe",
			'describe.skip("suite", () => {\n\tit("reads the phase", () => {\n\t\texpect(row.phase).toBe("fixture_record_emitted");\n\t});\n});\n',
		],
		[
			"a test behind a modifier this rule cannot prove runs",
			'it.customOnce("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
	])("does not count an assertion in %s", (_name, source) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: { [TEST_FILE]: source },
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	// The collected-file answer is read from `vitest.config.ts`, so each row is
	// also checked against the repository's own collector: a change to the
	// config's include/exclude moves both answers together.
	it.each([
		"tests/clients/fixture-collected.test.ts",
		"tests/clients/cascade-turn-merge.test.ts",
		"tests/clients/lsp/integration.test.ts",
		"tests/index-integration.test.ts",
		"tests/fixtures/native-ts7-vitest/planted.test.ts",
		"tests/support/fixture-record-helpers.ts",
		"tests/native-ts7-live-fixed/planted.test.ts",
	])("agrees with vitestCollects about %s", (file) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[file]:
					'it("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(vitestCollects(file) ? 0 : 1);
	});

	// F3 (review round 1): the name is matched whole. `lsp_document_drift` must
	// not be satisfied by a test reading `lsp_document_drift_cap`, the shape the
	// sibling rule's file-name match already fixed (#3905 r2).
	it("does not count a longer record whose name starts with the named one", () => {
		const result = lint({
			observability: "The record is `fixture_record`.",
			records: ["fixture_record", "fixture_record_cap"],
			tests: {
				[TEST_FILE]:
					'it("reads the cap", () => {\n\texpect(row.phase).toBe("fixture_record_cap");\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([
			expect.stringContaining("`fixture_record`"),
		]);
	});

	it("does not count an identifier that contains the literal", () => {
		const result = lint({
			observability: "The record is `fixture_record`.",
			records: ["fixture_record"],
			tests: {
				[TEST_FILE]:
					'const fixture_record_notes = 1;\n\nit("notes", () => {\n\texpect(fixture_record_notes).toBe(1);\n});\n',
			},
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	// F-4597-R2-1 (review round 2): the forms a live test can be written in are
	// an allowlist. A form the reader cannot parse makes its file unprovable, and
	// a form it proves dead contributes nothing; neither may fall back to "this
	// file holds a live test somewhere", which is what admitted both plants.
	it.each([
		[
			"a bracket-spelled skip",
			'it["skip"]("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n\nit("trivial", () => {\n\texpect(1).toBe(1);\n});\n',
		],
		[
			"an alias of `it` that skips",
			'const t = it;\n\nt.skip("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n\nit("trivial", () => {\n\texpect(1).toBe(1);\n});\n',
		],
		[
			"an alias of `it.skipIf`",
			'const d = it.skipIf(process.platform === "win32");\n\nd("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"a computed modifier index",
			'const mod = "skip";\n\nit[mod]("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n\nit("trivial", () => {\n\texpect(1).toBe(1);\n});\n',
		],
		[
			"a module-scope helper only a dead declaration calls",
			'function dropped(phase) {\n\treturn phase === "fixture_record_emitted";\n}\n\nit.skip("trivial", () => {\n\texpect(dropped("x")).toBe(false);\n});\n',
		],
	])("does not count a read-back through %s", (_name, source) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: { [TEST_FILE]: source },
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it.each([
		[
			"a bracket-spelled `only`",
			'it["only"]("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"an alias of `it`",
			'const t = it;\n\nt("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"an imported `it`",
			'import { describe, expect, it } from "vitest";\n\nit("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"a bracket-spelled `each`",
			'it["each"]([{ phase: "other_value" }])("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
		[
			"a module-scope helper a live test calls",
			'function rowsOf(rows) {\n\treturn rows.filter((row) => row.phase === "fixture_record_emitted");\n}\n\nit("reads the phase", () => {\n\texpect(rowsOf(rows)).toHaveLength(1);\n});\n',
		],
		[
			"a generic `each` table",
			'it.each<[string, string]>([[\"other_value\", \"x\"]])("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
		],
	])("counts a read-back through %s", (_name, source) => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: { [TEST_FILE]: source },
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("names the file whose declaration form it cannot prove", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'const mod = "skip";\n\nit[mod]("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([expect.stringContaining(TEST_FILE)]);
	});

	// F-4597-R2-2 (review round 2): the spelling of a mention no longer decides.
	// The body's tokens are judged by the harvest, not by their backticks.
	it("refuses a record named without backticks", () => {
		const result = lint({
			observability:
				"The record is fixture_record_emitted, sent to latency.log.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]: 'it("keeps a note", () => {\n\texpect(1).toBe(1);\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([
			expect.stringContaining(
				"`fixture_record_emitted`, which no test under tests/ reads",
			),
		]);
	});

	it("refuses a record named in a link label", () => {
		const result = lint({
			observability:
				"See [fixture_record_emitted](https://example.test/row) for the row.",
			records: ["fixture_record_emitted"],
		});
		expect(ruleErrors(result)).toHaveLength(1);
	});

	it("counts a bare mention a test reads", () => {
		const result = lint({
			observability: "The record is fixture_record_emitted.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'it("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("leaves a bare token the runtime never emits alone", () => {
		const result = lint({
			observability:
				"The row lands in latency.log, not no_runtime_emits_this_4597.",
			records: ["fixture_record_emitted"],
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("names the file whose declaration binding it cannot follow", () => {
		const result = lint({
			observability: "The record is `fixture_record_emitted`.",
			records: ["fixture_record_emitted"],
			tests: {
				[TEST_FILE]:
					'const { skip } = it;\n\nskip("reads the phase", () => {\n\texpect(row.phase).toBe("fixture_record_emitted");\n});\n',
			},
		});
		expect(ruleErrors(result)).toEqual([expect.stringContaining(TEST_FILE)]);
	});

	// F-4597-R2-2's precision line: a bare mention is read against the fields
	// that identify a record, so prose that reuses a `subsystem` value is not a
	// named record; the backticked spelling still reads the whole harvest.
	const SUBSYSTEM_RUNTIME =
		'export function note() {\n\tlogExtension({ subsystem: "fixture_subsystem_value", message: "note" });\n}\n';

	it("does not require a read-back for a bare subsystem value", () => {
		const result = lint({
			observability: "The fixture_subsystem_value path is unchanged.",
			runtime: SUBSYSTEM_RUNTIME,
		});
		expect(ruleErrors(result)).toEqual([]);
	});

	it("still requires a read-back for a backticked subsystem value", () => {
		const result = lint({
			observability: "The record is `fixture_subsystem_value`.",
			runtime: SUBSYSTEM_RUNTIME,
		});
		expect(ruleErrors(result)).toEqual([
			expect.stringContaining("`fixture_subsystem_value`"),
		]);
	});

	// Shape 10: a probe that cannot run is a skipped check, disclosed once, and
	// never a refusal of a body the author cannot fix (a copied body outside a
	// checkout) and never silence.
	it("discloses a skipped check when the runtime harvest cannot run", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lint({
				observability: "The record is `fixture_record_emitted`.",
				records: ["fixture_record_emitted"],
				git: () => {
					const error = new Error("fatal: not a git repository") as Error & {
						status: number;
					};
					error.status = 128;
					throw error;
				},
			});
			expect(ruleErrors(result)).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					"`fixture_record_emitted`, but the runtime record harvest could not run",
				),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("discloses a skipped check when the tests/ search cannot run", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lint({
				observability: "The record is `fixture_record_emitted`.",
				records: ["fixture_record_emitted"],
				git: (args) => {
					if (args.includes("tests")) {
						const error = new Error("fatal: bad revision") as Error & {
							status: number;
						};
						error.status = 128;
						throw error;
					}
					return RUNTIME_FILE;
				},
			});
			expect(ruleErrors(result)).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					"`fixture_record_emitted`, but the tests/ search could not run",
				),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("reads the two records this repository shipped untested", () => {
		// The real head tree, the real `git grep`, the real blanker. Both
		// literals are read back by the tests this PR adds, so neither is
		// refused now; a rename in either record reds here.
		for (const record of [
			"cascade_pending_rendered",
			"blocker-position-unaligned",
		]) {
			const result = lintPrBody(body(`The record is \`${record}\`.`), {
				diff: DOCS_DIFF,
				cwd: process.cwd(),
			});
			expect(ruleErrors(result)).toEqual([]);
		}
	});

	it("does not treat a fabricated literal as a record", () => {
		// The literal is assembled here, so this file never quotes it: a fixture
		// body must not satisfy its own rule through the corpus it lives in.
		const fabricated = ["no", "such", "record", "4597", "anywhere"].join("_");
		const result = lintPrBody(body(`The record is \`${fabricated}\`.`), {
			diff: DOCS_DIFF,
			cwd: process.cwd(),
		});
		expect(ruleErrors(result)).toEqual([]);
	});
});
