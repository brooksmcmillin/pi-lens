// flake-shape: real-process-spawn — the claim is what a CHILD inherits. Each
// spawn is a real `node -e` child that reports its own HOME, USERPROFILE and
// XDG directories. An in-process read of the builder's output would only prove
// the object, not what the child process sees (#4789: pinning PI_LENS_HOME
// alone left HOME and the XDG dirs at the maintainer's real home).
//
// Recurrence guarded (#4789 class sweep, AGENTS.md shape 82): an operator
// script or gate that builds a child env with only PI_LENS_HOME pinned. The
// three cases below cover the shared builder, the release-qa scratch env (the
// clean reference) and the pr-preflight child env (one of the eight members).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "../../scripts/pr-preflight.mjs";
import { scratchEnv } from "../../scripts/release-qa.mjs";

const CHILD_REPORT = `process.stdout.write(JSON.stringify({
	HOME: process.env.HOME ?? null,
	USERPROFILE: process.env.USERPROFILE ?? null,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null,
}));`;

const REAL_HOME_SENTINEL = "/operator-real-home-sentinel-4789";

function childReport(env: NodeJS.ProcessEnv): Record<string, string | null> {
	const result = spawnSync(process.execPath, ["-e", CHILD_REPORT], {
		env,
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function isUnder(child: string | null, root: string): boolean {
	return (
		child !== null && (child === root || child.startsWith(root + path.sep))
	);
}

let scratch: string;

beforeEach(() => {
	scratch = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scratch-home-env-")),
	);
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("#4789 child environment pins HOME and the XDG dirs, not only PI_LENS_HOME", () => {
	it("release-qa scratchEnv: a spawned child sees HOME, USERPROFILE and every XDG dir under the scratch root", () => {
		const report = childReport(scratchEnv(scratch));
		for (const [key, value] of Object.entries(report)) {
			expect(
				isUnder(value, scratch),
				`${key} = ${value} escapes ${scratch}`,
			).toBe(true);
		}
	});

	it("pr-preflight: the child env for each gate pins HOME under the probe home, not the inherited home", () => {
		const captured: Array<{ env: NodeJS.ProcessEnv }> = [];
		runPreflight({
			cwd: scratch,
			argv: ["--only", "build"],
			env: { PATH: process.env.PATH, HOME: REAL_HOME_SENTINEL },
			// The spawn seam is the process boundary: it records the env object each
			// gate would hand its child; the child itself never runs.
			spawn: ((
				_file: string,
				_args: readonly string[],
				opts: { env: NodeJS.ProcessEnv },
			) => {
				captured.push({ env: opts.env });
				return { status: 0, stdout: "", stderr: "" };
			}) as unknown as typeof spawnSync,
		});
		expect(captured).toHaveLength(1);
		const env = captured[0].env;
		const probeHome = path.join(scratch, ".probe-home");
		expect(env.PI_LENS_HOME).toBe(probeHome);
		expect(env.HOME, "HOME is the inherited real home").not.toBe(
			REAL_HOME_SENTINEL,
		);
		expect(isUnder(env.HOME ?? null, probeHome)).toBe(true);
		expect(isUnder(env.XDG_CACHE_HOME ?? null, probeHome)).toBe(true);
	});

	it("shared builder: a child spawned with its output has HOME and XDG under the home it was given", async () => {
		// Dynamic import: before the builder exists this case reds with a
		// module-not-found, distinct from the member cases' defect reds.
		const { scratchHomeEnv } =
			await import("../../scripts/lib/scratch-home-env.mjs");
		const home = path.join(scratch, "home");
		const report = childReport(scratchHomeEnv(home));
		expect(report.HOME).toBe(home);
		expect(report.USERPROFILE).toBe(home);
		for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
			expect(isUnder(report[key], home), `${key} = ${report[key]}`).toBe(true);
		}
	});
});

describe("#4789 withScratchHome pins the whole home set and restores each prior value", () => {
	// Recurrence: withScratchHome pinned PI_LENS_HOME alone and its restore only
	// deleted that key, so a child spawned under the fixture pin read the real
	// HOME and XDG dirs (the #4789 class), and a restore that deleted HOME would
	// leave the process without the home it started with.
	const KEYS = [
		"HOME",
		"USERPROFILE",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"PI_LENS_HOME",
	] as const;

	it("pins HOME and the XDG dirs under the claimed dir, and restore puts back what each key held", async () => {
		const { withScratchHome } =
			await import("../../scripts/lib/lsp-fixture-workspace.mjs");
		const prior = Object.fromEntries(
			KEYS.map((key) => [key, process.env[key]]),
		);
		// withScratchHome returns early when PI_LENS_HOME is already set (the
		// vitest worker sets it), so unset it for this case and put it back.
		delete process.env.PI_LENS_HOME;
		try {
			const { dir, pinned, restore } = withScratchHome({
				tmpPrefix: "pi-lens-scratch-home-env-",
			});
			try {
				expect(pinned).toBe(true);
				expect(process.env.HOME).toBe(dir);
				expect(process.env.USERPROFILE).toBe(dir);
				expect(process.env.XDG_CACHE_HOME).toBe(
					path.join(String(dir), ".cache"),
				);
				expect(process.env.PI_LENS_HOME).toBe(dir);
				restore();
				for (const key of KEYS) {
					if (key === "PI_LENS_HOME") continue;
					expect(process.env[key], `${key} after restore`).toBe(prior[key]);
				}
				expect(process.env.PI_LENS_HOME).toBeUndefined();
			} finally {
				fs.rmSync(String(dir), { recursive: true, force: true });
			}
		} finally {
			for (const key of KEYS) {
				if (prior[key] === undefined) delete process.env[key];
				else process.env[key] = prior[key];
			}
		}
	});
});
