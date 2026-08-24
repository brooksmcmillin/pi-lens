#!/usr/bin/env node
/**
 * playground-verify-rule.mjs — cross-validate an ast-grep rule against the
 * official upstream playground at https://ast-grep.github.io/playground.html.
 *
 * This is a SECOND OPINION against the local CLI test
 * (ast-grep scan -r <rule> <file>). If both produce the same match count on
 * a fixture, we know the rule is consistent across local + upstream
 * ast-grep versions. Useful for catching:
 *   - rule behavior that diverges between versions
 *   - matches that the local CLI misses (or finds spuriously)
 *
 * Architecture:
 *   scripts/playground-chrome.mjs  — dedicated headless Chrome (port 9224,
 *                                   isolated profile, kill-on-exit)
 *   scripts/playground-cdp.mjs     — minimal CDP driver (list, nav, eval)
 *   scripts/playground-verify-rule.mjs  (this file)
 *     1. ensure Chrome is running (auto-launch if not)
 *     2. open a fresh page on the playground URL with the rule + code
 *        encoded in the URL hash (matches the catalog "Try in Playground"
 *        link format)
 *     3. poll page.innerText for "Found N match(es)" + extract line numbers
 *     4. emit JSON to stdout, clean up
 *
 * Usage:
 *   node scripts/playground-verify-rule.mjs <rule.yml> [options]
 *   echo "<code>" | node scripts/playground-verify-rule.mjs <rule.yml> -
 *
 * Options:
 *   --code <text>        Source code to match (inline)
 *   --code-file <path>   Source code to match (file)
 *   -                    Read source code from stdin
 *   --lang <L>           Override language (otherwise read from YAML)
 *   --expected <N>       Assert the match count is exactly N
 *   --timeout <ms>       Page load + config parse timeout (default 30000)
 *   --keep-chrome        Don't kill Chrome on exit (for debugging)
 *
 * Output (JSON to stdout):
 *   { ok, rule_id, language, matches, lines, fix, engine_ms, error? }
 *
 * Exit codes:
 *   0  = matches match --expected (or no expectation set)
 *   1  = matches differ from --expected
 *   2  = setup error
 *   3  = engine / page error
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { safeSpawnAsync } from "../clients/safe-spawn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use os.tmpdir() — the TMP/TEMP env vars differ across shells
// (C:\WINDOWS\TEMP in cmd.exe, C:\Users\…\AppData\Local\Temp in
// PowerShell and Node's os.tmpdir()). The launch script always
// uses os.tmpdir(), so the reuse check must too — otherwise the
// script silently relaunches Chrome every time and adds ~15s.
const PROFILE_DIR = join(tmpdir(), "pilens-playground-profile");
const PORT_FILE = join(PROFILE_DIR, "DevToolsActivePort");

// Map our pascal/short language names to the playground's expected values.
const LANG_ALIASES = {
	TypeScript: "typescript",
	Tsx: "tsx",
	JavaScript: "javascript",
	Python: "python",
	Go: "go",
	Rust: "rust",
	Java: "java",
	CSharp: "csharp",
	C: "c",
	Cpp: "cpp",
	Kotlin: "kotlin",
	Ruby: "ruby",
};

const DEFAULT_TIMEOUT_MS = 30_000;
// Bounded wait for the helper child processes (playground-cdp.mjs /
// playground-chrome.mjs) themselves — separate from DEFAULT_TIMEOUT_MS,
// which bounds the in-page playground poll. Each CDP call already
// self-bounds around 30-40s internally (playground-cdp.mjs's own
// per-message TIMEOUT_MS + nav's 10s hard cap), so 45s here is headroom
// for a wedged/daemonized child that never emits 'close' at all — the
// #1679 hang this constant exists to bound.
const CHILD_SPAWN_TIMEOUT_MS = 45_000;
const PORT = Number(process.env.PILENS_PLAYGROUND_PORT) || 9224;
const CHROME_SCRIPT = join(__dirname, "playground-chrome.mjs");
const CDP_SCRIPT = join(__dirname, "playground-cdp.mjs");
const PLAYGROUND_URL = "https://ast-grep.github.io/playground.html";

// ── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const args = argv.slice(2);
	if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
		printUsage();
		process.exit(0);
	}
	const opts = {
		ruleFile: null,
		code: null,
		codeFile: null,
		stdin: false,
		lang: null,
		expected: null,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		keepChrome: Boolean(process.env.PILENS_PLAYGROUND_KEEP),
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--code") opts.code = args[++i];
		else if (a === "--code-file") opts.codeFile = args[++i];
		else if (a === "--lang") opts.lang = args[++i];
		else if (a === "--expected") opts.expected = parseInt(args[++i], 10);
		else if (a === "--timeout") opts.timeoutMs = parseInt(args[++i], 10);
		else if (a === "--keep-chrome") opts.keepChrome = true;
		else if (a === "-") opts.stdin = true;
		else if (!opts.ruleFile) opts.ruleFile = a;
		else throw new Error(`unexpected arg: ${a}`);
	}
	if (!opts.ruleFile) throw new Error("rule YAML path required");
	return opts;
}

function printUsage() {
	console.log(`playground-verify-rule.mjs — cross-validate an ast-grep rule against the
official upstream playground.

Usage:
  node scripts/playground-verify-rule.mjs <rule.yml> [options]

Options:
  --code <text>        Source code to match (inline)
  --code-file <path>   Source code to match (file)
  -                    Read source code from stdin
  --lang <L>           Override the rule's language (otherwise read from YAML)
  --expected <N>       Assert the match count is exactly N
  --timeout <ms>       Page load + config parse timeout (default 30000)
  --keep-chrome        Don't kill Chrome on exit (for debugging)

Output: JSON to stdout with { ok, matches, lines, fix, engine_ms, error? }.
Exit:   0 = match (or no expectation set), 1 = mismatch, 2 = setup, 3 = engine.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function readStdin() {
	return new Promise((resolve) => {
		// Bail immediately if stdin isn't piped/redirected — otherwise
		// we'd wait forever and Node would keep the event loop alive
		// past the result.
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (buf += c));
		process.stdin.on("end", () => resolve(buf));
		// Safety net: if no data arrives within 1s, assume the pipe
		// is empty and resolve.
		setTimeout(() => resolve(buf), 1000);
	});
}

// #1679: was a hand-rolled `spawn(...)` + `proc.on("close", ...)` wait with
// NO timeout — a wedged/daemonized child (e.g. Chrome/CDP left in a state
// that never emits 'close') hung this script forever. safeSpawnAsync
// (shared with production, clients/safe-spawn.ts) already does bounded
// timeout+kill, stdout/stderr accumulation, and spawn-error surfacing —
// reusing it here instead of a second, hand-rolled wait (single source of
// truth, #883).
//
// `scriptPath`/`timeoutMs` are overridable (default to the real CDP/Chrome
// helper scripts and CHILD_SPAWN_TIMEOUT_MS) purely so tests can point at a
// never-closing fixture with a short timeout instead of the real helpers —
// production call sites never pass them.
export async function runCdp(
	args,
	{ scriptPath = CDP_SCRIPT, timeoutMs = CHILD_SPAWN_TIMEOUT_MS } = {},
) {
	const result = await safeSpawnAsync(process.execPath, [scriptPath, ...args], {
		env: { ...process.env, PILENS_PLAYGROUND_PORT: String(PORT) },
		timeout: timeoutMs,
	});
	if (result.status === 0) return result.stdout.trim();
	const detail = result.error
		? result.error.message
		: result.stderr.trim() || result.stdout.trim() || "no output";
	throw new Error(`cdp ${args[0]} failed (exit ${result.status}): ${detail}`);
}

export async function runChrome(
	cmd,
	{ scriptPath = CHROME_SCRIPT, timeoutMs = CHILD_SPAWN_TIMEOUT_MS } = {},
) {
	const result = await safeSpawnAsync(process.execPath, [scriptPath, cmd], {
		env: { ...process.env, PILENS_PLAYGROUND_PORT: String(PORT) },
		timeout: timeoutMs,
	});
	// The original spawn inherited stderr so launch/kill diagnostics streamed
	// live; safeSpawnAsync captures instead, so surface it here on failure.
	if (result.status === 0) return;
	if (result.stderr) process.stderr.write(result.stderr);
	const detail = result.error ? result.error.message : `exit ${result.status}`;
	throw new Error(`chrome ${cmd} failed (${detail})`);
}

async function ensureChrome() {
	const t0 = Date.now();
	if (existsSync(PORT_FILE)) {
		try {
			await runCdp(["list"]);
			process.stderr.write(
				`# [playground] chrome reuse: ${Date.now() - t0}ms\n`,
			);
			return;
		} catch {
			try {
				await runChrome("kill");
			} catch {}
		}
	}
	await runChrome("launch");
	process.stderr.write(`# [playground] chrome launch: ${Date.now() - t0}ms\n`);
}

function buildPlaygroundUrl(ruleYaml, code, lang) {
	const payload = {
		mode: "Config",
		lang,
		query: code,
		rewrite: "",
		config: ruleYaml,
	};
	const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	return `${PLAYGROUND_URL}#${b64}`;
}

// JS expression evaluated in the page to scrape the playground result.
// We don't depend on a specific DOM selector (the playground's React
// internals change between builds); we scan the rendered text.
//
// IMPORTANT: the expression is passed through spawn argv, which on
// Windows strips backslashes. We avoid regex backslash escapes
// entirely — character classes with the raw chars, or split string
// matches, survive the round-trip.
//
// The playground shows one of:
//   "Found N match(es)."        — the rule fired N times against the
//                                  default source (the playground uses a
//                                  hardcoded source; user code via the URL
//                                  hash is ignored in Config mode)
//   "No match found."           — the rule did not fire (0 matches)
//   an error message             — the rule's YAML/pattern was rejected
function buildScrapeExpr() {
	return `(() => {
		const text = document.body.innerText || "";
		const m = text.match(/Found[ \\t]+(\\d+)[ \\t]+match/i);
		if (m) {
			const count = parseInt(m[1], 10);
			const lines = Array.from(document.querySelectorAll("*"))
				.map((el) => (el.textContent || "").trim())
				.filter((t) => /^[0-9]+$/.test(t))
				.map((t) => parseInt(t, 10))
				.filter((n) => n >= 1 && n <= count)
				.filter((n, i, a) => a.indexOf(n) === i)
				.sort((a, b) => a - b);
			return { found: true, count, lines };
		}
		if (/no[ \\t]+match[ \\t]+found/i.test(text)) {
			return { found: true, count: 0, lines: [] };
		}
		return { found: false, text: text.slice(0, 800) };
	})()`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
	const opts = parseArgs(process.argv);
	const startMs = Date.now();

	// 1) Read rule
	const rulePath = resolve(opts.ruleFile);
	if (!existsSync(rulePath)) {
		console.error(
			JSON.stringify({ ok: false, error: `rule not found: ${rulePath}` }),
		);
		process.exit(2);
	}
	const ruleYaml = readFileSync(rulePath, "utf-8");
	let rule;
	try {
		rule = yamlLoad(ruleYaml);
	} catch (e) {
		console.error(
			JSON.stringify({ ok: false, error: `invalid YAML: ${e.message}` }),
		);
		process.exit(2);
	}
	if (!rule || typeof rule !== "object" || !rule.id) {
		console.error(
			JSON.stringify({ ok: false, error: "rule YAML missing 'id'" }),
		);
		process.exit(2);
	}
	const lang = opts.lang || rule.language || "TypeScript";
	const playLang = LANG_ALIASES[lang] || lang.toLowerCase();

	// 2) Read source code
	let code = "";
	if (opts.code !== null) code = opts.code;
	else if (opts.codeFile) {
		const p = resolve(opts.codeFile);
		if (!existsSync(p)) {
			console.error(
				JSON.stringify({ ok: false, error: `code file not found: ${p}` }),
			);
			process.exit(2);
		}
		code = readFileSync(p, "utf-8");
	} else if (opts.stdin) code = await readStdin();
	if (!code.length) {
		console.error(
			JSON.stringify({
				ok: false,
				error: "no source code (use --code, --code-file, or -)",
			}),
		);
		process.exit(2);
	}

	// 3) Ensure Chrome is running
	try {
		await ensureChrome();
	} catch (e) {
		console.error(JSON.stringify({ ok: false, error: `chrome: ${e.message}` }));
		process.exit(2);
	}

	// 4) Open a new page + navigate to the playground
	const log = (m) => process.stderr.write(`# [playground] ${m}\n`);
	let targetId;
	try {
		const url = buildPlaygroundUrl(ruleYaml, code, playLang);
		log(`url length: ${url.length}`);
		// Create an about:blank page, then nav it to the playground.
		// `newpage` returns the targetId; the follow-up `nav` blocks
		// until Page.loadEventFired, so the React app has parsed
		// the config from the URL hash by the time we poll.
		const newOut = await runCdp(["newpage"]);
		const { targetId: tid } = JSON.parse(newOut);
		targetId = tid;
		log(`targetId: ${tid}`);
		await runCdp(["nav", targetId, url]);
		// 5) Poll for the "Found N match(es)" line (or "No match found").
		const deadline = Date.now() + opts.timeoutMs;
		let scrape = null;
		let polls = 0;
		while (Date.now() < deadline) {
			polls++;
			const out = await runCdp(["eval", targetId, buildScrapeExpr()]);
			try {
				scrape = JSON.parse(out);
			} catch {
				scrape = null;
			}
			if (scrape?.found) break;
			if (polls % 10 === 0) log(`poll #${polls}: still waiting…`);
			await new Promise((r) => setTimeout(r, 250));
		}
		log(`polls done: ${polls}, scrape=${JSON.stringify(scrape)}`);
		if (!scrape?.found) {
			const result = {
				ok: false,
				rule_id: rule.id,
				error: "playground did not render 'Found N match(es)' within timeout",
				debug_text: scrape?.text || null,
				engine_ms: Date.now() - startMs,
			};
			console.error(JSON.stringify(result));
			process.exit(3);
		}
		const result = {
			ok: true,
			rule_id: rule.id,
			language: playLang,
			matches: scrape.count,
			lines: scrape.lines,
			fix: rule.fix || null,
			engine_ms: Date.now() - startMs,
		};
		if (opts.expected !== null && opts.expected !== scrape.count) {
			result.ok = false;
			result.expected = opts.expected;
			console.error(JSON.stringify(result));
			process.exit(1);
		}
		console.log(JSON.stringify(result));
	} catch (e) {
		console.error(JSON.stringify({ ok: false, error: `engine: ${e.message}` }));
		process.exit(3);
	} finally {
		// Chrome cleanup is the only thing that needs to finish before
		// the script exits — a leftover headless Chrome would block the
		// next invocation's launch. Await the kill synchronously when
		// --keep-chrome is not set. Timeout the kill in case Chrome
		// itself hangs (the spawn is detached; the worst case is a
		// slow taskkill).
		if (!opts.keepChrome) {
			const killStart = Date.now();
			await Promise.race([
				runChrome("kill"),
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error("kill timeout")), 10_000),
				),
			]).catch((e) =>
				process.stderr.write(`# [playground] kill warning: ${e.message}\n`),
			);
			process.stderr.write(
				`# [playground] killed in ${Date.now() - killStart}ms\n`,
			);
		} else {
			console.error(`# playground Chrome left running on port ${PORT}`);
		}
	}
}

// #1679: only run the CLI when this file is executed directly (`node
// scripts/playground-verify-rule.mjs ...`), not when it's imported as a
// module — tests import `runCdp`/`runChrome` directly to exercise the
// bounded-wait fix without also parsing CLI args / spawning Chrome / calling
// process.exit as a side effect of the import.
const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().then(
		() => process.exit(0),
		(e) => {
			console.error(JSON.stringify({ ok: false, error: e.message }));
			process.exit(2);
		},
	);
}
