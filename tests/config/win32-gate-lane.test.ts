import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	findWin32Gates,
	getWin32GateFiles,
	getWin32LaneFiles,
	readWalkedFile,
	recordedVanishedPathCount,
	VANISHED_PATH_RECORD_CAP,
	WINDOWS_LANE_ADMISSIONS,
} from "../../scripts/lib/win32-gate-population.mjs";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = resolve(ROOT, "tests");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");
const LANE_HEADER = "// lane: windows-vitest";

type Step = { name?: string; run?: string; shell?: string };

function windowsJobSteps(): Step[] {
	const workflow = yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs?: Record<string, { steps?: Step[] }>;
	};
	return workflow.jobs?.["unit-tests-windows"]?.steps ?? [];
}

function windowsGatePattern(): RegExp {
	// String contents are blanked by stripSource, so match the quote pair and
	// validate the raw span separately. This keeps comments and strings inert.
	return new RegExp(
		`(?:it|describe)\\.(?:skipIf|runIf)\\(\\s*process\\.platform\\s*(?:!==|===)\\s*["']\\s*["']\\s*\\)`,
		"g",
	);
}

function isWindowsOnlyGate(match: string, rawSpan: string): boolean {
	if (!/["']win32["']/.test(rawSpan)) return false;
	return (
		(match.includes("skipIf") && match.includes("!==")) ||
		(match.includes("runIf") && match.includes("==="))
	);
}

// One walk and read of tests/ for every case in this file. Each tests/-tree
// walk measured 22.8 s under Stryker's dry run (#3104 review F4), so the
// cases below share the walk, the library's lane population and its gates.
let walkedTests: Array<{ file: string; source: string }> | undefined;
let laneFiles: string[] | undefined;
let gateFiles: string[] | undefined;
let gates: Array<{ file: string; line: number }> | undefined;

function walkedTestSources(): Array<{ file: string; source: string }> {
	// readWalkedFiles: a path that vanished between the walk and the read is
	// out of the population, not a finding (#3082).
	walkedTests ??= readWalkedFiles(
		listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
			exclude: (file) => file.includes("/fixtures/"),
		}),
	);
	return walkedTests;
}

function libraryLaneFiles(): string[] {
	laneFiles ??= getWin32LaneFiles(ROOT);
	return laneFiles;
}

function libraryGateFiles(): string[] {
	gateFiles ??= getWin32GateFiles(ROOT);
	return gateFiles;
}

function libraryGates(): Array<{ file: string; line: number }> {
	gates ??= findWin32Gates(ROOT);
	return gates;
}

function detectedWin32GateFiles(): string[] {
	const detected = new Set<string>();
	for (const { file: absolute, source: raw } of walkedTestSources()) {
		const stripped = stripSource(raw);
		for (const match of stripped.matchAll(windowsGatePattern())) {
			const offset = match.index ?? 0;
			if (
				isWindowsOnlyGate(match[0], raw.slice(offset, offset + match[0].length))
			)
				detected.add(relativePosix(ROOT, absolute));
		}
	}
	return [...detected].sort();
}

describe("win32 gate lane governance (#2536)", () => {
	it("names the lane for every Windows-only declarative gate", () => {
		const missing: string[] = [];
		let gateCount = 0;

		for (const { file: absolute, source: raw } of walkedTestSources()) {
			const stripped = stripSource(raw);
			for (const match of stripped.matchAll(windowsGatePattern())) {
				const offset = match.index ?? 0;
				if (
					!isWindowsOnlyGate(
						match[0],
						raw.slice(offset, offset + match[0].length),
					)
				)
					continue;
				gateCount++;
				const line = raw.slice(0, offset).split("\n").length;
				const previousLine = raw.split("\n")[line - 2] ?? "";
				if (!previousLine.trim().startsWith(LANE_HEADER)) {
					missing.push(`${relativePosix(ROOT, absolute)}:${line}`);
				}
			}
		}

		assertNonEmptyScan("win32 gate detection", gateCount, 1);
		expect(missing, "every Windows-only gate must name windows-vitest").toEqual(
			[],
		);
	});

	it("keeps the workflow population and execution filter wired", () => {
		const steps = windowsJobSteps();
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const runnerRun = runner?.run ?? "";

		// Recurrence: #2536's gates can be documented yet omitted from the only
		// Windows job, leaving the platform-specific assertions unexecuted. The
		// enumeration step's command is pinned by windows-vitest-workflow.test.ts.
		const detectedFiles = detectedWin32GateFiles();
		const population = libraryLaneFiles();
		expect(population).toContain(
			"tests/clients/dispatch/runners/go-vet.test.ts",
		);
		expect(libraryGates().length).toBeGreaterThan(0);
		expect(libraryGateFiles()).toEqual(expect.arrayContaining(detectedFiles));
		expect(population).toEqual(expect.arrayContaining(detectedFiles));
		expect(runnerRun).toContain('vitest run "${FILES[@]}"');
		expect(runner?.shell).toBe("bash");
	}, 60_000);

	// #3278 made this the SECOND admission: two tests/-tree walks blew vitest's
	// 5 s default in the nightly Stryker job. Same 60 s budget and the same
	// reason as the sibling: walk time, not wall-clock waiting.
	it("keeps every explicit Windows admission live and reasoned (#3277)", () => {
		const population = libraryLaneFiles();
		for (const admission of WINDOWS_LANE_ADMISSIONS) {
			const source = readFileSync(resolve(ROOT, admission.file), "utf8");
			expect(source).toContain(LANE_HEADER);
			expect(admission.reason).toMatch(/#\d+/);
			expect(population).toContain(admission.file);
		}
	}, 60_000);

	// #3104 review F6: this module walks the tests/ tree and reads what the walk
	// returned, so it carries the #3082 tolerant read. It cannot import
	// tests/support/sweep-kit.ts (scripts/ must not depend on tests/), so the
	// behaviour parity — including once per DISTINCT path, not once per
	// occurrence — is pinned here instead of assumed.
	it("tolerates a vanished walked file and warns once per distinct path (#3082)", () => {
		const gone = resolve(ROOT, "tests/definitely-not-a-real-file-3082.ts");
		// The record goes through a raw stderr write, not console.warn (#3107):
		// Vitest's default reporter swallows a worker's console.warn on a
		// passing run, so the record would never reach CI's job log otherwise.
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			expect(readWalkedFile(gone)).toBeUndefined();
			expect(readWalkedFile(gone)).toBeUndefined();
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[0]).toMatch(/vanished between the walk/);
		} finally {
			write.mockRestore();
		}
		// A directory is EISDIR, not a vanished file: a real failure must not be
		// laundered into "this file left the population".
		expect(() => readWalkedFile(resolve(ROOT, "tests"))).toThrow();
	});

	// #3107: the parity comment above readWalkedFile in
	// win32-gate-population.mjs claims the bound is identical to the
	// TypeScript seam's oldest-first BoundedSet eviction. Pin that claim here
	// too, the same way the TypeScript seam's own
	// "bounds the vanished-path record" test pins it — a hand-rolled
	// clear()-on-overflow Set (the pre-fix shape) passes every other test in
	// this file but caps below VANISHED_PATH_RECORD_CAP after clearing, so
	// this is the one assertion that would catch that regression.
	it("bounds the vanished-path record at VANISHED_PATH_RECORD_CAP (#3107)", () => {
		const before = recordedVanishedPathCount();
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			for (let index = 0; index < VANISHED_PATH_RECORD_CAP + 50; index++)
				readWalkedFile(resolve(ROOT, `tests/absent-3107-${index}.ts`));
		} finally {
			write.mockRestore();
		}
		expect(before).toBeLessThanOrEqual(VANISHED_PATH_RECORD_CAP);
		expect(recordedVanishedPathCount()).toBe(VANISHED_PATH_RECORD_CAP);
	});
});
