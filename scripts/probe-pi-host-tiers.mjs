#!/usr/bin/env node
/**
 * Probe the two real pi tiers against every CERTIFIED pi host (#4632
 * acceptance 9: "any host claim names the host it ran on").
 *
 * WHAT IT IS. A manual/nightly spread, NOT a per-PR gate. The per-PR tiers run
 * on the one host this repo's `devDependencies` pins
 * (`@earendil-works/pi-coding-agent`); this script answers the other question
 * a host claim raises — do the same two tiers still work on the older hosts the
 * release-QA matrix certified? It runs tier 1 (`tests/support/pi-runner.test.ts`,
 * a real `ExtensionRunner`) and tier 2 (`tests/support/pi-session.test.ts`, a
 * real `AgentSession` with a scripted provider) against ONE installed host at a
 * time through `PI_LENS_PI_HOST_PACKAGE`, the override both tier helpers
 * already honor, and prints one line per certified host naming that host and
 * the version it ran on.
 *
 * THE CERTIFIED LIST comes from `docs/release-qa-baseline.md`'s `### Verified
 * hosts` table through `scripts/lib/pi-host-spread.mjs`, the same parser
 * `tests/packaging.test.ts` holds the packaging ratchet to. Nothing is
 * installed here: a certified host that is not on this machine is reported as
 * `not installed`, and that is only an error with `--require-all`. An install
 * whose version the certified set does not name is NAMED in a warning and not
 * probed, because a host the reader silently skipped reads as "not installed"
 * (#4719 F3).
 *
 * PREREQUISITE: `npm run build`. The tiers load the BUILT extension
 * (`index.js`), so a missing build refuses the run instead of probing every
 * host with the same stale extension.
 *
 * WHERE HOSTS ARE FOUND. `--host-root` names an install in any of the shapes
 * `hostPackageCandidates` reads: the package directory itself, a
 * `node_modules` root or other prefix holding it, the orchestrator's versioned
 * `<dir>/pi-<version>` prefix, or an npm global prefix. Without the flag the
 * repo's own `node_modules` is probed, plus every entry of
 * `PI_LENS_PI_HOST_ROOTS` (`path.delimiter`-separated).
 *
 * USAGE
 *   node scripts/probe-pi-host-tiers.mjs [options]
 *     --host-root <dir>   an install to probe (repeatable)
 *     --require-all       exit 3 when a certified host is not installed
 *     --timeout-ms <n>    per-tier child timeout (default 300000)
 *     --help              print this usage
 *
 * EXIT CODES
 *   0  every installed certified host passed its tiers (missing hosts allowed)
 *   1  an installed host failed a tier
 *   2  usage error, an unreadable certified-host table, or a missing build
 *   3  `--require-all` and a certified host is not installed
 *
 * Node only, no new dependency. Every spawn is shell-free (an argv array) and
 * the child's whole output is read through `parseVitestSummary`, the one
 * Vitest-transcript reader in this repo (ANSI/CRLF/Actions timestamps stripped
 * in one place; AGENTS.md shape 63).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
	EXIT,
	HOST_PACKAGE,
	certifiedHosts,
	discoverInstalledHosts,
	exitCodeForSpread,
	parseCliArgs,
	renderHostLine,
	renderSpreadSummary,
	runSpread,
	tierVerdict,
} from "./lib/pi-host-spread.mjs";
import {
	normalizeVitestOutput,
	parseVitestSummary,
} from "./lib/vitest-summary.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const BASELINE_DOC = path.join(REPO_ROOT, "docs", "release-qa-baseline.md");
/** The built extension both tiers load: `npm run build` writes it. */
const EXTENSION_ENTRY = path.join(REPO_ROOT, "index.js");
/** Vitest's own ESM entry: no `.bin` shim, no shell on Windows. */
const VITEST_ENTRY = path.join(
	REPO_ROOT,
	"node_modules",
	"vitest",
	"vitest.mjs",
);

const USAGE = [
	"usage: node scripts/probe-pi-host-tiers.mjs [--host-root <dir>]... [--require-all] [--timeout-ms <n>]",
	"",
	"Runs tier 1 (tests/support/pi-runner.test.ts) and tier 2",
	"(tests/support/pi-session.test.ts) against every certified pi host that is",
	"installed here, one line per host. Missing hosts are reported, not installed",
	"and are only an error with --require-all. Run `npm run build` first.",
].join("\n");

/** How many transcript lines a failure prints: enough to name the case. */
const FAILURE_LINES = 25;

function hostRootsFromEnv(env) {
	const fromEnv = (env.PI_LENS_PI_HOST_ROOTS ?? "")
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return [path.join(REPO_ROOT, "node_modules"), ...fromEnv];
}

/**
 * One tier's own contract suite against one host, in a child process. The
 * host is named through `PI_LENS_PI_HOST_PACKAGE`, the override both tier
 * helpers read before they load it.
 */
function runTierSuiteInChild({ host, suite, timeoutMs }) {
	const child = spawnSync(process.execPath, [VITEST_ENTRY, "run", suite.file], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		timeout: timeoutMs,
		env: {
			...process.env,
			PI_LENS_PI_HOST_PACKAGE: host.dir,
			// CI and a maintainer's terminal both colourise; the summary reader
			// strips it either way, and this keeps one transcript shape.
			FORCE_COLOR: "0",
		},
	});
	const transcript = normalizeVitestOutput(
		`${child.stdout ?? ""}\n${child.stderr ?? ""}`,
	);
	const summary = parseVitestSummary(transcript);
	const timedOut = child.error?.code === "ETIMEDOUT";
	const verdict = tierVerdict({ status: child.status, timedOut, summary });
	const detail = verdict.ok
		? undefined
		: [
				timedOut
					? `timed out after ${timeoutMs} ms`
					: `exit ${child.status ?? "none"}${child.signal ? ` (signal ${child.signal})` : ""}`,
				...transcript.split("\n").slice(-FAILURE_LINES),
			].join("\n");
	return { ...verdict, detail };
}

/**
 * The CLI's own decisions, with every boundary injected so a case can drive
 * them without spawning: `release-qa.mjs` keeps the same shape (its pure core
 * is exported "so tests/scripts/release-qa.test.ts can hold them without
 * spawning a real pi"). The defaults are the real filesystem, the real child,
 * and the real streams.
 */
export async function main(
	argv,
	{
		baselineDoc = BASELINE_DOC,
		extensionEntry = EXTENSION_ENTRY,
		vitestEntry = VITEST_ENTRY,
		readFile = (file) => fs.readFileSync(file, "utf8"),
		exists = (file) => fs.existsSync(file),
		runTierSuite = (input) => runTierSuiteInChild(input),
		write = (text) => process.stdout.write(text),
		warn = (text) => process.stderr.write(text),
		env = process.env,
	} = {},
) {
	let options;
	try {
		options = parseCliArgs(argv);
	} catch (error) {
		warn(`${error.message}\n\n${USAGE}\n`);
		return EXIT.usage;
	}
	if (options.help) {
		write(`${USAGE}\n`);
		return EXIT.ok;
	}
	if (!exists(extensionEntry)) {
		warn(
			`${extensionEntry} is missing: run \`npm run build\` first, the tiers load the built extension\n`,
		);
		return EXIT.usage;
	}
	if (!exists(vitestEntry)) {
		warn(`${vitestEntry} is missing: install this repo's devDependencies\n`);
		return EXIT.usage;
	}
	const { versions, unparseable, problem } = certifiedHosts(
		readFile(baselineDoc),
	);
	if (problem !== undefined) {
		warn(
			`${baselineDoc} has no readable certified-host table, so the certified set is unreadable: ${problem}\n`,
		);
		return EXIT.usage;
	}
	if (unparseable.length > 0) {
		warn(
			`${baselineDoc} has verified-host row(s) with no \`| x.y.z |\` version, so the certified set is unreadable: ${unparseable.join("; ")}\n`,
		);
		return EXIT.usage;
	}
	if (versions.length === 0) {
		warn(
			`${baselineDoc} names no certified host under \`### Verified hosts\`\n`,
		);
		return EXIT.usage;
	}
	const roots =
		options.hostRoots.length > 0 ? options.hostRoots : hostRootsFromEnv(env);
	const { hosts, unreadable } = discoverInstalledHosts(roots);
	for (const root of unreadable) {
		warn(`warning: ${root} holds no ${HOST_PACKAGE}, so it was skipped\n`);
	}
	// A host that IS installed and that the doc does not certify is named, never
	// dropped: its `1.4.0-rc.1` install would otherwise leave the certified
	// `1.4.0` row reading `not installed` with nothing to explain why (#4719 F3).
	for (const host of hosts) {
		if (!versions.includes(host.version)) {
			warn(
				`warning: ${HOST_PACKAGE} ${host.version} (${host.dir}) is installed but not in the certified set, so it is not probed\n`,
			);
		}
	}
	write(`certified hosts (${baselineDoc}): ${versions.join(", ")}\n`);
	const spread = await runSpread({
		certified: versions,
		hosts,
		runTierSuite: (input) =>
			runTierSuite({ ...input, timeoutMs: options.timeoutMs }),
	});
	for (const row of spread.rows) {
		write(`${renderHostLine(row)}\n`);
		for (const tier of row.tiers.filter((entry) => !entry.ok)) {
			write(
				`---- ${row.version} ${tier.tier}: ${tier.file} ----\n${tier.detail ?? ""}\n`,
			);
		}
	}
	write(`${renderSpreadSummary(spread)}\n`);
	return exitCodeForSpread(spread, { requireAll: options.requireAll });
}

if (isMainModule(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(
				`probe-pi-host-tiers: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
			process.exitCode = EXIT.usage;
		},
	);
}
