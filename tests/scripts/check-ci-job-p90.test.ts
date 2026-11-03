// flake-shape: real-process-spawn — the nightly CLI is the subject: it must run as a real
// child process with PATH pointing at a gh stand-in, which no in-process mock reproduces (#4691).
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// #4691: the nightly CLI, run as a child process. The only stand-in is the `gh`
// binary (a process boundary): PATH points at a wrapper that serves the recorded
// master runs. Recurrence guarded: a `%` in a workflow annotation is read as an
// escape, so an unescaped percentage in a warning line corrupts it.
const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = resolve(ROOT, "scripts/check-ci-job-p90.mjs");
const FAKE_GH = resolve(ROOT, "tests/fixtures/ci-job-p90/fake-gh.mjs");
const RECORDED = resolve(ROOT, "tests/fixtures/ci-job-p90/master-runs.json");

describe.skipIf(process.platform === "win32")(
	"nightly CLI scripts/check-ci-job-p90.mjs (#4691)",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-p90-gh-"));
		const wrapper = join(dir, "gh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		afterAll(() => rmSync(dir, { recursive: true, force: true }));

		function run(args: string[], fixturePath: string) {
			return spawnSync(process.execPath, [CLI, ...args], {
				cwd: ROOT,
				encoding: "utf8",
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					FAKE_GH_FIXTURE: fixturePath,
					GH_REPO: "owner/repo",
				},
			});
		}

		it("measures every required context: warns on TLA+ models and Unit tests Windows, and names the one it could not measure", () => {
			// Recurrence: the first cut measured the constant fallback list (2 of the 9
			// branch-protection contexts), so TLA+ models (the issue's motivating
			// job) and Unit tests Windows (1500 s of a 1500 s cap) were silent (#4691
			// F2). The fixture records no Install test (macos-latest) row.
			const result = run(["--runs", "20"], RECORDED);
			expect(result.status).toBe(0);
			const warnings = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("::warning title=CI job p90 near"));
			expect(warnings).toHaveLength(3);
			expect(warnings.join("\n")).toContain('"Lint & type-check"');
			expect(warnings.join("\n")).toContain("75.0%25 of its 600 s cap");
			expect(warnings.join("\n")).toContain('"Unit tests Windows"');
			expect(warnings.join("\n")).toContain("100.0%25 of its 1500 s cap");
			expect(warnings.join("\n")).toContain('"TLA+ models (shard 2/4)"');
			const unmeasured = result.stdout
				.split("\n")
				.filter((line) =>
					line.startsWith("::warning title=CI job p90 unmeasured"),
				);
			expect(unmeasured).toHaveLength(1);
			expect(unmeasured[0]).toContain(
				'unmeasured required context "Install test (macos-latest)"',
			);
			expect(result.stdout).toContain(
				"ci-job-p90: 8 of 9 required contexts measured",
			);
		});

		it("reads the required set from the branch object when the protection endpoint is forbidden to the Actions token", () => {
			// Recurrence: dispatch run 40136156459 of round 2 (HTTP 403 on
			// branches/master/protection) measured the fallback pair, so the nightly
			// still skipped 7 of the 9 required contexts in production.
			const forbidden = join(dir, "forbidden.json");
			writeFileSync(
				forbidden,
				JSON.stringify({
					...JSON.parse(readFileSync(RECORDED, "utf8")),
					protectionForbidden: true,
				}),
			);
			const result = run(["--runs", "20"], forbidden);
			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain("branch protection unreadable");
			expect(result.stdout).toContain(
				"ci-job-p90: 8 of 9 required contexts measured",
			);
		});

		it("falls back to the constant required list and says so when branch protection is unreadable", () => {
			// Recurrence: a silent fallback reads as a clean population (AGENTS shape 10).
			const unreadable = join(dir, "unprotected.json");
			writeFileSync(
				unreadable,
				JSON.stringify({
					...JSON.parse(readFileSync(RECORDED, "utf8")),
					required: null,
				}),
			);
			const result = run(["--runs", "20"], unreadable);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"ci-job-p90: branch protection unreadable; measuring the fallback required list",
			);
		});

		// Recurrence prevented: only the lower bound was probed, so dropping the
		// `runs > MAX_RUNS` clause (an unbounded `gh api` fan-out from one typo)
		// or moving either edge by one passed.
		it.each(["0", "101", "1.5", "abc"])(
			"refuses --runs %s with exit 1",
			(value) => {
				const result = run(["--runs", value], RECORDED);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("--runs must be an integer 1..100");
			},
		);

		it.each(["1", "100"])("accepts --runs %s, the edge of 1..100", (value) => {
			const result = run(["--runs", value], RECORDED);
			expect(result.status).toBe(0);
			expect(result.stderr).not.toContain("--runs must be");
		});

		it("exits 1 and names the failed read when gh cannot read the runs", () => {
			const failing = join(dir, "failing.json");
			writeFileSync(failing, JSON.stringify({ failRead: true, runs: [] }));
			const result = run(["--runs", "20"], failing);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("gh api");
			expect(result.stderr).toContain("failed (exit 1)");
		});
	},
);
