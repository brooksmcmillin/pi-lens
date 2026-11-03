// CLI wrapper for the pi-lens self-scan (#1718). Runs the dogfooded
// pi-lens-self-scan rule subset (see scripts/lib/astgrep-self-scan.mjs)
// against clients/ + tests/ and fails when a NEW finding shows up that isn't
// already triaged into rules/ast-grep-rules/self-scan-baseline.json.
//
// Previously this script hardcoded a single author's now-nonexistent machine
// paths (C:/Users/R3LiC/Desktop/pi-lens[-rules2]) as both the scan target and
// the rules source, so it ran nowhere -- not in CI, not on any other
// contributor's machine. It silently printed nothing and exited 0. Fixed by
// deriving every path from this file's own location and the shipped
// rules/ast-grep-rules/.sgconfig.yml.
//
// Usage:
//   node scripts/run-astgrep-pi-lens.mjs                 # scan and report; exit 1 on an untriaged hit (severity: info rules are advisory: printed, never gate)
//   node scripts/run-astgrep-pi-lens.mjs --update-baseline # regenerate the baseline from the current scan
//   node scripts/run-astgrep-pi-lens.mjs --base <ref> | --all-advisory # advisory (severity: info) hits: only files changed against <ref> (CI: GITHUB_BASE_REF), or all
//   node scripts/run-astgrep-pi-lens.mjs <path> [<path> ...] # scan explicit path(s) instead of clients/+tests/
//   node scripts/run-astgrep-pi-lens.mjs --suite governance  # #4865: the governance rules in scripts/governance-rules/ against their own baseline
//
// npm scripts: `npm run astgrep:self-scan` (both suites) /
// `npm run astgrep:self-scan:update-baseline` / `npm run astgrep:governance` /
// `npm run astgrep:governance:update-baseline`.
//
// Test-only override (tests/scripts/astgrep-self-scan.test.ts spawns this
// file for real via execFileSync to prove the exit code, not just the lib
// function's return value): PI_LENS_SELF_SCAN_SGCONFIG points the scan at an
// explicit sgconfig path, so the wrapper's failure handling can be exercised
// against a genuinely broken config without touching the real one.
import {
	changedFilesSince,
	filesMentioningIgnore,
	findingSignatures,
	findUnreasonedIgnores,
	findingsInChangedFiles,
	findingsInTrackedFiles,
	loadBaseline,
	runSelfScan,
	selfScanRuleIds,
	suiteByName,
	trackedSelfScanFileSet,
	writeBaseline,
} from "./lib/astgrep-self-scan.mjs";
import { setProjectTrustState } from "../clients/project-trust.js";

// #4530: the scan starts the checkout's own ast-grep devDependency through
// pi-lens's spawn seam. With project trust left "unknown" that seam refuses a
// bare lookup resolving inside the checkout, so this maintenance host declares
// the workspace trusted once, as the other non-pi entry points do (mcp/cli.ts,
// mcp/server.ts): the caller that runs the scan owns that decision, and pi is
// not consulted.
setProjectTrustState("trusted");

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const allAdvisory = args.includes("--all-advisory");
// #3684: the advisory registry-subset rule reports only in files changed
// against a diff base. `--base <ref>` names it; CI pull_request runs export
// GITHUB_BASE_REF, read as origin/<ref>. No base and no --all-advisory means
// the advisory hits are counted but not reported.
let baseArg;
let suiteName = "self-scan";
const scanPathArgs = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--update-baseline" || a === "--all-advisory") continue;
	if (a === "--base") baseArg = args[++i];
	else if (a.startsWith("--base=")) baseArg = a.slice("--base=".length);
	else if (a === "--suite") suiteName = args[++i];
	else if (a.startsWith("--suite=")) suiteName = a.slice("--suite=".length);
	else scanPathArgs.push(a);
}
const diffBase =
	baseArg ||
	(process.env.GITHUB_BASE_REF
		? `origin/${process.env.GITHUB_BASE_REF}`
		: undefined);
const sgConfigOverride = process.env.PI_LENS_SELF_SCAN_SGCONFIG || undefined;

function reportAdvisory(advisory) {
	let reported = advisory;
	if (!allAdvisory) {
		if (!diffBase) {
			if (advisory.length > 0) {
				console.log(
					`[astgrep-self-scan] ${advisory.length} advisory hit(s) not reported: no diff base (pass --base <ref>, or --all-advisory)`,
				);
			}
			return;
		}
		try {
			reported = findingsInChangedFiles(advisory, changedFilesSince(diffBase));
		} catch (e) {
			// Advisory never gates: a base that cannot be diffed is a warning.
			console.log(
				`[astgrep-self-scan] advisory hits not reported: could not diff against ${diffBase}: ${String(e?.message ?? e).split("\n")[0]}`,
			);
			return;
		}
	}
	for (const f of reported) {
		const file = String(f.file ?? "?").replace(/\\/g, "/");
		const line = (f.range?.start?.line ?? 0) + 1;
		console.log(`[astgrep-self-scan] advisory ${f.ruleId} ${file}:${line}`);
	}
}

function main() {
	let suite;
	let ruleIds;
	try {
		suite = suiteByName(suiteName);
		ruleIds = selfScanRuleIds(undefined, suite);
	} catch (e) {
		console.error(String(e?.message ?? e));
		process.exit(1);
	}
	console.log(
		`[astgrep-self-scan] suite ${suiteName}: running ${ruleIds.length} rule(s): ${ruleIds.join(", ")}`,
	);

	let result;
	const explicitScanPaths = scanPathArgs.length > 0;
	const startedAt = Date.now();
	try {
		result = runSelfScan({
			suite,
			ruleIds,
			// Directory roots, the same invocation CI uses -- never a file list
			// (Windows cmd.exe/CreateProcess line limits, #3886 r3). Tracked-only
			// filtering happens after the scan: an untracked working-tree scratch
			// file must not gate a push CI would never run it in. An explicit path
			// argument (the wrapper's own tests) still wins.
			scanPaths: explicitScanPaths ? scanPathArgs : suite.scanPaths,
			...(sgConfigOverride ? { sgConfigPath: sgConfigOverride } : {}),
		});
	} catch (e) {
		console.error(`[astgrep-self-scan] scan failed to run: ${e?.message ?? e}`);
		process.exit(1);
	}

	// Untracked findings are dropped for the default directory scan, so an
	// untracked plant cannot gate. --update-baseline keeps the whole tree so
	// triaging before `git add` writes a complete baseline (#3886 r3).
	const tracked =
		explicitScanPaths || updateBaseline
			? undefined
			: trackedSelfScanFileSet(undefined, suite.scanPaths);
	const findings = findingsInTrackedFiles(result.findings, tracked);

	// Shape 10: an empty finding list must be distinguishable from a scan that
	// silently matched nothing. scannedFileCount is ast-grep's own count of
	// files it actually walked, parsed from `--inspect summary`'s stderr --
	// independent of whether any rule fired.
	if (!result.scannedFileCount) {
		console.error(
			`[astgrep-self-scan] scanned 0 files (or the file count could not be parsed from ast-grep's --inspect summary output) -- this is a DEAD scan, not a clean one. stderr:\n${result.stderr}`,
		);
		process.exit(1);
	}
	console.log(
		`[astgrep-self-scan] scanned ${result.scannedFileCount} file(s) with ${result.effectiveRuleCount ?? "?"} effective rule(s) in ${Date.now() - startedAt} ms; ${findings.length} raw finding(s), ${result.advisoryFindings.length} advisory`,
	);
	// #3684: advisory (severity: info) hits never gate and are never
	// baselined. They are printed only for files changed against the diff
	// base (or all of them with --all-advisory), so the hits already on
	// master stay silent.
	reportAdvisory(result.advisoryFindings);

	const signatures = findingSignatures(findings, suite);
	if (updateBaseline) {
		const p = writeBaseline(signatures, undefined, suite, findings);
		console.log(
			`[astgrep-self-scan] wrote ${signatures.length} allowed finding(s) to ${p}`,
		);
		return;
	}

	let baseline;
	try {
		baseline = loadBaseline(undefined, suite);
	} catch (e) {
		console.error(String(e?.message ?? e));
		process.exit(1);
	}
	const newFindings = findings.filter((_f, i) => !baseline.has(signatures[i]));

	if (newFindings.length > 0) {
		console.error(
			`[astgrep-self-scan] ${newFindings.length} NEW finding(s) not in the committed baseline:`,
		);
		for (const f of newFindings) {
			const file = String(f.file ?? "?").replace(/\\/g, "/");
			const line = (f.range?.start?.line ?? 0) + 1;
			console.error(`  ${f.ruleId} ${file}:${line} -- ${f.message ?? ""}`);
		}
		console.error(
			`[astgrep-self-scan] fix the finding, or if it's a legitimate exception, triage it and regenerate the baseline with \`npm run astgrep:${suiteName}:update-baseline\`.`,
		);
		process.exit(1);
	}

	// #4865: an exemption carries its reason. An explicit path scan checks
	// the files it was given; the default scan, the tracked files that mention
	// the directive.
	if (suite.reasonedIgnores) {
		let offenders;
		try {
			offenders = findUnreasonedIgnores(
				explicitScanPaths
					? scanPathArgs
					: filesMentioningIgnore(undefined, suite.scanPaths),
			);
		} catch (e) {
			console.error(
				`[astgrep-self-scan] ignore-reason check failed to run: ${e?.message ?? e}`,
			);
			process.exit(1);
		}
		if (offenders.length > 0) {
			console.error(
				`[astgrep-self-scan] ${offenders.length} ast-grep-ignore comment(s) without a rule id and a reason (write \`// ast-grep-ignore: <rule-id> -- <reason>\`):`,
			);
			for (const o of offenders) {
				console.error(`  ${o.file}:${o.line} -- ${o.text}`);
			}
			process.exit(1);
		}
	}

	console.log(
		`[astgrep-self-scan] clean: ${findings.length} finding(s), all present in the baseline (${baseline.size} allowed entries).`,
	);
}

main();
