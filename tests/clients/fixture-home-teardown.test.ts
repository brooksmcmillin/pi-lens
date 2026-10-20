import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isUnderDir } from "../../clients/path-utils.js";
import {
	fixtureHomeRoot,
	pinFixtureHome,
	restorePinnedFixtureHomes,
	setupTestEnvironment,
} from "./test-utils.js";
import { stripSource } from "../support/sweep-kit.js";
import { removeRunBackstopDirs } from "../support/vitest-setup.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * #4591: a child a test never awaits inherits the pinned HOME and its `cwd`,
 * and a write it lands after the fixture root is gone re-creates that root.
 * `pi-lens-4577-resolver-cqF0yk` was still on disk three minutes after its own
 * file's teardown sweep (`registered=1 stragglers=0 failed=0`), and no sweep
 * can remove a root a foreign process re-creates.
 *
 * The late write is modeled in-process: the harness only ever sees the
 * directory appear, never which process wrote it, so the same write at the same
 * moment is the same input. Before #4591 this exact pair — `pinTestHome(home)`
 * with `home` under the fixture root — leaves the root on disk.
 */
describe("a pinned fixture HOME after teardown (#4591)", () => {
	it("places the home outside the root teardown deletes and outside the tmp-root census", () => {
		const env = setupTestEnvironment("pi-lens-4591-fixture-home-");
		const { home, restore } = pinFixtureHome("4591-fixture-home");
		try {
			expect(os.homedir()).toBe(home);
			expect(
				isUnderDir(path.resolve(home), path.resolve(env.tmpDir)),
				"a home inside the fixture root is re-created by a straggler write",
			).toBe(false);
			// The census watches top-level `pi-lens-` entries under the OS temp
			// root; a home the worker owns is not one of them.
			expect(isUnderDir(path.resolve(home), path.resolve(os.tmpdir()))).toBe(
				false,
			);
			// Its lifecycle belongs to the worker-owned scratch root the shared
			// setup removes at teardown, and it sits BESIDE the worker home: a
			// home inside `PI_LENS_HOME` is pi-lens's own housekeeping to
			// production (`isPiLensInternalPath`), which changes what the write
			// path does with it.
			expect(path.dirname(home)).toBe(fixtureHomeRoot());
			expect(
				isUnderDir(
					path.resolve(home),
					path.resolve(process.env.PI_LENS_HOME as string),
				),
			).toBe(false);
		} finally {
			restore();
			env.cleanup();
		}
	});

	it("keeps the fixture root deleted when a straggler writes to the pinned home", () => {
		const env = setupTestEnvironment("pi-lens-4591-fixture-home-late-");
		const { home, restore } = pinFixtureHome("4591-fixture-home-late");
		try {
			expect(os.homedir()).toBe(home);
			env.cleanup();
			expect(fs.existsSync(env.tmpDir)).toBe(false);
			// The write the child lands after teardown, at the same moment.
			fs.mkdirSync(path.join(home, "late-write"), { recursive: true });
			expect(fs.existsSync(path.join(home, "late-write"))).toBe(true);
			expect(fs.existsSync(env.tmpDir)).toBe(false);
		} finally {
			restore();
		}
	});

	it("restores the pinned home when setup throws between the pin and the fixture work", () => {
		const before = os.homedir();
		// The converted call sites pin first and create their fixtures second; a
		// throw in that window never reaches the call site's own `finally`, so
		// nothing would undo the pin (#4591 F3).
		const setupThatThrows = () => {
			pinFixtureHome("4591-setup-throw");
			throw new Error("fixture setup failed");
		};
		expect(setupThatThrows).toThrow("fixture setup failed");
		// This is the harness seam the setup's `afterEach` calls, at the moment it
		// calls it: without it, the next case in this worker reads this case's
		// fixture directory as HOME.
		restorePinnedFixtureHomes();
		expect(os.homedir()).toBe(before);
	});

	it("keeps one fixture-root identity across an in-process run-id change", () => {
		// The census suite mutates `PI_LENS_TMP_HYGIENE_RUN_ID` in-process. Deriving
		// the root again from it would move the directory the teardown removes, and
		// the homes a case created would be left to the six-hour sweep arm (#4591
		// F7).
		const before = fixtureHomeRoot();
		const saved = process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
		try {
			process.env.PI_LENS_TMP_HYGIENE_RUN_ID = "4591-mutated-run-id";
			expect(fixtureHomeRoot()).toBe(before);
		} finally {
			if (saved === undefined) delete process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
			else process.env.PI_LENS_TMP_HYGIENE_RUN_ID = saved;
		}
	});

	it("reclaims this run's fixture-home directory family on the backstop sweep", () => {
		const env = setupTestEnvironment("pi-lens-4591-family-");
		// The name comes from the real seam, not a literal: the sweep matches this
		// run's `worker-home-<run>-` prefix, so renaming the directory family
		// reds here instead of silently leaving a killed worker's copy behind.
		const familyMember = path.join(
			env.tmpDir,
			path.basename(fixtureHomeRoot()),
		);
		// A live sibling invocation's copy is not this run's to remove.
		const liveForeign = path.join(
			env.tmpDir,
			"worker-home-0000000000-7-fixtures",
		);
		for (const dir of [familyMember, liveForeign])
			fs.mkdirSync(path.join(dir, "home"), { recursive: true });
		try {
			removeRunBackstopDirs(env.tmpDir, env.tmpDir);
			expect(fs.existsSync(familyMember)).toBe(false);
			expect(fs.existsSync(liveForeign)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// The teardown itself has no behavioural observer: this file's own `afterAll`
	// runs BEFORE the setup's, and the setup's removal runs after every check, so
	// a guard on the live root would either read the directory too early or miss
	// it entirely. The census suite pins the same class of wiring by source
	// (`tmp-fixture-hygiene.test.ts`, the backstop call), over
	// comment-and-string-blanked text so a comment naming the call cannot satisfy
	// it; deleting either line reds here.
	it("keeps the harness wired to the fixture-home lifecycle", () => {
		const setup = stripSource(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			),
		);
		// #4591 F3: the pin's undo reaches the harness only through this hook.
		expect(setup).toMatch(
			/afterEach\(\(\)\s*=>\s*restorePinnedFixtureHomes\(\)\)/,
		);
		const afterAllBlock =
			/afterAll\(async \(\) => \{[\s\S]*?\n\}\);/.exec(setup)?.[0] ?? "";
		expect(
			afterAllBlock,
			"the worker teardown is no longer declared as expected",
		).not.toBe("");
		// #4591 F5: the worker's own scratch, removed when the worker goes. The
		// run-level sweep arm is the backstop for a worker that never got here,
		// and the family pin above is what keeps its needle on this name.
		expect(afterAllBlock).toContain("removeTempDirSync(fixtureHomeRoot())");
	});
});
