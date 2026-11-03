// flake-shape: real-process-spawn — the git-ignored census needs git's own
// tracked-versus-ignored decision through collectUntrackedIgnoredIds; no stub
// reproduces the index state that decides whether a fixture survives checkout.
/**
 * Smoke-fixture coverage drift guard (#209 requirement 4, #1937).
 *
 * `dispatch-coverage` proves every runner is wired into a PLAN. This proves
 * every runner's PARSER has met real bytes, or says why it cannot:
 *
 *   1. a captured real-bytes fixture (`tests/fixtures/runner-output/`) — the
 *      binary's actual stdout/stderr/exit code, replayed through the parser by
 *      `runners/captured-real-output.test.ts`; or
 *   2. an explicit exemption below, which must name a CATEGORY explaining why
 *      real output is unreachable.
 *
 * A live tool-smoke fixture (`scripts/smoke-tools.mjs`) is NOT coverage here.
 * The nightly lane spawns the real binary, but Step 1 asserts only that it ran
 * and exited cleanly, so a parser that reads the wrong shape passes it. Fourteen
 * runners stood on a live fixture alone until the #1937 census counted captured
 * bytes only, and the first two recaptures found `go vet` reporting a type
 * error as clean (#4451) and `dart analyze` errors dropped as a rejected run.
 *
 * Out of scope: the project-scan clients (madge, knip, jscpd, gitleaks,
 * govulncheck, trivy, vulture) are not dispatch runners; #3438 owns their
 * captured replay.
 *
 * #1937 rewrote the exemption rules. The map used to accept free text, and
 * "no fixture yet" sat in it for nine runners. A standing exemption turns
 * "forces a decision" into "permanently undecided", and that is how the vale
 * parser (#1933) shipped reading `Data.Files` — a shape vale has never emitted.
 * Every exemption now carries one of a closed set of categories, each of which
 * says something true about the world rather than about the backlog, and the
 * deferral phrasing itself is rejected. Only `pending` defers, and it must name
 * the issue that closes it. Every other category states a time-invariant fact
 * about the tool, so it may not speak of evidence, the host or time, and the
 * ids allowed under `toolchain` and `platform` are a pinned table.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
// The production "untracked AND ignored" seam (#679), not a private git call:
// one rule for what git hides, and no second child-process path in a census.
import {
	_resetUntrackedIgnoredCacheForTests,
	collectUntrackedIgnoredIds,
} from "../../../clients/git-tracked-ignore.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import {
	FIXTURES,
	passFloorBreach,
	tier1Fixtures,
} from "../../../scripts/smoke-tools.mjs";
// Typed via scripts/capture-runner-output.d.mts: the capture gate and this
// census share one rule for what makes a record evidence.
import { recordProblems } from "../../../scripts/capture-runner-output.mjs";
import {
	availabilityProblems,
	CAPTURED_OUTPUT_DIR,
	cleanProblems,
	CapturedOutput,
	listCapturedOutputs,
	provenanceProblems,
} from "../../helpers/captured-runner-output.js";
// This file is sweep-shaped by construction (a walk plus an emptiness
// assertion), so its population carries a floor: 112 fixture files today, and a
// sweep over nothing must fail rather than read as clean.
import { assertNonEmptyScan } from "../../support/sweep-kit.js";

const repoRoot = path.resolve(CAPTURED_OUTPUT_DIR, "../../..");

/**
 * Why a runner has no real tool output on file. The category is the load-bearing
 * part: it states a fact about the tool, not a position in a queue.
 */
const EXEMPTION_CATEGORIES = {
	/** In-process analysis. There is no external binary to capture. */
	structural: "structural",
	/**
	 * A per-language alternate whose primary is covered. The detail must START
	 * with the covering runner's id, and that runner must itself be covered —
	 * otherwise the two exempt each other.
	 */
	alternate: "alternate",
	/** Exercised through the LSP lane rather than the dispatch CLI path. */
	lsp: "lsp",
	/**
	 * A tool the CI image cannot provide: name the tool and why. Every id here
	 * is pinned in `PINNED_FACT_EXEMPTIONS`, so a new one is a visible diff.
	 */
	toolchain: "toolchain",
	/** No binary exists for any platform pi-lens develops or tests on. Pinned. */
	platform: "platform",
	/** Flag-gated off by default; running it has side effects. */
	"opt-in": "opt-in",
	/**
	 * The only category that may describe the state of the repo, the host or
	 * time, and the only one that expires. The detail must reference the issue
	 * or PR that removes it, so the deferral has an owner and an end.
	 */
	pending: "pending",
} as const;

/**
 * Every category but `pending` states a time-invariant fact about the TOOL. A
 * fact about the capture host, the fixture backlog or the calendar is a
 * deferral however it is worded, and no phrase list closes that (#1937 review:
 * "awaiting capture on a CI image, fixture to follow" passed a lexical list, and
 * "absent from this host" was filed as `toolchain` while ubuntu-latest ships
 * Ruby and PowerShell). So the derived rule bans the vocabulary of evidence,
 * host and time in those categories, instead of listing deferral phrases.
 */
const FACT_CATEGORIES: ReadonlySet<string> = new Set([
	"structural",
	"alternate",
	"lsp",
	"toolchain",
	"platform",
	"opt-in",
]);
const EVIDENCE_HOST_OR_TIME =
	/\b(?:fixtures?|captur\w*|bytes|replay\w*|this host|the host|here|yet|later|will|soon|todo|tbd|to follow|awaiting|pending|missing|absent|currently|for now|right now)\b/i;

/**
 * Exemption ids allowed in the categories a reviewer must approve one by one.
 * `toolchain` and `platform` are where "the tool is absent on my machine" gets
 * laundered, so adding to either is a diff to this table, not a quiet map entry.
 */
const PINNED_FACT_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
	toolchain: [],
	platform: [],
};

/**
 * Runners with neither a live tool-smoke fixture nor captured real bytes.
 * Format: `"<category>: <detail>"`.
 */
const EXEMPT = new Map<string, string>([
	[
		"tree-sitter",
		"structural: in-process grammar queries on every dispatch; no external process emits output to parse",
	],
	[
		"fact-rules",
		"structural: in-process fact evaluation on every dispatch; no external process emits output to parse",
	],
	[
		"ast-grep-napi",
		"structural: in-process napi engine; real-engine coverage via ast-grep-rule-tests plus the sonar and utils-block suites",
	],
	[
		"credo",
		"alternate: elixir-check is the Elixir primary; credo is the config-gated alternate",
	],
	[
		"prisma-validate",
		"lsp: exercised through the --lsp prisma smoke lane; the runner shells out to the same @prisma/language-server package",
	],
	[
		"spotbugs",
		"pending: #1937 analyses a compiled .class tree and is flag-gated behind withSpotbugsGroup; ubuntu-latest ships a JDK, so a CI job that builds the smoke java project can capture it",
	],
	[
		"lsp",
		"lsp: the dispatch lsp runner relays language-server diagnostics rather than parsing a CLI; its evidence is the --lsp tool-smoke lane and the clients/lsp suites",
	],
	[
		"psscriptanalyzer",
		"pending: #1937 ubuntu-latest ships PowerShell 7 and the module installs from the PowerShell Gallery; the runner writes a per-pid temp script into its argv, which the replay argv tie does not model",
	],
	[
		"helm-render",
		"opt-in: helm.renderValidation.enabled is off by default because rendering executes chart templates",
	],
]);

function liveFixtureRunnerIds(): Set<string> {
	const ids = new Set<string>();
	for (const fx of FIXTURES) {
		for (const target of fx.targets ?? []) ids.add(target);
	}
	return ids;
}

function capturedFixtureRunnerIds(): Set<string> {
	return new Set(listCapturedOutputs().map((f) => f.provenance?.runner));
}

function registeredRunnerIds(): string[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list().map((r) => r.id);
}

/**
 * The census: registered runner ids that neither have a captured fixture nor an
 * exemption. A pure function so a synthetic runner can prove it fires.
 */
function uncapturedRunners(
	registered: readonly string[],
	captured: ReadonlySet<string>,
	exempt: ReadonlyMap<string, string>,
): string[] {
	return registered.filter((id) => !captured.has(id) && !exempt.has(id));
}

/**
 * Exemptions for a runner that already has captured bytes. A pure function so
 * a synthetic map can prove it fires; on the real map it is an empty loop.
 */
function redundantExemptions(
	exempt: ReadonlyMap<string, string>,
	captured: ReadonlySet<string>,
): string[] {
	return [...exempt.keys()].filter((id) => captured.has(id));
}

/** `toolchain`/`platform` exemptions that are not in the pinned table, or pinned ids that are gone. */
function unpinnedFactExemptions(
	exempt: ReadonlyMap<string, string>,
	pinned: Readonly<Record<string, readonly string[]>>,
): string[] {
	const problems: string[] = [];
	for (const category of Object.keys(pinned)) {
		const actual = [...exempt]
			.filter(
				([, reason]) => parseExemptionReason(reason)?.category === category,
			)
			.map(([id]) => id)
			.sort();
		const expected = [...(pinned[category] ?? [])].sort();
		for (const id of actual)
			if (!expected.includes(id))
				problems.push(`${category}: ${id} is not pinned`);
		for (const id of expected)
			if (!actual.includes(id))
				problems.push(`${category}: ${id} is pinned but gone`);
	}
	return problems;
}

/**
 * The exemption rules over the real fixture directory. `alternate` asks whether
 * the primary is covered, and covered means captured: a live smoke fixture is
 * not parser evidence (#4452 review F4).
 */
function realExemptionProblems(exempt: Iterable<[string, string]>): string[] {
	return exemptionProblems(exempt, capturedFixtureRunnerIds());
}

/** The census over the real registry and fixture directory. */
function censusGaps(exempt: ReadonlyMap<string, string>): string[] {
	return uncapturedRunners(
		registeredRunnerIds(),
		capturedFixtureRunnerIds(),
		exempt,
	);
}

/**
 * Deferral phrasing is not a reason. #1937 found "no fixture yet" standing in
 * the map for nine runners; a category prefix would otherwise launder it.
 */
const DEFERRAL_PHRASE =
	/\bno\s+(?:captured\s+)?fixtures?\b|\bnot\s+(?:yet\s+)?captured\b|\bcaptur(?:e|ed)\s+(?:it\s+)?(?:later|someday|eventually)\b|\bto\s?do\b/i;

/** Split `"<category>: <detail>"`; null when the reason is not in that form. */
function parseExemptionReason(
	reason: string,
): { category: string; detail: string } | null {
	const match = reason.match(/^([a-z-]+):\s*(.+)$/);
	if (!match) return null;
	return { category: match[1], detail: match[2].trim() };
}

/**
 * Everything wrong with a set of exemptions, as human-readable strings.
 *
 * Taken as a parameter rather than closing over `EXEMPT` so the rules can be
 * exercised against a synthetic map. Without that, a rule with no matching
 * entry in the real map — `pending` has none most of the time — is a loop over
 * an empty set that passes no matter what it says (#1937 round 2). The tests
 * below run this same function on both.
 */
function exemptionProblems(
	exempt: Iterable<[string, string]>,
	covered: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const [id, reason] of exempt) {
		const parsed = parseExemptionReason(reason);
		if (!parsed) {
			problems.push(
				`${id}: reason is not "<category>: <detail>" — got "${reason}"`,
			);
			continue;
		}
		if (!(parsed.category in EXEMPTION_CATEGORIES)) {
			problems.push(
				`${id}: unknown category "${parsed.category}" (allowed: ${Object.keys(EXEMPTION_CATEGORIES).join(", ")})`,
			);
		}
		if (
			FACT_CATEGORIES.has(parsed.category) &&
			EVIDENCE_HOST_OR_TIME.test(parsed.detail)
		) {
			problems.push(
				`${id}: ${parsed.category} detail "${parsed.detail}" speaks of evidence, the host or time; only pending may, and it needs an issue`,
			);
		}
		if (DEFERRAL_PHRASE.test(parsed.detail)) {
			problems.push(
				`${id}: detail "${parsed.detail}" is deferral phrasing, not a fact about why real output is unreachable`,
			);
		}
		if (parsed.detail.length < 20) {
			problems.push(
				`${id}: detail "${parsed.detail}" is too short to explain why real output is unreachable`,
			);
		}
		// `alternate` is the easiest category to abuse: two uncovered runners
		// can name each other and neither ever meets a binary.
		if (parsed.category === "alternate") {
			const primary = parsed.detail.split(/[\s,;]/)[0];
			if (!covered.has(primary)) {
				problems.push(
					`${id}: names "${primary}" as its primary, but that runner has no live or captured fixture either`,
				);
			}
		}
		// `pending` is the only category that expires, so it must name the
		// issue or PR that removes it.
		if (parsed.category === "pending" && !/#\d+/.test(parsed.detail)) {
			problems.push(
				`${id}: a pending exemption must reference the issue or PR that removes it — got "${parsed.detail}"`,
			);
		}
	}
	return problems;
}

describe("smoke-fixture coverage", () => {
	it("every registered runner has a captured fixture or an explicit exemption", () => {
		const uncovered = censusGaps(EXEMPT);
		expect(
			uncovered,
			`registered runner(s) with no captured real-bytes fixture and no exemption. Capture bytes with scripts/capture-runner-fixtures.mjs, or exempt with a category: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("no stale exemptions (every exempted id is still a registered runner)", () => {
		const registered = new Set(registeredRunnerIds());
		const stale = [...EXEMPT.keys()].filter((id) => !registered.has(id));
		expect(
			stale,
			`exemption(s) for non-existent runner(s): ${stale.join(", ")}`,
		).toEqual([]);
	});

	// A runner that gained a captured fixture must LOSE its exemption. Otherwise
	// the map keeps growing and stops describing anything; #209's `lsp` and
	// `pyright` entries had both outlived their reasons by the time #1937 looked.
	it("no exemption for a runner that already has captured bytes", () => {
		const redundant = redundantExemptions(EXEMPT, capturedFixtureRunnerIds());
		expect(
			redundant,
			`runner(s) exempted despite having a captured fixture — delete the exemption: ${redundant.join(", ")}`,
		).toEqual([]);
	});

	// Recurrence: fourteen runners passed the old live-or-captured rule on a
	// Step-1 smoke fixture alone, so go-vet (#4451) and dart-analyze kept parsers
	// that had never met their binary's bytes. Run the census with NO exemptions
	// and the runners that only a live fixture backs must still be flagged.
	it("a live smoke fixture alone does not satisfy the census", () => {
		const gaps = censusGaps(new Map());
		for (const id of ["psscriptanalyzer"]) {
			expect(
				liveFixtureRunnerIds().has(id),
				`${id} lost its live fixture, so this probe no longer separates live from captured; pick another live-only runner`,
			).toBe(true);
			expect(
				gaps,
				`${id} has a live smoke fixture and no captured bytes, so the census must flag it`,
			).toContain(id);
		}
	});

	// Recurrence: the census is a loop over the registry, and a loop that has
	// never seen a gap proves nothing. Feed it a runner nobody captured.
	// Recurrence: the rewritten redundancy test looped over the real map, which
	// holds no redundant entry, so neutering its filter stayed green (#4452
	// review F3). Feed the pure function a map that does hold one.
	it("an exemption for a runner that has captured bytes is flagged", () => {
		const exempt = new Map([
			[
				"captured-one",
				"structural: in-process analysis with no external process",
			],
			["bare-one", "structural: in-process analysis with no external process"],
		]);
		expect(redundantExemptions(exempt, new Set(["captured-one"]))).toEqual([
			"captured-one",
		]);
	});

	// Recurrence: "absent from this host" was filed as `toolchain` for Ruby and
	// PowerShell, both preinstalled on ubuntu-latest (#4452 review F2). The set
	// of ids allowed there is a table a reviewer must edit.
	// Recurrence: the alternate rule kept counting a live smoke fixture as the
	// primary's coverage after the census stopped (#4452 review F4). psscriptanalyzer
	// has a live fixture and no captured bytes.
	it("an alternate whose primary has only a live fixture is rejected", () => {
		expect(liveFixtureRunnerIds().has("psscriptanalyzer")).toBe(true);
		expect(capturedFixtureRunnerIds().has("psscriptanalyzer")).toBe(false);
		const problems = realExemptionProblems([
			[
				"synthetic-alt",
				"alternate: psscriptanalyzer is the primary for this language",
			],
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/names "psscriptanalyzer" as its primary/);
	});

	it("toolchain and platform exemptions are a pinned set", () => {
		expect(
			unpinnedFactExemptions(EXEMPT, PINNED_FACT_EXEMPTIONS),
			"a toolchain or platform exemption was added or removed without editing PINNED_FACT_EXEMPTIONS; name the missing tool and why CI cannot provide it",
		).toEqual([]);
		const planted = new Map([
			["rubocop", "toolchain: a Ruby gem, and Ruby is not installed"],
		]);
		expect(unpinnedFactExemptions(planted, PINNED_FACT_EXEMPTIONS)).toEqual([
			"toolchain: rubocop is not pinned",
		]);
		expect(
			unpinnedFactExemptions(new Map(), { toolchain: ["gone-one"] }),
		).toEqual(["toolchain: gone-one is pinned but gone"]);
	});

	it("the census flags a synthetic runner with no fixture and no exemption", () => {
		const exempt = new Map([
			[
				"b",
				"structural: in-process analysis with no external process to capture",
			],
		]);
		expect(
			uncapturedRunners(["a", "b", "synthetic-runner"], new Set(["a"]), exempt),
		).toEqual(["synthetic-runner"]);
	});

	it("every exemption is well formed under the shared rules", () => {
		const problems = realExemptionProblems(EXEMPT);
		expect(problems, `malformed exemption(s): ${problems.join(" | ")}`).toEqual(
			[],
		);
	});

	// The rules above are only as good as their coverage of cases the real map
	// does not currently contain. Run the SAME function over a synthetic map so
	// each rule is proven to fire, rather than proven to loop over nothing.
	it("the shared rules reject every malformed shape", () => {
		const covered = new Set(["oxlint"]);
		const reject = (id: string, reason: string, expected: RegExp) => {
			const problems = exemptionProblems([[id, reason]], covered);
			expect(
				problems.some((problem) => expected.test(problem)),
				`expected "${reason}" to be rejected as ${expected}, got ${JSON.stringify(problems)}`,
			).toBe(true);
		};

		reject("a", "no fixture yet", /not "<category>: <detail>"/);
		reject(
			"b",
			"someday: we will get to this eventually, honestly",
			/unknown category "someday"/,
		);
		reject("c", "platform: too short", /too short/);
		reject(
			"d",
			"alternate: detekt is the primary and covers this language",
			/names "detekt" as its primary/,
		);
		reject(
			"e",
			"pending: someone will get around to capturing this one",
			/must reference the issue or PR/,
		);
		// Each DEFERRAL_PHRASE arm gets its own row under `pending`, where the
		// derived rule does not apply, so a neutered arm reds here and nowhere
		// else (#4452 review F3: two of four arms were unpinned).
		reject(
			"j",
			"pending: #1937 we will capture it later on a bigger runner",
			/deferral phrasing/,
		);
		reject(
			"k",
			"pending: #1937 TODO write the capture for this runner",
			/deferral phrasing/,
		);
		// The derived rule: only `pending` may speak of evidence, the host or
		// time. Each phrasing below slipped the lexical list or was filed as a
		// fact about the capture host.
		const rejectDerived = (id: string, reason: string) => {
			const problems = exemptionProblems([[id, reason]], covered);
			expect(
				problems.some((problem) =>
					/speaks of evidence, the host or time/.test(problem),
				),
				`expected "${reason}" to be rejected by the derived rule, got ${JSON.stringify(problems)}`,
			).toBe(true);
		};
		rejectDerived(
			"l",
			"toolchain: awaiting capture on a CI image, fixture to follow",
		);
		rejectDerived("m", "toolchain: Ruby is absent from this host entirely");
		rejectDerived("n", "platform: no binary exists here for macOS yet");
		rejectDerived(
			"o",
			"opt-in: runs once the replay harness models its probes",
		);
		// A fact about the tool passes the same rule.
		expect(
			exemptionProblems(
				[
					[
						"p",
						"toolchain: needs the Swift toolchain, which ubuntu-latest does not ship",
					],
				],
				covered,
			),
		).toEqual([]);
		// The category prefix must not launder the phrase #1937 removed.
		reject(
			"h",
			"toolchain: no fixture yet for this runner on any platform",
			/deferral phrasing/,
		);
		reject(
			"i",
			"pending: #1937 the bytes are not captured yet for this one",
			/deferral phrasing/,
		);

		// The well-formed shapes must pass, so the rules are not simply
		// rejecting everything.
		expect(
			exemptionProblems(
				[
					["f", "alternate: oxlint is the JS/TS lint primary for this kind"],
					[
						"g",
						"pending: #1937 captures it once the toolchain is on the image",
					],
				],
				covered,
			),
		).toEqual([]);
	});
});

/**
 * Every `tests/fixtures/runner-exit-codes/<runner>/<case>.captured.json` as a
 * `CapturedOutput`-shaped record. Built here, not in the helper, because the
 * helper's population is `runner-output` by design.
 */
function listExitCodeFixtures(): CapturedOutput[] {
	const root = path.join(repoRoot, "tests/fixtures/runner-exit-codes");
	const out: CapturedOutput[] = [];
	if (!fs.existsSync(root)) return out;
	for (const runner of fs.readdirSync(root).sort()) {
		const dir = path.join(root, runner);
		for (const entry of fs.readdirSync(dir).sort()) {
			if (!entry.endsWith(".captured.json")) continue;
			// Raw fields only: a missing exitCode or stderr must reach the checks
			// that refuse it, not a default that makes it look captured.
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
			out.push({
				...parsed,
				relPath: `tests/fixtures/runner-exit-codes/${runner}/${entry}`,
				caseName: entry.replace(/\.captured\.json$/, ""),
			} as CapturedOutput);
		}
	}
	return out;
}

describe("captured real-bytes fixture provenance", () => {
	const captured = listCapturedOutputs();

	it("there is at least one captured fixture", () => {
		expect(
			captured.length,
			`${CAPTURED_OUTPUT_DIR} is empty — the provenance assertions below would pass vacuously`,
		).toBeGreaterThan(0);
	});

	// A fixture whose bytes nobody can trace is a hand-written fixture one step
	// removed: you cannot tell whether it came from a binary or from a guess.
	it("every captured fixture carries a complete provenance header", () => {
		const problems = captured.flatMap(provenanceProblems);
		expect(
			problems,
			`captured fixture(s) with an incomplete provenance header. Re-capture with scripts/capture-runner-output.mjs rather than editing the header by hand:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	// #4473: the replay answers the availability checker's own spawn from this
	// record. Without one it must mock the checker, and a mocked checker cannot
	// see a tool that rejects its probe (helm 4 rejects `--version`).
	it("every captured fixture records the availability probe its runner sends", () => {
		const problems = captured.flatMap(availabilityProblems);
		expect(
			problems,
			`captured fixture(s) with no complete availability record. The replay runs the REAL checker against this record, so a fixture without one cannot be replayed honestly:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	// #4522: the tool-state matrix's clean cell replays this run. A fixture with
	// no clean record leaves that cell modelling bytes the tool never printed.
	it("every captured fixture records a real clean run", () => {
		const problems = captured.flatMap(cleanProblems);
		expect(
			problems,
			`captured fixture(s) whose clean cell would model invented bytes. Re-capture with scripts/capture-runner-fixtures.mjs --records-only:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	// The one gate the capture refuses to write past, re-read over every fixture
	// on disk (#4522 F2, F3, F10): a probe record must carry a version its own
	// answer printed, and its clean run must be the fixture's own invocation.
	it("every captured record is evidence about this binary and this invocation", () => {
		const problems = captured.flatMap((fixture) => recordProblems(fixture));
		expect(
			problems,
			`captured record(s) that name a binary which never answered, or a clean run this fixture never sends. Re-capture with scripts/capture-runner-fixtures.mjs --records-only:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	it("every captured clean run's workspace still exists", () => {
		const missing = captured
			.filter(
				(fixture) =>
					fixture.clean &&
					!fs.existsSync(path.join(repoRoot, fixture.clean.workspace)),
			)
			.map((fixture) => `${fixture.relPath} → ${fixture.clean?.workspace}`);
		expect(
			missing,
			`captured clean workspace(s) that no longer exist — the clean run cannot be reproduced: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every captured clean run's input exists in its workspace", () => {
		const missing = captured
			.filter(
				(fixture) =>
					fixture.clean &&
					fs.existsSync(path.join(repoRoot, fixture.clean.workspace)) &&
					!fs.existsSync(
						path.join(repoRoot, fixture.clean.workspace, fixture.clean.file),
					),
			)
			.map((fixture) => `${fixture.relPath} → ${fixture.clean?.file}`);
		expect(
			missing,
			`captured clean run(s) whose analysed input is gone — the bytes are a report about nothing: ${missing.join(", ")}`,
		).toEqual([]);
	});

	// #4522 review F3: the exit-code fixtures (`tests/fixtures/runner-exit-codes/`)
	// are written by the same capture script, so they meet the same provenance and
	// availability gates. They sit outside `runner-output`, so `listCapturedOutputs`
	// never reached them; this walk is their census.
	it("every exit-code fixture carries a complete provenance and availability record", () => {
		const problems = listExitCodeFixtures().flatMap((fixture) => [
			...provenanceProblems(fixture),
			...availabilityProblems(fixture),
		]);
		expect(
			problems,
			`exit-code fixture(s) with an incomplete provenance or availability record. Re-capture with scripts/capture-runner-output.mjs --out-dir tests/fixtures/runner-exit-codes:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	// #4522 review R2 F3: the capture gate's own rule (recordProblems) runs over the
	// exit-code root too. Without it, a version the probe never printed (the
	// availability answer's banner disagreeing with the recorded version) passes
	// this census. Recurrence: the round-2 census ran the provenance and
	// availability checks and not the gate the capture itself uses.
	it("every exit-code fixture passes the capture gate's record rule", () => {
		const problems = listExitCodeFixtures().flatMap((fixture) =>
			recordProblems(fixture),
		);
		expect(
			problems,
			`exit-code fixture(s) whose recorded answers the capture gate refuses:\n${problems.join("\n")}`,
		).toEqual([]);
	});

	// A clean run is required of every runner-output fixture because the matrix's
	// clean cell replays it. An exit-code fixture is a failing run whose input is
	// the failure itself: the invalid configuration. A valid-config run of the
	// same invocation is a different capture, so each fixture below is admitted
	// without a clean run, by name, with its reason. Stale entries red.
	const EXIT_CODE_CLEAN_ADMISSIONS: Record<string, string> = {
		"detekt/broken-config":
			"the malformed detekt.yml is the input; the same invocation on a valid config is not this probe",
		"detekt/findings-then-exit1":
			"the non-numeric build.weights value is the input that fails the run after it reports",
	};
	it("every exit-code fixture without a clean run is admitted by name with its reason", () => {
		const fixtures = listExitCodeFixtures();
		const unadmitted = fixtures
			.filter((f) => !f.clean)
			.filter(
				(f) =>
					!(
						f.relPath
							.replace(/^tests\/fixtures\/runner-exit-codes\//, "")
							.replace(/\.captured\.json$/, "") in EXIT_CODE_CLEAN_ADMISSIONS
					),
			)
			.map((f) => f.relPath);
		expect(
			unadmitted,
			`exit-code fixture(s) with no clean run and no named admission: ${unadmitted.join(", ")}`,
		).toEqual([]);
		const stale = Object.keys(EXIT_CODE_CLEAN_ADMISSIONS).filter(
			(key) =>
				!fixtures.some(
					(f) =>
						f.relPath ===
						`tests/fixtures/runner-exit-codes/${key}.captured.json`,
				),
		);
		expect(
			stale,
			`stale clean-run admission(s) with no such exit-code fixture: ${stale.join(", ")}`,
		).toEqual([]);
	});

	// #4522 F1: `.gitignore` ignores `*.js` and `*.md` globally, so a clean
	// workspace whose inputs are JavaScript or Markdown was captured, replayed
	// from the working tree, and never committed: five fixtures named workspaces
	// no fresh checkout has. The population is every fixture input on disk, not a
	// list of the extensions that broke, and git itself decides — a spelling list
	// here would pass the next input shape.
	it("no captured fixture input is hidden by .gitignore", async () => {
		const roots = [
			path.join(repoRoot, "tests/fixtures/runner-output"),
			path.join(repoRoot, "tests/fixtures/runner-output-clean"),
			path.join(repoRoot, "tests/fixtures/runner-exit-codes"),
		];
		const inputs: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else inputs.push(full);
			}
		};
		for (const root of roots) walk(root);
		assertNonEmptyScan("captured fixture inputs", inputs.length, 60);
		_resetUntrackedIgnoredCacheForTests();
		const hiddenIds = await collectUntrackedIgnoredIds(repoRoot);
		// Fail closed: no git answer is not an empty population. A census that
		// reads "unavailable" as "clean" is how the inputs went missing.
		expect(
			hiddenIds,
			`git could not enumerate the ignored files under ${repoRoot}, so this census cannot say whether the fixtures survive a fresh checkout`,
		).toBeDefined();
		const hidden = inputs
			.map((file) => path.relative(repoRoot, file).replace(/\\/g, "/"))
			.filter((file) =>
				hiddenIds?.has(normalizeMapKey(path.join(repoRoot, file))),
			);
		expect(
			hidden,
			`captured fixture input(s) .gitignore hides, so a fresh checkout cannot replay them: ${hidden.join(", ")}`,
		).toEqual([]);
	});

	it("every captured fixture belongs to a registered runner", () => {
		const registered = new Set(registeredRunnerIds());
		const orphans = captured
			.filter((f) => !registered.has(f.provenance?.runner))
			.map((f) => `${f.relPath} (runner "${f.provenance?.runner}")`);
		expect(
			orphans,
			`captured fixture(s) for a runner that is no longer registered: ${orphans.join(", ")}`,
		).toEqual([]);
	});

	// The recorded workspace is the re-capture recipe. If it is gone, the
	// fixture can be replayed but never refreshed against a newer tool version.
	it("every captured fixture's recorded workspace still exists", () => {
		const missing = captured
			.filter(
				(f) =>
					!f.provenance?.workspace ||
					!fs.existsSync(path.join(repoRoot, f.provenance.workspace)),
			)
			.map((f) => `${f.relPath} → ${f.provenance?.workspace}`);
		expect(
			missing,
			`captured fixture(s) whose recorded workspace is missing: ${missing.join(", ")}`,
		).toEqual([]);
	});

	// #1933's vale bug survived its first review round because
	// exit-blind-runners.test.ts carried a HAND-WRITTEN vale fixture in the same
	// wrong envelope shape as the parser. Test and code shared one wrong
	// assumption, so the test proved nothing.
	//
	// The rule: a runner whose tool output is asserted from an inline literal in
	// that file must also have captured real bytes, so the literal has something
	// to be wrong against. Exemption categories `platform` and `pending` are the
	// only escapes — a binary that cannot run here, or one another PR owns.
	it("every runner with an inline tool-output literal also has captured bytes", () => {
		const source = fs.readFileSync(
			path.join(
				repoRoot,
				"tests/clients/dispatch/runners/exit-blind-runners.test.ts",
			),
			"utf8",
		);
		const inlineTools = [...source.matchAll(/^\t\ttool:\s*"([^"]+)"/gm)].map(
			(m) => m[1],
		);
		expect(
			inlineTools.length,
			"found no inline `tool:` cases — this guard has lost its target and must be repointed",
		).toBeGreaterThan(0);

		const capturedIds = capturedFixtureRunnerIds();
		const excused = new Set(
			[...EXEMPT.entries()]
				.filter(([, reason]) => {
					const category = parseExemptionReason(reason)?.category;
					return category === "platform" || category === "pending";
				})
				.map(([id]) => id),
		);
		const unbacked = inlineTools.filter(
			(id) => !capturedIds.has(id) && !excused.has(id),
		);
		expect(
			unbacked,
			`exit-blind-runners.test.ts asserts hand-written output for runner(s) that have never met a real binary: ${unbacked.join(", ")}. Capture bytes with scripts/capture-runner-output.mjs, or exempt the runner as platform/pending.`,
		).toEqual([]);
	});
});

/**
 * The scheduled parser lane (.github/workflows/parser-smoke.yml) runs
 * `smoke-tools.mjs --step2 --tier1`: install the real binary, dispatch over a
 * planted violation, fail when the runner finds nothing. These assertions keep
 * that lane from quietly becoming a no-op.
 */
describe("tier-1 parser lane", () => {
	const workflowPath = ".github/workflows/parser-smoke.yml";
	const workflow = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");

	it("selects a non-empty set of fixtures", () => {
		expect(
			tier1Fixtures().length,
			"no fixture carries `tier1: true` — the scheduled lane would exit 2 with nothing to run",
		).toBeGreaterThan(0);
	});

	// A tier-1 fixture with no `tools` cannot be provisioned by `--install`, and
	// one without `expectDiagnostic` is exempt from the Step-2 verdict — either
	// way the lane runs it and asserts nothing.
	it("every tier-1 fixture is installable and asserted", () => {
		const bad = tier1Fixtures()
			.filter((fx) => !(fx.tools ?? []).length || fx.expectDiagnostic !== true)
			.map((fx) => fx.lang);
		expect(
			bad,
			`tier-1 fixture(s) that --install cannot provision or --step2 does not assert: ${bad.join(", ")}`,
		).toEqual([]);
	});

	it("every tier-1 fixture's project directory exists", () => {
		const missing = tier1Fixtures()
			.filter((fx) => !fs.existsSync(path.join(repoRoot, fx.dir)))
			.map((fx) => `${fx.lang} → ${fx.dir}`);
		expect(
			missing,
			`tier-1 fixture(s) with no project dir: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("the workflow asserts findings and keeps no language list of its own", () => {
		expect(
			workflow,
			`${workflowPath} must run the Step-2 verdict, not the Step-1 spawn check`,
		).toContain("--step2");
		expect(
			workflow,
			`${workflowPath} must select through --tier1 so the fixture rows stay the single source`,
		).toContain("--tier1");
		const invocation =
			workflow.match(/node scripts\/smoke-tools\.mjs[^\n]*/)?.[0] ?? "";
		const positional = invocation
			.split(/\s+/)
			.slice(2)
			.filter((token) => !token.startsWith("--"));
		expect(
			positional,
			`${workflowPath} names languages inline (${positional.join(", ")}) — that list duplicates the \`tier1\` flags in scripts/smoke-tools.mjs and will drift`,
		).toEqual([]);
	});

	/**
	 * An unavailable tool reports the warning state, never a failure, so a run
	 * where every install failed exits 0 with a clean report. That is an
	 * unspawnable prober delivering a durable green verdict. `--min-pass` is
	 * the floor that makes mass unavailability red while a single missing tool
	 * stays a visible warning.
	 */
	it("the workflow sets a pass floor that tracks the tier-1 fixture rows", () => {
		const declared = workflow.match(/--min-pass=(\d+)/)?.[1];
		expect(
			declared,
			`${workflowPath} sets no --min-pass, so a run where every tool failed to install would exit 0`,
		).toBeDefined();

		const targets = tier1Fixtures().flatMap((fx) => fx.targets ?? []);
		// 80% of the tier-1 targets. Below that the lane is not measuring the
		// tier it claims to; above it, one tool missing on a given night is
		// still allowed through as a warning.
		const required = Math.floor(targets.length * 0.8);
		expect(
			Number(declared),
			`--min-pass=${declared} is too low for ${targets.length} tier-1 target(s) — it must be at least ${required}, so adding fixtures without raising the floor reds here`,
		).toBeGreaterThanOrEqual(required);
		expect(
			Number(declared),
			`--min-pass=${declared} exceeds the ${targets.length} tier-1 target(s), so the lane can never pass`,
		).toBeLessThanOrEqual(targets.length);
	});

	it("the pass floor fires on mass unavailability and holds otherwise", () => {
		const unavailable = [
			{ state: "skip" as const },
			{ state: "skip" as const },
			{ state: "pass" as const },
		];
		expect(passFloorBreach(unavailable, 3)).toMatch(/pass floor/);
		expect(passFloorBreach(unavailable, 1)).toBeNull();
		// No floor declared is the pre-existing behaviour, unchanged.
		expect(passFloorBreach(unavailable, null)).toBeNull();
		// `--min-pass=0` (and below) is "no floor", not an invalid one: the helper
		// rejects a floor under 1, so the guard in front of it carries this.
		expect(passFloorBreach(unavailable, 0)).toBeNull();
		expect(passFloorBreach(unavailable, -1)).toBeNull();
		// The message keeps its counts (the helper's record supplies them).
		expect(passFloorBreach(unavailable, 3)).toContain(
			"1 runner(s) passed, at least 3 required (2 unavailable)",
		);
		// The sentence follows what happened (#5021 verify F10): a lane that
		// passed servers did install something, so it must not say it installed
		// nothing; one that passed nothing still says so.
		expect(passFloorBreach(unavailable, 3)).not.toContain("installs nothing");
		expect(passFloorBreach(unavailable, 3)).toContain("fewer servers");
		expect(passFloorBreach([{ state: "skip" as const }], 1)).toContain(
			"installs nothing",
		);
		// A floor that is not a number (`--min-pass=abc`) is red, never "no floor".
		expect(() => passFloorBreach(unavailable, Number.NaN)).toThrow(TypeError);
	});
});
