// flake-shape: real-process-spawn — the oracle is real `bash -c`: which directory bash enters and where its redirect lands for each generated spelling. A stubbed shell answers neither, and the rows exist because hand-written expectations kept missing spellings (#4713 rounds 8-11).
/**
 * #4713 round 11: a composition generator, run against real bash.
 *
 * Recurrence: three consecutive review rounds on one seam each found a
 * spelling the hand-written rows missed. Round 9 missed `FOO""=bar` (an empty
 * quote inside an assignment name), and round 10's fix then broke `\c""d` (an
 * escape and an empty quote inside one verb), because each round's rows gave a
 * token ONE quoting form as a whole. This file builds the spellings from the
 * product instead: for each token of a `cd` command (a prefix, the verb, the
 * operand), every internal position (start, between letters, end) crossed
 * with every quoting form that emits nothing (`''`, `""`, `$''`, `$""`,
 * backslash-newline), crossed with an escape before any letter or of the
 * separator after the token; plus one quoting form wrapped around the whole
 * token or one letter, with nothing, an escape or a backslash-newline inside
 * (bash removes `\⏎` inside double quotes, and keeps it inside single ones).
 *
 * Each row runs `<spelling> ; printf x > f.ts` through real `bash -c` in a
 * fixture holding `sub/` and `sub /`, then through `scanShellWriteScopes`.
 * A row passes when the scan names the file bash wrote, or the base's answer
 * (`f.ts`, the documented fallback), AND names as a `cd` target exactly the
 * directory bash entered, or nothing when bash entered none. A row outside
 * that rule must sit in `ACCEPTED`, whose entries each carry a reason and the
 * exact number of rows they cover, so an entry that stops matching, or starts
 * matching more, reds here.
 *
 * #4713 round 12 adds two slots. Recurrence: verify r12 F1, where a redirect
 * target read from the legacy token text dropped the backslash bash keeps in
 * `> "C:\x\f.ts"` (two reds on the Windows lane), and greptile's P1 on
 * `c87aaa614` (F2), where a separate empty word was dropped, so `'' \c""d sub`
 * read as `cd sub`. The `target` slot spells the redirect target `f.ts` every
 * way above and runs `printf x > <spelling>`; it has no fallback, so the scan
 * must name exactly the `.ts` files bash wrote. The `empty word` slot puts a
 * separate empty quoted word before or after each spelling of `cd`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanShellWriteScopes } from "../../clients/bash-file-access.js";
import { spellings } from "../support/shell-spellings.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

interface Row {
	slot: "prefix" | "verb" | "operand" | "empty word" | "target";
	token: string;
	command: string;
}

/** A separate word that emits nothing; `\⏎` is a line continuation, no word. */
const EMPTY_WORDS = ["''", '""', "$''", '$""'] as const;

const CD_SUFFIX = " ; printf x > f.ts";

const ROWS: readonly Row[] = [
	...["FOO=1", "builtin", "command"].flatMap((token) =>
		spellings(token).map((spelled): Row => ({
			slot: "prefix",
			token,
			command: `${spelled} cd sub${CD_SUFFIX}`,
		})),
	),
	...["cd", "pushd"].flatMap((token) =>
		spellings(token).map((spelled): Row => ({
			slot: "verb",
			token,
			command: `${spelled} sub${CD_SUFFIX}`,
		})),
	),
	...spellings("sub").map((spelled): Row => ({
		slot: "operand",
		token: "sub",
		command: `cd ${spelled}${CD_SUFFIX}`,
	})),
	...EMPTY_WORDS.flatMap((empty): Row[] => [
		...spellings("cd").flatMap((spelled): Row[] => [
			{
				slot: "empty word",
				token: "cd",
				command: `${empty} ${spelled} sub${CD_SUFFIX}`,
			},
			{
				slot: "empty word",
				token: "cd",
				command: `${spelled} ${empty} sub${CD_SUFFIX}`,
			},
		]),
		{
			slot: "empty word",
			token: "FOO=1",
			command: `FOO=1 ${empty} cd sub${CD_SUFFIX}`,
		},
	]),
	...spellings("f.ts").map((spelled): Row => ({
		slot: "target",
		token: "f.ts",
		command: `printf x > ${spelled}`,
	})),
];

/**
 * Accepted residuals: each names the rows it covers by predicate, why the
 * scan may differ from bash there, and how many generated rows it covers.
 */
const ACCEPTED: ReadonlyArray<{
	reason: string;
	rows: number;
	covers: (row: Row, outcome: Outcome) => boolean;
}> = [
	{
		reason:
			"R7-4, the PR's declared p3 residual: a cd whose one operand is a static path moves the scan without a stat, so a directory that does not exist (here a single-quoted or ANSI-C backslash or backslash-newline, `cd s'\\u'b`, `cd su$'\\b'`, bash's own word) is entered where bash stays",
		rows: 8,
		covers: (_row, outcome) =>
			outcome.bashEntered === undefined &&
			outcome.named.length === 1 &&
			!fs.existsSync(path.join(cwd, outcome.named[0] ?? "")),
	},
	{
		reason:
			"the raw span finder (`extractRedirectTargets`) ends a redirect target at whitespace even inside quotes or after a backslash, so a target holding `\\⏎` reaches the model as an open quote or a bare backslash and names nothing: an under-claim, base-equal, the PR's declared redirect-split residual",
		rows: 37,
		covers: (row, outcome) =>
			row.slot === "target" &&
			row.command.includes("\n") &&
			outcome.scanWrote.length === 0,
	},
	{
		reason:
			"the native-Windows-path tradeoff: an unquoted backslash before an ordinary character (`f\\.ts`, `\\f.ts`) stays in the path reading, as `C:\\src\\f.ts` needs, so the scan names bash's file with that backslash kept (base-equal)",
		rows: 42,
		covers: (row, outcome) =>
			row.slot === "target" &&
			outcome.bashWrote.length === 1 &&
			outcome.scanWrote.length === 1 &&
			outcome.scanWrote[0] !== outcome.bashWrote[0] &&
			outcome.scanWrote[0]?.replaceAll("\\", "") === outcome.bashWrote[0],
	},
	{
		reason:
			"the same tradeoff inside the extension (`f.\\ts`, `f.t\\s`): the kept backslash makes the extension unreadable, so the scan names nothing (base-equal)",
		rows: 42,
		covers: (row, outcome) =>
			row.slot === "target" &&
			outcome.bashWrote.join(",") === "f.ts" &&
			outcome.scanWrote.length === 0 &&
			/\\[ts]/.test(row.command),
	},
];

interface Outcome {
	bashWrote: string[];
	scanWrote: string[];
	bashEntered: string | undefined;
	named: string[];
}

let root: string;
let cwd: string;
let home: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bwc-"));
	cwd = path.join(root, "cwd");
	home = path.join(root, "home");
	fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "sub "), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
	removeTempDirSync(root);
});

/**
 * Every file bash wrote under the fixture, removed once read, and the subset
 * named `*.ts` (relative to `cwd`): the only names the scan reports.
 */
function takeWrites(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				if (entry.name.endsWith(".ts")) found.push(path.relative(cwd, full));
				fs.rmSync(full);
			}
		}
	};
	walk(root);
	return found.sort();
}

function run(row: Row): Outcome {
	const { command } = row;
	try {
		execFileSync("bash", ["-c", command], {
			cwd,
			// A minimal environment: no CDPATH, OLDPWD or BASH_ENV, and HOME
			// inside the fixture.
			env: { PATH: process.env.PATH ?? "", HOME: home, LC_ALL: "C" },
			stdio: "ignore",
			timeout: 10_000,
		});
	} catch {
		// A row whose command bash cannot run still writes f.ts where it stood.
	}
	const bashWrote = takeWrites();
	const scan = scanShellWriteScopes(command, cwd);
	const entered =
		bashWrote.length === 1 ? path.dirname(bashWrote[0] ?? "") : undefined;
	return {
		bashWrote,
		scanWrote: scan.written.map((file) => path.relative(cwd, file)).sort(),
		bashEntered: entered === "." ? undefined : entered,
		named: scan.cdTargets.map((dir) => path.relative(cwd, dir)),
	};
}

describe.skipIf(process.platform === "win32")(
	"bash word composition against real bash (#4713 R11)",
	() => {
		it("names the file and the cd target bash does, for every composed spelling", () => {
			const failures: string[] = [];
			const covered = ACCEPTED.map(() => 0);
			let entered = 0;
			for (const row of ROWS) {
				const outcome = run(row);
				if (outcome.bashEntered !== undefined) entered++;
				// A target row has no fallback: `f.ts` is the answer F1 gave for
				// `"f\.ts"`, where bash writes `f\.ts`.
				const writeOk =
					outcome.scanWrote.join(",") === outcome.bashWrote.join(",") ||
					(row.slot !== "target" && outcome.scanWrote.join(",") === "f.ts");
				const namedOk = outcome.named.join(",") === (outcome.bashEntered ?? "");
				if (writeOk && namedOk) continue;
				const accepted = ACCEPTED.findIndex((entry) =>
					entry.covers(row, outcome),
				);
				if (accepted >= 0) {
					covered[accepted] = (covered[accepted] ?? 0) + 1;
					continue;
				}
				failures.push(
					`${row.slot} ${JSON.stringify(row.command)}: bash wrote ${JSON.stringify(outcome.bashWrote)}, scan ${JSON.stringify(outcome.scanWrote)}; bash entered ${JSON.stringify(outcome.bashEntered ?? null)}, named ${JSON.stringify(outcome.named)}`,
				);
			}
			// Floors: the generator still composes, and bash still ran (a
			// missing bash would enter nothing and fail every row anyway).
			assertNonEmptyScan("composed cd spellings", ROWS.length, 1000);
			assertNonEmptyScan("spellings bash ran as a cd", entered, 100);
			expect(failures).toEqual([]);
			expect(covered).toEqual(ACCEPTED.map((entry) => entry.rows));
			// The cost bound (verify r12 N1): each row is one `bash` spawn, so the
			// exact row count bounds the run, about 5 s here. A generator change
			// that grows it reds here and is re-pinned on purpose, where a clock
			// budget under a loaded host would only flake.
			expect(ROWS.length).toBe(2625);
		}, 180_000);
	},
);
