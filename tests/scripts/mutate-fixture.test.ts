// flake-shape: never-settling-wait — the interrupt witness must keep a real child alive until the CLI sends SIGINT.
// flake-shape: real-process-spawn — the killed-runner witness must end its own vitest launcher from outside the worker, and the kill guard refuses process.kill on a pid the file does not own.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { expect, it } from "vitest";

const mutationSafeMarker = true;
// Lexer fixtures for the mutate.test.ts matcher cases (#4048 round 3): a needle
// inside a regex literal or a template's text is not code; the same text inside
// a template substitution, across a division, or after a regex literal holding
// a quote (last in this file) is.
const mutationRegexLiteral = /mutation-regex-only-marker\s+x/;
const mutationQuotient = 8 / 2 / 2;
const mutationTemplate = `mutation-template-only-marker ${mutationQuotient + 1}`;

it("mutation fixture remains original", () => {
	// mutation-comment-only-marker
	expect(mutationSafeMarker).toBe(true);
	expect("original").toBe("original");
	expect([mutationRegexLiteral, mutationTemplate]).toHaveLength(2);
});

it("mutation fixture has a failure marker", () => {
	expect("mutation-fail-marker").toBe("mutation-fail-marker");
});

it("mutation fixture can hold an interrupting run", async () => {
	// A legitimate edit made while a mutation run is live: the run's own
	// cleanup must refuse to overwrite it (#4048 round 3, table row 12).
	if (process.env.PI_LENS_MUTATION_EDIT) {
		appendFileSync(process.env.PI_LENS_MUTATION_EDIT, "legitimate edit\n");
		expect(true).toBe(true);
		return;
	}
	if (process.env.PI_LENS_MUTATION_KILL_RUNNER) {
		// #4510: vitest killed from outside after it printed a passing summary,
		// written to fd 1 because the reporter would buffer a console.log.
		writeSync(1, "\nTests  1 passed (1)\n");
		const flushed = Date.now() + 1500;
		while (Date.now() < flushed);
		// The kill guard refuses process.kill on a pid this file does not own.
		execFileSync("kill", ["-KILL", String(process.ppid)]);
		const held = Date.now() + 30_000;
		while (Date.now() < held);
	}
	if (!process.env.PI_LENS_MUTATION_RUN) {
		expect(true).toBe(true);
		return;
	}
	// #4510: lets the CLI test check that this worker dies with the run.
	if (process.env.PI_LENS_MUTATION_PIDFILE) {
		writeFileSync(process.env.PI_LENS_MUTATION_PIDFILE, String(process.pid));
		// A synchronous spin, as in the orphan this models: vitest's 5 s test
		// timeout cannot fire. Bounded, so a worker the run failed to kill still
		// ends by itself.
		const end = Date.now() + 30_000;
		while (Date.now() < end);
		return;
	}
	await new Promise(() => {});
});

// Kept last: a scanner that reads the quote inside this regex literal as a
// string start desyncs from here to the end of the file, and must not take the
// tests above with it (#4048 round 3).
const mutationQuoteRegex = /https?:\/\/x"/;
const mutationAfterRegex = true;

it("mutation fixture lexer constants remain original", () => {
	expect([mutationQuoteRegex, mutationAfterRegex]).toHaveLength(2);
});
