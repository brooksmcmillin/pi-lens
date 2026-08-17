/**
 * Knip Client for pi-local
 *
 * Detects unused exports, files, dependencies, and more.
 * Essential for safe refactoring — I need to know what's dead code
 * before I can clean it up.
 *
 * Requires: npm install -D knip
 * Docs: https://knip.dev/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	createAvailabilityChecker,
	findManagedNodeToolBinary,
	getManagedToolEnvironment,
	resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.js";
import {
	createAvailabilityLatch,
	describeUnavailability,
} from "./dispatch/runners/utils/availability-policy.js";

// --- Types ---

export interface KnipIssue {
	type:
		| "export"
		| "file"
		| "dependency"
		| "devDependency"
		| "unlisted"
		| "bin"
		| "enumMember";
	name: string;
	file?: string;
	line?: number;
	package?: string;
}

export interface KnipResult {
	success: boolean;
	issues: KnipIssue[];
	unusedExports: KnipIssue[];
	unusedFiles: KnipIssue[];
	unusedDeps: KnipIssue[];
	unlistedDeps: KnipIssue[];
	summary: string;
	/**
	 * Why an unsuccessful run failed, in a form readers can branch on without
	 * pattern-matching prose (#1467). `unavailable-transient` marks a result the
	 * cache must NOT keep over a good one and the turn loop must not treat as a
	 * hard knip failure — the tool is installed, the probe just timed out.
	 */
	failureKind?: "unavailable-transient" | "unavailable-missing";
}

const EMPTY_RESULT: Omit<KnipResult, "summary"> = {
	success: false,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
};

const ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * Every package name referenced as a KEY (at any nesting depth — npm's
 * `overrides` and pnpm's `pnpm.overrides` allow nested "for this dependency's
 * sub-dependency" overrides) in `package.json`'s `overrides`, `resolutions`
 * (Yarn's equivalent), or `pnpm.overrides` fields. These are the project's
 * own explicit signal that a package is deliberately present to pin a
 * resolution — not a source-imported dependency knip's import graph can see.
 * Missing/malformed `package.json` degrades to an empty set (never throws) —
 * this is a best-effort narrowing, not a required input.
 */
export function readOverridePinnedPackageNames(targetDir: string): Set<string> {
	const names = new Set<string>();
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(
			fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"),
		);
	} catch {
		return names;
	}

	const collectKeys = (value: unknown): void => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			names.add(key);
			collectKeys(nested);
		}
	};

	collectKeys(pkg.overrides);
	collectKeys(pkg.resolutions);
	collectKeys((pkg.pnpm as { overrides?: unknown } | undefined)?.overrides);

	return names;
}

// --- Client ---

export class KnipClient {
	private readonly knipAvailability = createAvailabilityChecker(
		"knip",
		".cmd",
		["--version"],
		{
			environment: (cwd) => getManagedToolEnvironment("knip", cwd),
			unclassifiedFailureOutcome: "missing",
			fastPath: () => findManagedNodeToolBinary("knip"),
		},
	);
	/**
	 * Client-side memo. Only a DURABLE verdict is latched — a transient probe
	 * failure expires, so an installed knip becomes available again without a
	 * host restart (#1467).
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	private knipCommand = "knip";
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	/**
	 * De-dupe concurrent `analyze()` calls against the same project root.
	 *
	 * Without this guard, two back-to-back turn_end events (or a turn_end
	 * firing while the session_start scan is still in flight) can each spawn
	 * a fresh `knip` process over the same tree. Two concurrent knip
	 * runs are CPU-bound and cause the exact pathology we're fixing: load
	 * averages >5, TUI freezes, and zombie processes reparented to init
	 * after pi exits mid-scan.
	 *
	 * Key: canonicalised project root (not the caller's cwd). Value is the
	 * in-flight promise; completing clears the slot.
	 */
	private inFlight = new Map<string, Promise<KnipResult>>();

	constructor(verbose = false) {
		this.log = verbose
			? createSubsystemLogger("knip")
			: () => {};
	}

	/**
	 * Find the nearest directory with a project/knip config marker.
	 *
	 * Returns `null` when no marker is found up to the filesystem root.
	 * Callers MUST treat a null return as "no project here, skip knip" —
	 * previously this fell back to `startDir`, which on a bare cwd like
	 * `/home/v` caused knip to recurse through every project and balloon
	 * memory/CPU.
	 *
	 * Delegates to the shared path-utils helper (refs #625) — never treats a
	 * package/knip config at or above $HOME as the project (escapes the
	 * workspace, #296/#250), and never walks past a `.git`/`.hg`/`.svn`
	 * boundary to pick up an unrelated parent's package.json (Unity/non-JS
	 * repos often have no package.json at their own root).
	 */
	private resolveProjectRoot(
		startDir: string,
		homeDirOverride?: string,
	): string | null {
		return findNearestMarkerRoot(
			startDir,
			["package.json", "knip.json", "knip.ts", "knip.config.js", "knip.config.ts"],
			{ boundaries: [".git", ".hg", ".svn"], homeDir: homeDirOverride },
		);
	}

	/**
	 * Check if knip CLI is available, auto-install if not.
	 *
	 * The memo returns `null` when the last verdict was transient and its
	 * cooldown has expired, which re-enters the probe. That is the difference
	 * between "knip is missing" (a fact worth caching) and "the probe timed out"
	 * (a moment worth retrying).
	 */
	async ensureAvailable(): Promise<boolean> {
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		const cwd = process.cwd();
		const resolved = await resolveAvailableOrInstall(
			this.knipAvailability,
			"knip",
			cwd,
		);
		if (resolved !== null) {
			this.knipCommand = resolved;
			this.availabilityLatch.noteAvailable();
			return true;
		}
		const verdict = this.knipAvailability.getVerdict(cwd);
		this.availabilityLatch.noteUnavailable(
			verdict.outcome ?? "missing",
			verdict.cause ?? "not-found",
		);
		return false;
	}

	/**
	 * The single place a knip-unavailable result is worded. A transient probe
	 * failure must never be reported as "install knip" — knip is on disk.
	 */
	private unavailableResult(): KnipResult {
		const verdict = this.knipAvailability.getVerdict(process.cwd());
		const transient = verdict.outcome === "transient";
		const retryAfterMs = verdict.retryAtMs
			? Math.max(0, verdict.retryAtMs - Date.now())
			: undefined;
		return {
			...EMPTY_RESULT,
			failureKind: transient ? "unavailable-transient" : "unavailable-missing",
			summary: describeUnavailability({
				tool: "Knip",
				installHint: "npm install -D knip",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				retryAfterMs,
			}),
		};
	}

	/**
	 * Run knip analysis on the project.
	 *
	 * Async (uses `safeSpawnAsync`) so it never blocks the event loop —
	 * knip scans on large monorepos can take tens of seconds, and the
	 * previous `spawnSync` implementation froze the TUI for the entire
	 * duration.
	 *
	 * Re-entrancy safe: concurrent calls resolving to the same project
	 * root share a single knip process via `inFlight`.
	 */
	async analyze(cwd?: string, _ignore?: string[]): Promise<KnipResult> {
		const targetDir = this.resolveProjectRoot(cwd || process.cwd());
		if (!targetDir) {
			// No package.json / knip config anywhere up the tree. Running knip
			// from an arbitrary cwd (e.g. $HOME) has no defined meaning and in
			// practice walks huge irrelevant trees — bail early.
			this.log(
				`No project root found from ${cwd || process.cwd()}; skipping knip`,
			);
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No project root found; knip skipped",
			};
		}

		if (!(await this.ensureAvailable())) {
			return this.unavailableResult();
		}

		const key = path.resolve(targetDir);
		const existing = this.inFlight.get(key);
		if (existing) {
			this.log(`Analysis already in flight for ${key}; sharing result`);
			return existing;
		}

		const promise = this.runAnalyze(key).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}

	private async runAnalyze(targetDir: string): Promise<KnipResult> {
		// Cache dir is routed through pi-lens's project-data-dir convention (NOT
		// knip's own default `./node_modules/.cache/knip`) so it lives alongside
		// every other project cache (see cache-manager.ts, call-graph.ts) and is
		// covered by the existing `.pi-lens/` gitignore entry.
		//
		// Caveat (per knip's docs): a cached run does NOT pick up newly-added
		// `.gitignore` files automatically — the cache must be deleted to detect
		// them. Not auto-handled here; this is a documented tradeoff, not a bug.
		const cacheLocation = path.join(getProjectDataDir(targetDir), "cache", "knip");

		// knip (verified against 6.26.0) silently fails to persist the cache when
		// `--cache-location` points at a directory that doesn't exist yet: its
		// internal auto-mkdir throws ENOENT (swallowed internally, debug-logged
		// only) on Windows, so the very first run — and every run after, since the
		// dir never gets created — degrades to an uncached scan with no error
		// surfaced. Pre-creating the dir avoids that path entirely; matches the
		// mkdirSync-before-spawn convention call-graph.ts already uses for its
		// cache file's parent dir.
		try {
			fs.mkdirSync(cacheLocation, { recursive: true });
		} catch (err) {
			this.log(`Failed to pre-create knip cache dir ${cacheLocation}: ${err}`);
		}

		const args = [
			"--reporter=json",
			"--include",
			// enumMembers surfaces unused enum members — finer-grained than
			// file-level exports. (knip 6.x has NO `classMembers` issue type; passing
			// it makes knip exit 2 with zero output, silently disabling the scan —
			// verified against knip 6.20. Valid member-level type here is enumMembers.)
			"files,exports,types,dependencies,unlisted,enumMembers",
			"--cache",
			"--cache-location",
			cacheLocation,
		];

		const result = await safeSpawnAsync(this.knipCommand, args, {
			timeout: ANALYSIS_TIMEOUT_MS,
			cwd: targetDir,
			env: await getManagedToolEnvironment("knip", targetDir),
		});

		if (result.error) {
			this.log(`Analysis error: ${result.error.message}`);
			return {
				...EMPTY_RESULT,
				summary: `Error: ${result.error.message}`,
			};
		}

		// Knip exits 0 on success (even with issues), 1 on errors
		const output = result.stdout || "";
		this.log(`Knip output length: ${output.length}`);
		if (output.length < 500) {
			this.log(`Knip output sample: ${output}`);
		}
		if (!output.trim()) {
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No issues found",
			};
		}

		return this.dropOverridePinnedDeps(this.parseOutput(output), targetDir);
	}

	/**
	 * Drop `dependency`/`devDependency` issues for a package that's also
	 * referenced as an npm `overrides` (or Yarn `resolutions` / pnpm
	 * `pnpm.overrides`) key in this project's `package.json` (#968).
	 *
	 * A direct devDependency whose only job is pinning a vulnerable
	 * transitive/peer resolution has no source import — that's WORKING AS
	 * INTENDED, not dead code, and knip has no concept of "this dependency
	 * exists only to satisfy an overrides entry" (it only sees imports).
	 * `overrides`/`resolutions` are the project's own explicit, unambiguous
	 * signal that the package is deliberately present — the same class of
	 * signal `hardcoded-url`'s `SCREAMING_SNAKE_CASE` constant-name carve-out
	 * and `ts-ssrf`'s constant-identifier carve-out lean on elsewhere in this
	 * codebase — so this narrows the finding rather than suppressing
	 * `dependency`/`devDependency` issues wholesale: a devDependency that
	 * ISN'T also an overrides/resolutions key is still reported.
	 */
	private dropOverridePinnedDeps(
		result: KnipResult,
		targetDir: string,
	): KnipResult {
		if (result.unusedDeps.length === 0) return result;
		const pinned = readOverridePinnedPackageNames(targetDir);
		if (pinned.size === 0) return result;

		const isPinnedDepIssue = (issue: KnipIssue): boolean =>
			(issue.type === "dependency" || issue.type === "devDependency") &&
			(pinned.has(issue.name) || (!!issue.package && pinned.has(issue.package)));

		const issues = result.issues.filter((issue) => !isPinnedDepIssue(issue));
		const unusedDeps = result.unusedDeps.filter(
			(issue) => !isPinnedDepIssue(issue),
		);
		return unusedDeps.length === result.unusedDeps.length
			? result
			: { ...result, issues, unusedDeps };
	}

	/**
	 * Find unused exports in a specific file
	 */
	async findUnusedExports(filePath: string): Promise<string[]> {
		const result = await this.analyze(path.dirname(filePath));
		const basename = path.basename(filePath);

		return result.unusedExports
			.filter((e) => e.file?.includes(basename))
			.map((e) => e.name);
	}

	/**
	 * Format results for LLM consumption. Delegates to the pure
	 * `formatKnipResult` so callers (e.g. turn-end) can format without a live
	 * client instance.
	 */
	formatResult(result: KnipResult, maxItems = 20): string {
		return formatKnipResult(result, maxItems);
	}

	// --- Internal ---

	private parseOutput(output: string): KnipResult {
		try {
			const data = JSON.parse(output);
			const issues: KnipIssue[] = [];
			const unusedExports: KnipIssue[] = [];
			const unusedFiles: KnipIssue[] = [];
			const unusedDeps: KnipIssue[] = [];
			const unlistedDeps: KnipIssue[] = [];

			const addIssue = (issue: KnipIssue) => {
				issues.push(issue);
				if (issue.type === "export" || issue.type === "enumMember") {
					unusedExports.push(issue);
				}
				if (issue.type === "file") unusedFiles.push(issue);
				if (issue.type === "dependency" || issue.type === "devDependency") {
					unusedDeps.push(issue);
				}
				if (issue.type === "unlisted" || issue.type === "bin") {
					unlistedDeps.push(issue);
				}
			};

			// Knip JSON format (grouped): { issues: [ { file, exports:[], files:[], dependencies:[], ... } ] }
			const fileEntries: any[] = Array.isArray(data?.issues) ? data.issues : [];

			for (const entry of fileEntries) {
				const file: string = entry.file ?? "";

				const push = (
					arr: any[],
					type: KnipIssue["type"],
					_target: KnipIssue[],
				) => {
					for (const item of arr) {
						addIssue({
							type,
							name: item.name ?? item.symbol ?? String(item),
							file,
							line: item.line,
							package: item.package,
						});
					}
				};

				push(entry.exports ?? [], "export", unusedExports);
				push(entry.types ?? [], "export", unusedExports);
				push(entry.enumMembers ?? [], "enumMember", unusedExports);
				push(entry.files ?? [], "file", unusedFiles);
				push(entry.dependencies ?? [], "dependency", unusedDeps);
				push(entry.devDependencies ?? [], "devDependency", unusedDeps);
				push(entry.unlisted ?? [], "unlisted", unlistedDeps);
				push(entry.binaries ?? [], "bin", unlistedDeps);
			}

			// Fallback format: flat list of issue objects
			if (issues.length === 0 && Array.isArray(data)) {
				for (const item of data) {
					if (!item || typeof item !== "object") continue;
					const rawType = String(
						item.type ?? item.issueType ?? item.kind ?? "file",
					).toLowerCase();
					const type: KnipIssue["type"] =
						rawType === "export" || rawType === "exports"
							? "export"
							: rawType === "dependency"
								? "dependency"
								: rawType === "devdependency"
									? "devDependency"
									: rawType === "unlisted"
										? "unlisted"
										: rawType === "bin" || rawType === "binaries"
											? "bin"
											: "file";
					addIssue({
						type,
						name: String(
							item.name ??
								item.symbol ??
								item.package ??
								item.message ??
								"unknown",
						),
						file: item.file ?? item.path ?? item.location?.file,
						line: item.line ?? item.location?.line,
						package: item.package,
					});
				}
			}

			return {
				success: true,
				issues,
				unusedExports,
				unusedFiles,
				unusedDeps,
				unlistedDeps,
				summary: `Found ${issues.length} issues`,
			};
		} catch (err) {
			void err;
			this.log("Failed to parse knip JSON output");
			return {
				...EMPTY_RESULT,
				summary: "Failed to parse output",
			};
		}
	}
}

/**
 * Format a KnipResult for the agent (the FULL dead-code picture: all unused
 * exports/members, files, and deps — not a delta). Pure: no client instance or
 * `this`, so turn-end can surface findings without depending on the injected
 * client exposing the method. Returns "" when there is nothing to report.
 * Unlisted deps are intentionally omitted here — they're surfaced as a
 * delta-gated blocker (newly broken imports), not as cleanup advice.
 */
export function formatKnipResult(result: KnipResult, maxItems = 20): string {
	if (!result.success) return `[Knip] ${result.summary}`;
	if (result.issues.length === 0) return "";

	let output = `[Knip] ${result.issues.length} issue(s)`;
	if (result.unusedExports.length)
		output += ` — ${result.unusedExports.length} unused export(s)`;
	if (result.unusedFiles.length)
		output += ` — ${result.unusedFiles.length} unused file(s)`;
	if (result.unusedDeps.length)
		output += ` — ${result.unusedDeps.length} unused dep(s)`;
	if (result.unlistedDeps.length)
		output += ` — ${result.unlistedDeps.length} unlisted dep(s)`;
	output += ":\n";

	// Show unused exports first (most useful for refactoring)
	if (result.unusedExports.length > 0) {
		output += "\n  Unused exports:\n";
		for (const issue of result.unusedExports.slice(0, maxItems)) {
			const loc = issue.file ? ` (${path.basename(issue.file)})` : "";
			output += `    - ${issue.name}${loc}\n`;
		}
		if (result.unusedExports.length > maxItems) {
			output += `    ... and ${result.unusedExports.length - maxItems} more\n`;
		}
	}

	// Show unused files
	if (result.unusedFiles.length > 0) {
		output += "\n  Unused files:\n";
		for (const issue of result.unusedFiles.slice(0, 10)) {
			output += `    - ${issue.name}\n`;
		}
	}

	// Show unused deps (might be worth removing)
	if (result.unusedDeps.length > 0) {
		output += "\n  Unused dependencies:\n";
		for (const issue of result.unusedDeps) {
			output += `    - ${issue.package || issue.name}\n`;
		}
	}

	return output;
}
