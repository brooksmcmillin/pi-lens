/**
 * Admit-list ratchet on the hand-built pi double `tests/support/pi-mock.ts`
 * (#4632).
 *
 * Recurrence this prevents: #4631. pi rebuilds the system head when a `context`
 * handler returns a changed list; the double kept the list as returned, so every
 * test passed on the double while the cache broke on the real host. Fixers keep
 * reaching for the double because no check named the real tiers. Host semantics
 * (what pi does with a handler's return value, what the model receives, how pi
 * orders a session) belong to tier 1 (`tests/support/pi-runner.ts`, a real
 * `ExtensionRunner`) or tier 2 (`tests/support/pi-session.ts`, a real
 * `AgentSession`), see AGENTS.md "Test requirements".
 *
 * THE GATE IS A LOAD-TIME ADMIT LIST, not a scan. `pi-mock.ts` calls
 * `piMockAdmission` (`tests/support/pi-mock-importers.ts`) when it loads and
 * throws for any test file not on `PI_MOCK_IMPORTERS`, so a new importer fails
 * however its specifier is spelled: escapes, fragments, a re-export through a
 * support file, an alias, a `.tsx` test or a test outside `tests/` all load the
 * same module and meet the same check. The first version of this ratchet scanned
 * source text for the spelling and four plants passed it (review r1, F1).
 *
 * WHAT THIS FILE STILL SCANS: only the other direction. A row for a file that no
 * longer uses the double is stale and must be deleted, so the list only
 * shrinks, and only a scan can see a file that does NOT load a module. The scan
 * reads `tests/` (the registry's keys are `tests/`-relative); files elsewhere
 * are covered by the load check, and `tests/scripts/ci-shuffle-census.test.ts`
 * guards the collected-file population. The scan blanks comments and, for the
 * specifier, reads strings only in a module-specifier position (`from "…"`,
 * `import("…")`, `require("…")`, `vi.mock("…")`), so prose or a string that
 * merely names the module neither keeps a row alive nor counts as a use. Its
 * misses (an assembled specifier with no entry identifier) cost a false stale
 * row, never a missed importer: the load check decides admission.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	PI_MOCK_IMPORTERS,
	piMockAdmission,
} from "../support/pi-mock-importers.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const TESTS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
/** This file names the module in its own plants and messages. */
const SELF = "config/pi-mock-importer-sweep.test.ts";
/**
 * The #4632 acceptance-7 classes, plus `real-ui-harness` (review F4 on #4702:
 * a TUI-observable claim no slice owns and no in-process tier can produce). A
 * row whose class is not on this list reds, so a new class is a deliberate
 * edit here, not a typo.
 *
 * `pending slice N` is NOT a class. Every roadmap slice is closed and no row
 * carries the marker, so the alternative that used to admit it admitted a
 * label naming work no slice owns. Dropping it is what makes the vocabulary
 * closed: a reopened placeholder now reds here instead of passing as a
 * scheduled file.
 */
const CLASS_VOCABULARY =
	/^(process-boundary|internal-seam|unproducible-payload|double-subject|real-ui-harness)$/;

const SPECIFIER_POSITION =
	/\b(?:from|import|require|mock|doMock|unmock|importActual|importMock)\s*\(?\s*(["'`])((?:(?!\1)[^\n\\]|\\.)*)\1/g;
// `makeStaleCtx` and `STALE_CTX_MESSAGE` moved to tests/support/stale-ctx.ts
// (#4913 L1): naming them no longer loads the double, so they are not entries.
const ENTRY_IDENTIFIER = /\b(?:createPiMock|SESSION_START_TEST_BUDGET_MS)\b/;
const ESCAPE = /\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]+)\}/g;

/** Does this source still use the double? For the stale direction only. */
function usesPiMock(source: string): boolean {
	// Raw text carries the specifier; the blanked copy (same layout) says
	// whether the keyword in front of it is code, so a commented-out or quoted
	// import never counts.
	const kept = source;
	const blanked = stripSource(source, { strings: "blank" });
	if (ENTRY_IDENTIFIER.test(blanked)) return true;
	for (const match of kept.matchAll(SPECIFIER_POSITION)) {
		// The keyword must be code: inside a string or regex it is blanked.
		if (blanked[match.index] !== kept[match.index]) continue;
		const decoded = match[2].replace(ESCAPE, (_all, a, b, c) =>
			String.fromCodePoint(Number.parseInt(a ?? b ?? c, 16)),
		);
		if (/pi-mock(?![\w-])/.test(decoded)) return true;
	}
	return false;
}

describe("pi-mock importer ratchet (#4632, recurrence #4631)", () => {
	it(
		"no row is stale and no scanned file uses the double off the list",
		() => {
			const files = listSourceFiles(TESTS_ROOT, {
				extensions: [
					".ts",
					".mts",
					".cts",
					".tsx",
					".js",
					".mjs",
					".cjs",
					".jsx",
				],
			}).filter((file) => relativePosix(TESTS_ROOT, file) !== SELF);
			const flagged: string[] = [];
			for (const { file, source } of readWalkedFiles(files)) {
				const rel = relativePosix(TESTS_ROOT, file);
				// The double itself names its own entry points.
				if (rel === "support/pi-mock.ts") continue;
				if (usesPiMock(source)) flagged.push(rel);
			}
			// Calibration 2026-10-20: ~1,300 files under tests/. Half rounds to 650.
			// A dead walk with a non-empty list already reds as stale rows; this floor
			// is for the day the list is empty and a dead scan would read as clean.
			assertNonEmptyScan("pi-mock sweep: files scanned", files.length, 650);
			const audit = auditRegistry({
				sweepName: "pi-mock importer ratchet",
				flagged,
				registered: [],
				exemptions: { ...PI_MOCK_IMPORTERS },
				minReasonLength: 10,
				remediation:
					"A test file may not load tests/support/pi-mock.ts unless it is on " +
					"PI_MOCK_IMPORTERS (tests/support/pi-mock-importers.ts); the double throws " +
					"at load otherwise. Host-semantics cases go through tier 1 " +
					"(tests/support/pi-runner.ts) or tier 2 (tests/support/pi-session.ts); " +
					"AGENTS.md 'Test requirements' says which. A row for a file that no longer uses " +
					"the double must be deleted.",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every importer row names a class from the #4632 vocabulary", () => {
		const bad = Object.entries(PI_MOCK_IMPORTERS)
			.filter(([, cls]) => !CLASS_VOCABULARY.test(cls))
			.map(([file, cls]) => `${file}: ${cls}`);
		expect(bad).toEqual([]);
		// The ratchet's own file is excluded by path; the exclusion must name a real file.
		expect(fs.existsSync(path.join(TESTS_ROOT, SELF))).toBe(true);
	});

	it("refuses the retired `pending slice` label and any invented class", () => {
		// Recurrence: `pending slice N` outlived the roadmap. Every slice closed
		// and no row carries the marker, so the label names work nothing owns —
		// yet the vocabulary still admitted it, and a row relabelled
		// `pending slice 9` passed the gate on 56fc3d64c (the red quoted in the
		// PR body). A reopened placeholder must red here, not read as scheduled.
		expect(CLASS_VOCABULARY.test("pending slice 9")).toBe(false);
		expect(CLASS_VOCABULARY.test("pending slice 10")).toBe(false);
		// The five live classes still pass, and the match is whole-string: a
		// class with anything appended is a different, unregistered class.
		for (const cls of [
			"process-boundary",
			"internal-seam",
			"unproducible-payload",
			"double-subject",
			"real-ui-harness",
		])
			expect(CLASS_VOCABULARY.test(cls), cls).toBe(true);
		expect(CLASS_VOCABULARY.test("internal-seam ")).toBe(false);
		expect(CLASS_VOCABULARY.test("pending slice")).toBe(false);
	});
});

describe("piMockAdmission fails closed", () => {
	const listed = path.join(TESTS_ROOT, "lens-toggle-command.test.ts");

	it("admits a listed test file", () => {
		expect(piMockAdmission(listed)).toBeUndefined();
	});

	it("refuses an unlisted test file, naming tier 1 and tier 2", () => {
		const refusal = piMockAdmission(path.join(TESTS_ROOT, SELF));
		expect(refusal).toContain("is not on the importer list");
		expect(refusal).toContain("tier 1");
		expect(refusal).toContain("tier 2");
	});

	it.each([
		["no path (vitest reported none)", undefined],
		["an empty path", ""],
		["a non-string path", 42],
		[
			"a path that does not resolve",
			path.join(TESTS_ROOT, "zz-missing.test.ts"),
		],
		["a file outside tests/", path.join(TESTS_ROOT, "..", "package.json")],
	])("refuses %s", (_name, testPath) => {
		expect(piMockAdmission(testPath)).toContain("refuses to load");
	});
});

describe("pi-mock.ts is wired to the admit list", () => {
	// Recurrence: review r1 F1 (#4693). The gate lives in the double's module
	// body; neutering the call there must red something, so this loads the real
	// module with the test path vitest reports swapped for an unlisted one.
	async function loadAs(testPath: unknown): Promise<unknown> {
		const spy = vi
			.spyOn(expect, "getState")
			.mockReturnValue({ testPath } as never);
		try {
			vi.resetModules();
			return await import("../support/pi-mock.js");
		} finally {
			spy.mockRestore();
		}
	}

	it("refuses to load for an unlisted test file", async () => {
		await expect(loadAs(path.join(TESTS_ROOT, SELF))).rejects.toThrow(
			/is not on the importer list/,
		);
	});

	it("refuses to load when vitest reports no test path", async () => {
		await expect(loadAs(undefined)).rejects.toThrow(/no test file path/);
	});
});

describe("usesPiMock (stale direction): spellings and non-uses", () => {
	// Plants are assembled from fragments so no plant string is itself a hit in
	// a scan of this file's neighbours; backslash sequences are built from one.
	const bs = String.fromCharCode(92);
	const usedPlants: Record<string, string> = {
		"static import": `import { createPiMock } from "../support/pi-mock.js";`,
		"side-effect import": `import "./support/pi-mock.js";`,
		"multi-line import": `import {\n\tmakeCtx,\n} from\n\t"../support/pi-mock.ts";`,
		"dynamic import": `const m = await import("../support/pi-mock.js");`,
		require: `const m = require("../support/pi-mock.js");`,
		"vi.mock": `vi.mock("../support/pi-mock.js", () => ({}));`,
		importActual: `await vi.importActual("../support/pi-mock.js");`,
		"re-export": `export * from "../support/pi-mock.js";`,
		"template literal": "await import(`../support/pi-mock.js`);",
		"directory-style specifier": `await import("../support/pi-mock/index.js");`,
		"escaped specifier": `import { makeCtx } from "./support/pi${bs}x2Dmock.js";`,
		"unicode-escaped specifier": `import { makeCtx } from "./support/pi${bs}u002Dmock.js";`,
		"entry identifier": `const pi = createPiMock();`,
		"after a comment": `/* tier 2 */ import { makeCtx } from "./pi-mock.js";`,
		"after a url string": `const url = "http://x"; import "../support/pi-mock.js";`,
	};
	for (const [name, source] of Object.entries(usedPlants)) {
		it(`uses: ${name}`, () => {
			expect(usesPiMock(source)).toBe(true);
		});
	}

	const unusedPlants: Record<string, string> = {
		"line comment": `// moved off tests/support/pi-mock.ts onto tier 2\nconst x = 1;`,
		"block comment": `/* createPiMock was here, see pi-mock.ts */\nconst x = 1;`,
		// Review r1 F5: a migrated file that keeps a note must not keep its row.
		"string-only mention": `const MIGRATED = "moved off pi-mock onto tier 2";`,
		"unrelated mock": `import { makeCtx } from "./runner-ctx.js";`,
		"commented-out import": `// import { makeCtx } from "./support/pi-mock.js";\nconst x = 1;`,
		// A specifier-position keyword inside a string is not an import.
		"import statement quoted inside a string": `const sample = "import x from './support/pi-mock.js'";`,
		// Recurrence: the first run of the first version flagged
		// tests/scripts/pre-push-targeted-tests.test.ts for naming a sibling path.
		"sibling module whose name starts with the token": `"tests/support/pi-mock-importers.ts",`,
		"import of the admit-list module": `import { PI_MOCK_IMPORTERS } from "../support/pi-mock-importers.js";`,
		// #4913 L1: the stub moved to tests/support/stale-ctx.ts, so naming it is
		// not a use of the double.
		"stale-ctx stub name only": `expect(msg).toBe(STALE_CTX_MESSAGE);`,
	};
	for (const [name, source] of Object.entries(unusedPlants)) {
		it(`does not use: ${name}`, () => {
			expect(usesPiMock(source)).toBe(false);
		});
	}
});
