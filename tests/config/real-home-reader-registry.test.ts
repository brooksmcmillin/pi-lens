/**
 * #4789: a test that reads the maintainer's REAL home is a named opt-out.
 *
 * Recurrence this guards: a test that reads the real home on purpose (the
 * managed-prettier probe in `formatter-template-preserve.test.ts`) silently
 * degrades once HOME is pinned, and a NEW test that reaches for the passwd home
 * (`os.userInfo()`) or the setup's `REAL_HOME` re-opens the real home to writes
 * with nothing naming it. The scan is fail-closed on the two spellings the
 * harness offers: a file spelling either is refused unless it has a row in
 * `tests/support/real-home-readers.ts`, and a row whose file stopped spelling
 * either is stale.
 *
 * Forms admitted (STATE TABLE): a file whose comment- and string-blanked source
 * holds neither the identifier `REAL_HOME` nor the identifier `userInfo`, and
 * no bracket-literal `["userInfo"]`. Every other file is a reader and needs a
 * row plus a `// real-home: <reason>` header in its first lines. Not read: a
 * passwd read that spells neither identifier (a computed key on an alias of
 * `os`, `/etc/passwd`, `getent`). The pin itself, asserted through a real child
 * in `tests/clients/worker-home-pin-hermeticity.test.ts`, is the guard for those.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REAL_HOME_READERS } from "../support/real-home-readers.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const TESTS_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
/** The owners: the setup defines `REAL_HOME`, the registry names its readers,
 *  and this file's own detector spells both needles. */
const SCAN_OWNERS = new Set([
	"tests/support/vitest-setup.ts",
	"tests/support/real-home-readers.ts",
	"tests/config/real-home-reader-registry.test.ts",
]);

/** True when `source` spells a way to the real home that the harness offers. */
function spellsRealHome(source: string): boolean {
	const code = stripSource(source);
	if (/\bREAL_HOME\b|\buserInfo\b/.test(code)) return true;
	// A bracket-literal key is a string: blanked above, so read it with the
	// strings kept (comments still blanked).
	return /\[\s*["'`]userInfo["'`]\s*\]/.test(
		stripSource(source, { strings: "keep" }),
	);
}

function realHomeHeader(source: string): string | undefined {
	return source
		.split("\n", 4)
		.map((line) => /^\/\/ real-home: (.{15,})$/.exec(line)?.[1])
		.find((reason) => reason !== undefined);
}

describe("a test that reads the real home is a named opt-out (#4789)", () => {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#4789 real-home reader scan", files.length, 1400);
	const walked = readWalkedFiles(files).map(({ file, source }) => ({
		rel: relativePosix(REPO_ROOT, file),
		source,
	}));

	it(
		"every file that spells the real home has a registry row, and every row still spells it",
		() => {
			const flagged = walked
				.filter(
					({ rel, source }) => !SCAN_OWNERS.has(rel) && spellsRealHome(source),
				)
				.map(({ rel }) => rel);
			const audit = auditRegistry({
				sweepName: "#4789 real-home readers",
				flagged,
				registered: [],
				exemptions: REAL_HOME_READERS,
				minFlagged: 1,
				scannedCount: walked.length,
				minScanned: 1400,
				remediation:
					"Use the pinned home (`pinFixtureHome` for a project under HOME). A read of the real home is an opt-out: add a row to tests/support/real-home-readers.ts and a `// real-home: <reason>` header.",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every registered reader carries the same reason as a header in its first lines",
		() => {
			const bySource = new Map(walked.map(({ rel, source }) => [rel, source]));
			// Compared as text, not just present: a header rewritten to a different
			// reason must red (#4789 review F2). A trailing period is the header's
			// sentence end, not part of the reason.
			const trim = (reason: string | undefined) => reason?.replace(/\.$/, "");
			const disagree = Object.entries(REAL_HOME_READERS)
				.filter(([rel, reason]) => {
					const source = bySource.get(rel);
					const header =
						source === undefined ? undefined : realHomeHeader(source);
					return trim(header) !== trim(reason);
				})
				.map(([rel]) => rel);
			expect(disagree).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("plants: the detector refuses an alias, a renamed destructure and a bracket literal, and admits clean code and prose", () => {
		// Spellings the author did not design the detector around.
		expect(
			spellsRealHome(
				'import { REAL_HOME as H } from "../support/vitest-setup.js";\nconst x = H;',
			),
		).toBe(true);
		expect(
			spellsRealHome('import os from "node:os";\nconst { userInfo: u } = os;'),
		).toBe(true);
		expect(spellsRealHome('const o = os;\no["userInfo"]();')).toBe(true);
		// Prose is not a read (principles section 2, "Detectors match code").
		expect(
			spellsRealHome("// REAL_HOME is the opt-out\nconst a = `userInfo`;"),
		).toBe(false);
		expect(spellsRealHome("const home = os.homedir();")).toBe(false);
	});
});
