/**
 * #4617 — every turn-end part producer declares what its part's provenance
 * stamp speaks for.
 *
 * Recurrence prevented (the #4954 F2 remainder, 2026-10-29): the citation
 * registry (`provenanceCitations` in `clients/runtime-turn.ts`) covered 5 of
 * the 25 turn-end tier pushes at #4954 and 10 after #4962. The other fifteen —
 * the 🔑 stale-secrets tier, knip, dead-code, trivy, call-graph impact, the
 * actionable/code-quality warning advisories, the demoted inline blocker —
 * pushed a section the composer never registered, so on a no-write turn
 * (about 85% of a live session) the stamp had no subject, `isWellFormed`
 * rejected the record, and live findings reached the agent labelled
 * "Historical finding; workspace changed since capture". Nothing failed: each
 * producer looked correct on its own, and only a hand count found the gap.
 *
 * This census derives the population from the source instead of listing it. It
 * reads every `blockerParts`/`advisoryParts`/`staleSecretParts` push in
 * `clients/runtime-turn.ts` (the composer is the only file that owns those
 * arrays — `tests/config/turn-end-lane-boundaries.test.ts` keeps it that way)
 * and requires the part it pushes to be declared in the block that contains
 * the push:
 *
 *   - `citePart(<part>, files)` — the files the text reports;
 *   - `markFilelessPart(<part>)` — no file subject, evidence captured this
 *     turn;
 *   - `markCarriedPart(<part>)` — no file subject, evidence captured earlier;
 *   - `registerLanePart(<entry>)` for an `<entry>.part` push, the transport a
 *     lane's own `TurnEndLanePart` takes.
 *
 * A sub-part folded into a parent section (`parts.push(...)` joined into one
 * tier push, the cascade test-suggestion block) is covered by its parent's
 * declaration, so it is not a seam here. Any OTHER spelling — an alias, an
 * indirect helper, a spread of a hand-built array — refuses with its file and
 * line, because the scanner cannot read it: fail closed, as the
 * `@delivery-surface:` seam scan beside it does (#4429).
 *
 * Scope (review F5): the population is the THREE TIER ARRAYS' pushes, not every
 * composed part. One composed part is deliberately outside it — `resolvedParts`
 * (`clients/runtime-turn.ts`, cited where the resolution lines are built, then
 * spread into the message's parts). It is a literal array, never a `.push(` into
 * a tier, so this scan cannot see it, and a change that stopped citing it would
 * not red here. It is cited today, and the body states the narrower population
 * rather than claiming "every producer".
 *
 * Known limit (named, not papered over): the pairing is by identifier inside
 * one block. Two producers in the SAME block that reuse one identifier would
 * share a declaration. Every block today builds one part per identifier, and a
 * producer that reuses a name for a second part is the case a reviewer reads in
 * the diff; the plants below pin the spellings a fresh producer reaches for.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const COMPOSER = "clients/runtime-turn.ts";

/** The tier arrays the composer owns, and the seam that pushes into them. */
const TIER_PUSH = /\b(?:blockerParts|advisoryParts|staleSecretParts)\.push\(/g;

/** A fileless/cited declaration, by the identifier it names. */
const DECLARATIONS = [
	/\bcitePart\(\s*([A-Za-z_$][\w$]*)\b/g,
	/\bmarkFilelessPart\(\s*([A-Za-z_$][\w$]*)\b/g,
	/\bmarkCarriedPart\(\s*([A-Za-z_$][\w$]*)\b/g,
];

/** The lane transport: `registerLanePart(lanePart)` declares `lanePart.part`. */
const LANE_DECLARATION = /\bregisterLanePart\(\s*([A-Za-z_$][\w$]*)\b/g;

interface PushSeam {
	/** 1-based line of the push, in the read source. */
	line: number;
	/** The pushed expression, as written (comments and strings blanked). */
	text: string;
	/** The identifier a declaration must name, or undefined when unreadable. */
	subject: string | undefined;
	/** True when the push transports a lane's own `TurnEndLanePart`. */
	lane: boolean;
	/** The innermost enclosing block of the push, blanked. */
	block: string;
}

/** The innermost enclosing `{` of `index` in comment/string-blanked source. */
function enclosingBlock(stripped: string, index: number): string {
	let depth = 0;
	for (let at = index - 1; at >= 0; at -= 1) {
		const char = stripped[at];
		if (char === "}") depth += 1;
		else if (char === "{") {
			if (depth === 0) {
				const close = stripped.indexOf("}", index);
				return stripped.slice(at, close === -1 ? undefined : close);
			}
			depth -= 1;
		}
	}
	return stripped;
}

/** Every tier push in `rawSource`, with the block its declaration must sit in. */
export function scanTierPushes(rawSource: string): PushSeam[] {
	const stripped = stripSource(rawSource);
	const seams: PushSeam[] = [];
	for (const match of stripped.matchAll(TIER_PUSH)) {
		const at = match.index ?? 0;
		// The pushed expression ends at the matching `)`.
		let depth = 1;
		let end = at + match[0].length;
		while (end < stripped.length && depth > 0) {
			const char = stripped[end];
			if (char === "(") depth += 1;
			else if (char === ")") depth -= 1;
			end += 1;
		}
		const text = stripped.slice(at + match[0].length, end - 1).trim();
		const member = /^([A-Za-z_$][\w$]*)\.part$/.exec(text);
		seams.push({
			line: stripped.slice(0, at).split("\n").length,
			text,
			subject:
				member?.[1] ?? /^([A-Za-z_$][\w$]*)$/.exec(text)?.[1] ?? undefined,
			lane: member !== null,
			block: enclosingBlock(stripped, at),
		});
	}
	return seams;
}

/** Every name one block declares, over both declaration spellings. */
function declaredNames(block: string): {
	cited: Set<string>;
	lane: Set<string>;
} {
	const cited = new Set<string>();
	for (const pattern of DECLARATIONS) {
		for (const hit of block.matchAll(pattern)) cited.add(hit[1] ?? "");
	}
	const lane = new Set<string>();
	for (const hit of block.matchAll(LANE_DECLARATION)) lane.add(hit[1] ?? "");
	return { cited, lane };
}

/** Problems for one source: a tier push whose part nothing declares. */
export function pushProblems(rawSource: string, file = COMPOSER): string[] {
	const problems: string[] = [];
	for (const seam of scanTierPushes(rawSource)) {
		if (seam.text.startsWith("...")) {
			problems.push(
				`${file}:${seam.line}: tier push spreads a hand-built value (\`...${seam.text.slice(3)}\`) — a lane's parts travel through registerLanePart, never a spread`,
			);
			continue;
		}
		if (seam.subject === undefined) {
			problems.push(
				`${file}:${seam.line}: tier push \`${seam.text}\` names no identifier the census can read — build the part into a const and declare it through citePart/markFilelessPart/markCarriedPart`,
			);
			continue;
		}
		const { cited, lane } = declaredNames(seam.block);
		if (seam.lane ? lane.has(seam.subject) : cited.has(seam.subject)) continue;
		// Name what the block declares instead, so a declaration of the WRONG
		// part reads as the swap it is rather than as a missing declaration.
		const other = [...cited, ...lane].filter((name) => name !== "");
		problems.push(
			`${file}:${seam.line}: tier push \`${seam.text}\` is declared by nothing in its block${
				other.length > 0
					? ` (it declares ${[...new Set(other)].join(", ")})`
					: " (no citePart/markFilelessPart/markCarriedPart/registerLanePart call)"
			}`,
		);
	}
	return problems;
}

describe("turn-end part provenance census (#4617)", () => {
	const source = fs.readFileSync(path.join(REPO_ROOT, COMPOSER), "utf8");
	const seams = scanTierPushes(source);

	// The floor is the count the #4954 F2 remainder found by hand (25). A
	// pattern that stopped matching would otherwise read as a clean tree.
	it("derives the whole tier-push population from the composer", () => {
		expect(seams.length).toBeGreaterThanOrEqual(25);
	});

	it("every tier push is declared by its own block", () => {
		const problems = pushProblems(source);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	// The census exists because a producer that declared nothing used to ship
	// green (nineteen of twenty-five did, #4954 F2). These are the spellings a
	// future producer might reach for instead of the seam; each must red.
	it("RED PROOF: a push whose part nothing declares is flagged", () => {
		const problems = pushProblems(`
function handleTurnEnd() {
	advisoryParts.push(report);
}
`);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("tier push `report` is declared by nothing");
	});

	it("RED PROOF: an alias does not inherit the declaration of what it aliases", () => {
		const problems = pushProblems(`
function handleTurnEnd() {
	const alias = report;
	advisoryParts.push(alias);
	citePart(report, ["src/a.ts"]);
}
`);
		expect(problems).toEqual([
			expect.stringContaining("tier push `alias` is declared by nothing"),
		]);
		expect(problems[0]).toContain("it declares report");
	});

	it("RED PROOF: an indirect declaration helper is not an admitted spelling", () => {
		const problems = pushProblems(`
function handleTurnEnd() {
	citeIt(report);
	advisoryParts.push(report);
}
`);
		expect(problems).toEqual([
			expect.stringContaining(
				"tier push `report` is declared by nothing in its block",
			),
		]);
	});

	it("RED PROOF: a value reached through another binding is refused, not skipped", () => {
		const problems = pushProblems(`
function handleTurnEnd() {
	const built = [report];
	advisoryParts.push(...built);
}
`);
		expect(problems).toEqual([
			expect.stringContaining("tier push spreads a hand-built value"),
		]);
	});

	it("reads each declaration in the push's own block as a pass", () => {
		expect(
			pushProblems(`
function handleTurnEnd() {
	advisoryParts.push(report);
	citePart(report, ["src/a.ts"]);
	markFilelessPart(note);
	advisoryParts.push(note);
	for (const lanePart of parts) {
		registerLanePart(lanePart);
		advisoryParts.push(lanePart.part);
	}
}
`),
		).toEqual([]);
	});
});
