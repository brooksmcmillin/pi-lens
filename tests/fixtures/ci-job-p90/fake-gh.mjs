#!/usr/bin/env node
// A `gh` stand-in for tests/scripts/check-ci-job-p90.test.ts (#4691). It is a
// process boundary, not a mock of the check: it serves the recorded master runs
// of ci.yml and lint.yml, the job rows of a run, and the branch-protection
// contexts in FAKE_GH_FIXTURE, in the shapes scripts/check-ci-job-p90.mjs reads.
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const args = process.argv.slice(2).join(" ");

if (fixture.failRead) {
	console.error("HTTP 500: recorded failure");
	process.exit(1);
}
// The branch-protection endpoint needs administration; the Actions token has
// none (run 40136156459: HTTP 403), so `protectionForbidden` models it. The
// branch object lists the same contexts to any reader.
if (/branches\/master\/protection/.test(args)) {
	if (!fixture.required || fixture.protectionForbidden) {
		console.error("HTTP 403: Resource not accessible by integration");
		process.exit(1);
	}
	console.log(
		JSON.stringify({
			required_status_checks: {
				checks: fixture.required.map((context) => ({ context })),
			},
		}),
	);
	process.exit(0);
}
if (args.endsWith("branches/master")) {
	if (!fixture.required) process.exit(1);
	console.log(
		JSON.stringify({
			protection: {
				enabled: true,
				required_status_checks: { contexts: fixture.required },
			},
		}),
	);
	process.exit(0);
}
const listed = /\/actions\/workflows\/(ci|lint)\.yml\/runs/.exec(args);
if (listed) {
	const count = Number(/per_page=(\d+)/.exec(args)?.[1] ?? 20);
	const workflow_runs = (listed[1] === "ci" ? fixture.runs : fixture.lintRuns)
		.slice(0, count)
		.map((run) => ({ id: run.id, created_at: run.created_at }));
	console.log(JSON.stringify({ workflow_runs }));
	process.exit(0);
}
const jobs = /actions\/runs\/(\d+)\/jobs/.exec(args);
if (jobs) {
	const run = [...fixture.runs, ...(fixture.lintRuns ?? [])].find(
		(r) => String(r.id) === jobs[1],
	);
	for (const job of run?.jobs ?? []) console.log(JSON.stringify(job));
	process.exit(0);
}
console.error(`fake gh: unrecorded call: ${args}`);
process.exit(2);
