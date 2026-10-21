// flake-shape: real-process-spawn — the subject is the shell text of two install-smoke.yml steps (the pipefail pipe into tee, and the failing-row report); only a real bash running the extracted `run:` can show that a red handshake exits non-zero or that a crash writes a crash line. The one stand-in is a fake `node` on PATH at the process boundary; the shell, tee, grep and sed are the real ones.
// lane: wall-clock-budget (serialized); no wall-clock assertion, each case is a
// few-millisecond shell run.
/**
 * #4291 review F2/F3. The first pins were string checks: a `set -o pipefail`
 * or a `grep '^✗'` inside a shell comment satisfied them, and a planted drift
 * stayed green. These run the real step text under GitHub's default shell
 * (`bash -e`, no pipefail) against fixture logs.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

type Step = { id?: string; name?: string; run?: string };
const ROOT = path.resolve(import.meta.dirname, "../..");
const doc = yaml.load(
	fs.readFileSync(
		path.join(ROOT, ".github/workflows/install-smoke.yml"),
		"utf8",
	),
) as { jobs: Record<string, { steps: Step[] }> };
const steps = doc.jobs["lsp-handshake"].steps;
const handshakeRun = steps.find((step) => step.id === "handshake")?.run ?? "";
const reportRun =
	steps.find((step) => /failing handshake rows/i.test(step.name ?? ""))?.run ??
	"";

const tmpRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-handshake-steps-"),
);
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;

function bash(script: string, env: Record<string, string>, cwd: string) {
	const file = path.join(cwd, "step.sh");
	fs.writeFileSync(file, script);
	// GitHub's shell for a `run:` with no `shell:` key is `bash -e {0}`.
	return spawnSync("bash", ["-e", file], {
		cwd,
		env: { PATH: process.env.PATH ?? "", ...env },
		encoding: "utf8",
	});
}

function report(outcome: string, log: string | null) {
	const dir = path.join(tmpRoot, `report-${counter++}`);
	fs.mkdirSync(dir);
	if (log !== null) fs.writeFileSync(path.join(dir, "lsp-handshake.log"), log);
	const summary = path.join(dir, "summary.md");
	fs.writeFileSync(summary, "");
	const result = bash(
		reportRun,
		{
			HANDSHAKE_OUTCOME: outcome,
			RUNNER_TEMP: dir,
			GITHUB_STEP_SUMMARY: summary,
		},
		dir,
	);
	return {
		status: result.status,
		stdout: result.stdout,
		summary: fs.readFileSync(summary, "utf8"),
	};
}

const ROW =
	"✗  elixir       elixir-ls                    0     setup failed (spawnSync mix ENOENT): mix compile";
const PASS_LINE = "40 passed · 1 failed · 0 setup-failed · 13 skipped";

describe("install-smoke.yml 'Report failing handshake rows' step, executed (#4291)", () => {
	// Recurrence: a red row only in a log nobody opens.
	it("writes a failing row to the summary and as a warning annotation", () => {
		const result = report(
			"failure",
			`✓  ts  typescript  10  ok\n${ROW}\n${PASS_LINE}\n`,
		);
		expect(result.status).toBe(0);
		expect(result.summary).toContain(ROW);
		expect(result.summary).not.toContain("No failing rows.");
		expect(result.stdout).toContain(`::warning title=LSP handshake::${ROW}`);
	});

	// Recurrence: a clean run annotating or failing.
	it("says so and annotates nothing for a clean run", () => {
		const result = report(
			"success",
			"✓  ts  typescript  10  ok\n40 passed · 0 failed\n",
		);
		expect(result.status).toBe(0);
		expect(result.summary).toContain("No failing rows.");
		expect(result.stdout).not.toContain("::warning");
	});

	// Recurrence (#4291 review F2): a smoke-tools crash with no rows (a missing
	// dist, exit 2) wrote "No failing rows." and no annotation, so a run that
	// never ran read as a clean one.
	it.each([
		["failure", "Error: dist/clients/lsp/index.js not found\n"],
		["failure", null],
		["skipped", null],
		["cancelled", null],
	])(
		"reports that the handshake did not run for outcome %s with log %j",
		(outcome, log) => {
			const result = report(outcome, log);
			expect(result.status).toBe(0);
			expect(result.summary).not.toContain("No failing rows.");
			expect(result.summary).toContain("did not run to a result");
			expect(result.summary).toContain(outcome);
			expect(result.stdout).toContain("::warning title=LSP handshake::");
		},
	);
});

describe("install-smoke.yml handshake step, executed (#4291)", () => {
	function handshake(fakeNodeBody: string) {
		const dir = path.join(tmpRoot, `handshake-${counter++}`);
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const fakeNode = path.join(bin, "node");
		fs.writeFileSync(fakeNode, `#!/bin/sh\n${fakeNodeBody}\n`, { mode: 0o755 });
		const result = bash(
			handshakeRun,
			{ PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: dir },
			dir,
		);
		return {
			status: result.status,
			log: fs.readFileSync(path.join(dir, "lsp-handshake.log"), "utf8"),
		};
	}

	// Recurrence (#2723): without pipefail `cmd | tee` takes tee's exit code, so
	// a red layer reported success and the report step saw outcome `success`.
	it("fails when smoke-tools fails, and keeps the log", () => {
		const result = handshake(`echo '${ROW}'\nexit 1`);
		expect(result.status).not.toBe(0);
		expect(result.log).toContain(ROW);
	});

	it("succeeds when smoke-tools succeeds", () => {
		expect(handshake("echo ok\nexit 0").status).toBe(0);
	});
});
