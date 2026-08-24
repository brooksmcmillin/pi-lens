/**
 * Test the playground-verifier pipeline end-to-end. The verifier spins up
 * a headless Chrome, navigates to https://ast-grep.github.io/playground.html
 * with the rule YAML encoded in the URL hash, then scrapes the "Found N
 * match(es)" / "No match found" text. This test asserts the pipeline runs
 * without error and produces a non-error result for a known-good rule.
 *
 * Skipped when:
 *   - Google Chrome is not on PATH (and PILENS_PLAYGROUND_CHROME is unset)
 *   - the playground URL can't be reached (offline / firewalled CI)
 *
 * Slow path (~15s per rule): the playground is a Docusaurus + VitePress SPA
 * with heavy JS bundles; first-load is the dominant cost. Don't enable this
 * in the default `npm test` run; it's opt-in for local dev / nightly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeSpawnAsync } from "../../../../clients/safe-spawn.js";

const SCRIPT = join(process.cwd(), "scripts", "playground-verify-rule.mjs");
const CHROME_CANDIDATES: string[] = [
	process.env.PILENS_PLAYGROUND_CHROME,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter((p): p is string => Boolean(p));

function chromeAvailable(): boolean {
	return CHROME_CANDIDATES.some((p) => existsSync(p));
}

const RULES_DIR = join(process.cwd(), "rules", "ast-grep-rules", "rules");

interface VerifyResult {
	ok: boolean;
	rule_id?: string;
	matches?: number;
	lines?: number[];
	fix?: string | null;
	error?: string;
	engine_ms?: number;
}

// #902: was a hand-rolled `spawn(process.execPath, ...)` promise wrapper.
// `safeSpawnAsync` (shared with production, `clients/safe-spawn.ts`) already
// does timeout+kill, stdout/stderr accumulation, and spawn-error surfacing —
// reusing it here instead of a second, hand-rolled spawn strategy (single
// source of truth, #883). Behavior preserved: a spawn error or timeout still
// rejects (via `result.error`), and a non-JSON stdout tail still rejects with
// the same diagnostic message shape.
async function runVerify(
	ruleFile: string,
	args: string[] = [],
	timeoutMs = 60_000,
): Promise<VerifyResult> {
	const result = await safeSpawnAsync(
		process.execPath,
		[SCRIPT, ruleFile, ...args],
		{
			timeout: timeoutMs,
		},
	);
	if (result.error) throw result.error;
	// Result is always on stdout (JSON) — stderr is diagnostic noise.
	const last = result.stdout.trim().split("\n").pop() || "";
	try {
		return JSON.parse(last);
	} catch {
		throw new Error(
			`failed to parse result (exit ${result.status}): stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`,
		);
	}
}

const skip = !chromeAvailable()
	? "Google Chrome not on PATH (set PILENS_PLAYGROUND_CHROME)"
	: false;

(skip ? describe.skip : describe)(
	"playground-verify-rule.mjs (headless CDP)",
	() => {
		it("smoke: loads the playground and reports a known-good rule's match count", async () => {
			// no-console-except-error fires on the playground's default source
			// (which contains 3 console.log/debug calls). 0 matches would mean
			// the playground didn't actually load the rule's config.
			const result = await runVerify(
				join(RULES_DIR, "no-console-except-error.yml"),
				["--code", "ignored", "--keep-chrome", "--timeout", "30000"],
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.rule_id).toBe("no-console-except-error");
			expect(result.matches).toBeGreaterThan(0);
		}, 60_000);

		it("rule with no playground default-source match reports 0 (not an error)", async () => {
			// jsx-boolean-short-circuit requires `cond.length && jsx` — the
			// playground's default source has no JSX, so 0 matches is the
			// correct answer. If we got an error here, the playground
			// would have failed to load the rule.
			const result = await runVerify(
				join(RULES_DIR, "jsx-boolean-short-circuit.yml"),
				["--code", "ignored", "--keep-chrome", "--timeout", "30000"],
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.rule_id).toBe("jsx-boolean-short-circuit");
			expect(result.matches).toBe(0);
			expect(result.fix).toBe("{$COND ? $JSX : null}");
		}, 60_000);
	},
);
