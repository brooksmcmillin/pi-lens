// flake-shape: real-process-spawn — the subject is Vitest's own fork teardown: the pool SIGTERMs the worker after the shared afterAll, and no in-process double reproduces that kill or a hook timeout.
/**
 * The shared setup's registry settle, driven through the REAL hook (#3617,
 * #3703 round 2). Round 1's test called the settle helper directly, so
 * deleting the `await` from the `afterAll` left it green. This file runs two
 * fixture files in a child Vitest with the real `tests/support/vitest-setup.ts`
 * and reads what their forks left behind once the pool tore them down.
 *
 * Recurrences it names: a fire-and-forget registry mutation lost when the
 * fork is SIGTERM'd before the tail drains (#3617), and an unbounded join
 * that times the hook out and skips the teardown checks (#3703 review F3).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCK_WAIT_THROUGH_LEASE_MS } from "../../clients/instance-registry-lock.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { fixtureHomeRoot, pinFixtureHome } from "../clients/test-utils.js";
import { REGISTRY_SETTLE_BOUND_MS } from "./vitest-setup.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_DIR = "tests/fixtures/registry-teardown";

interface FixtureReport {
	testResults: Array<{ name: string; status: string; message?: string }>;
}

let root = "";
let stderr = "";
let report: FixtureReport = { testResults: [] };

/** "passed", or the status with the child's failure message so a red names it. */
function outcomeOf(fixture: string): string | undefined {
	const result = report.testResults.find((entry) =>
		entry.name.replace(/\\/g, "/").endsWith(`${FIXTURE_DIR}/${fixture}`),
	);
	if (!result || result.status === "passed") return result?.status;
	return `${result.status}: ${result.message ?? ""}`;
}

/**
 * Run the fixture files in a child Vitest that loads the REAL shared setup, and
 * read what its forks left behind. The environment is this worker's own plus
 * the three values a child must not inherit differently, so the child is the
 * production shape rather than a curated one (#4591 V1 inherits the rest).
 */
async function runChild(
	label: string,
	childRoot: string,
): Promise<{ report: FixtureReport; stderr: string }> {
	const outputFile = path.join(childRoot, `${label}-report.json`);
	const childStderr = await new Promise<string>((resolve) => {
		execFile(
			process.execPath,
			[
				path.join(REPO, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				`${FIXTURE_DIR}/vitest.config.ts`,
				"--reporter=json",
				`--outputFile=${outputFile}`,
			],
			{
				cwd: REPO,
				timeout: 60_000,
				env: {
					...process.env,
					PI_LENS_HOME: childRoot,
					REGISTRY_TEARDOWN_ROOT: childRoot,
					// The `[mem-file]` line is written last, after the teardown
					// checks, so it shows they ran.
					PI_LENS_TEST_MEM_REPORT_MB: "1",
				},
			},
			(_error, _stdout, childStderr) => resolve(String(childStderr)),
		);
	});
	let parsed: FixtureReport = { testResults: [] };
	try {
		parsed = JSON.parse(fs.readFileSync(outputFile, "utf8")) as FixtureReport;
	} catch {
		// A child that died before the reporter wrote has no results; the cases
		// that need an outcome say so by name.
	}
	return { report: parsed, stderr: childStderr };
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-registry-teardown-"));
	const child = await runChild("main", root);
	report = child.report;
	stderr = child.stderr;
}, 90_000);

afterAll(() => {
	if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("shared setup registry settle, through the real afterAll (#3617)", () => {
	it("lands a root removal still waiting on a peer's lease before the fork is killed", () => {
		expect(outcomeOf("lease-wait.fixture.ts")).toBe("passed");
		const registry = JSON.parse(
			fs.readFileSync(path.join(root, "lease-wait", "instances.json"), "utf8"),
		) as { instances: Array<{ projectRoots?: string[] }> };
		expect(registry.instances.map((entry) => entry.projectRoots)).toEqual([
			[normalizeFilePath(path.join(root, "primary"))],
		]);
	});

	it("gives up on a write frozen by fake timers, reports it, and still runs the teardown checks", () => {
		expect(outcomeOf("fake-timers.fixture.ts")).toBe("passed");
		expect(stderr).toContain(
			`[registry-settle] a registry mutation was still pending after ${REGISTRY_SETTLE_BOUND_MS}ms`,
		);
		expect(stderr).toMatch(
			/\[mem-file\] .*tests\/fixtures\/registry-teardown\/fake-timers\.fixture\.ts/,
		);
	});

	// A lease raised past the bound would make teardown abandon a removal that
	// is legitimately waiting one out, which is #3617's lost write again.
	it("waits longer than one lock lease", () => {
		expect(REGISTRY_SETTLE_BOUND_MS).toBeGreaterThan(
			LOCK_WAIT_THROUGH_LEASE_MS,
		);
	});
});

describe("a nested Vitest child leaves this worker's fixture-home root alone (#4591)", () => {
	// Both nested-Vitest spawners in this suite pass `...process.env`, so a child
	// worker inherits `PI_LENS_TMP_HYGIENE_FIXTURE_HOME`. Publishing the inherited
	// value made the child adopt THIS worker's root and remove it at its own
	// teardown, taking any HOME a case had pinned inside it (#4591 V1). The child
	// below is the real spawner, the pin is live, and both must survive it.
	it("keeps a live pinned home under it after the child exits", async () => {
		const { home, restore } = pinFixtureHome("registry-teardown-nested");
		const nestedRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-teardown-nested-"),
		);
		try {
			const child = await runChild("nested", nestedRoot);
			// A child that never ran would read as clean here.
			expect(child.report.testResults.length).toBeGreaterThan(0);
			expect(fixtureHomeRoot()).toBe(path.dirname(home));
			expect(fs.existsSync(home), `${home} was removed by the nested run`).toBe(
				true,
			);
		} finally {
			restore();
			fs.rmSync(nestedRoot, { recursive: true, force: true });
		}
	}, 90_000);
});
