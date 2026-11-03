// flake-shape: real-process-spawn — the claim is what a CHILD process sees of the worker's environment (HOME and the XDG directories it resolves its own config from); an in-process `process.env` read proves the worker, not the inheritance the incident depended on, and the probe child only prints its environment.
// real-home: the pin's own proof: compares paths against the passwd home to show a child never sees it; never reads or writes through it.
/**
 * Recurrence this guards: #4789. `vitest-setup.ts` pinned `PI_LENS_HOME` per
 * worker (#525, #3721) but left `HOME` and the XDG directories at the
 * maintainer's real home, so a child a test spawns (opengrep, semgrep, git,
 * npm, any tool that resolves its own config from `HOME`) wrote
 * `$HOME/.config/.opengrep` and `$HOME/.config/.semgrep` in the real home
 * (2026-10-23, the #4780 verify). A pin of one variable is not a pin of the
 * home: every variable a tool can resolve a home from is pinned together, in
 * the worker, so every child inherits them.
 *
 * Real child spawn, with the reason: the claim is what a CHILD sees. A
 * `process.env` read in this worker proves the worker, not the inheritance a
 * spawned tool relies on, and the incident was a child. The probe child only
 * prints its environment and `os.homedir()`; it writes nothing, so the red run
 * on an unfixed tree cannot touch the real home either.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SCRATCH_DIR_ROOT } from "../../scripts/lib/scratch-dir.mjs";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

/** passwd's answer, never `$HOME`: `os.userInfo()` does not read the env. */
const REAL_HOME = path.resolve(os.userInfo().homedir);

const PROBE = `process.stdout.write(JSON.stringify({
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	homedir: require("node:os").homedir(),
}))`;

function childView(): Record<string, string | undefined> {
	// Inherit the worker's environment exactly as a tool a test spawns would.
	const result = spawnSync(process.execPath, ["-e", PROBE], {
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout) as Record<string, string | undefined>;
}

const same = (a: string, b: string): boolean =>
	path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const under = (child: string, parent: string): boolean => {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

describe("a vitest worker and every child it spawns run under a pinned home (#4789)", () => {
	const VARIABLES = [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
	] as const;

	it(
		"a spawned child reports a HOME and XDG dirs that are not the real home or inside it",
		() => {
			const child = childView();
			for (const variable of VARIABLES) {
				const value = child[variable];
				expect(value, `${variable} unset in the child`).toBeTruthy();
				// The real home itself and the three directories its default layout
				// resolves to are the maintainer's dotfiles. Not "anything under
				// the real home": a lane's TMPDIR and a checkout legitimately sit
				// under it.
				for (const real of [
					REAL_HOME,
					path.join(REAL_HOME, ".config"),
					path.join(REAL_HOME, ".cache"),
					path.join(REAL_HOME, ".local", "share"),
				])
					expect(same(value!, real), `${variable} is ${real}`).toBe(false);
			}
			// What the child's `os.homedir()` answers is what a `~` expands to.
			expect(same(child.homedir!, REAL_HOME)).toBe(false);
			expect(same(child.homedir!, child.HOME!)).toBe(true);
			// Windows resolves `os.homedir()` from USERPROFILE: pinned with HOME.
			expect(child.USERPROFILE).toBe(child.HOME);
		},
		scaledTestTimeout(30_000),
	);

	it(
		"the pinned home is the worker's own scratch: HOME sits under the scratch root and each XDG dir under HOME",
		() => {
			const child = childView();
			expect(under(child.HOME!, SCRATCH_DIR_ROOT)).toBe(true);
			for (const variable of [
				"XDG_CONFIG_HOME",
				"XDG_CACHE_HOME",
				"XDG_DATA_HOME",
			] as const)
				expect(under(child[variable]!, child.HOME!), variable).toBe(true);
			// The directories exist, so a tool that expects to write there does
			// not fall back to its own default.
			for (const variable of VARIABLES)
				expect(fs.statSync(child[variable]!).isDirectory(), variable).toBe(
					true,
				);
		},
		scaledTestTimeout(30_000),
	);

	it("the checkout (every test's cwd) is not an ancestor of the pinned home", () => {
		// Recurrence: a first cut placed HOME under the checkout's `.probe-home`.
		// The repo root is the `cwd` of most tests, so `isAtOrAboveHomeDir(cwd)`
		// became true and 32 `ast-grep-search.test.ts` cases were refused with
		// "cwd is at or above home". The real home sits ABOVE the checkout.
		expect(under(process.env.HOME!, process.cwd())).toBe(false);
	});

	it("the pinned home is not the worker's PI_LENS_HOME, which production treats as its own housekeeping", () => {
		// A HOME inside PI_LENS_HOME would make `isPiLensInternalPath` classify
		// every project file a test writes there as pi-lens housekeeping
		// (`pinFixtureHome` documents the same constraint).
		expect(under(process.env.HOME!, process.env.PI_LENS_HOME!)).toBe(false);
	});
});
