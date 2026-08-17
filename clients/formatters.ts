/**
 * Formatter Definitions for pi-lens
 *
 * Auto-detects formatters based on:
 * - Config files (biome.json, .prettierrc, etc.)
 * - Dependencies (package.json, requirements.txt, etc.)
 * - Binary availability (which/where)
 *
 * Inspired by OpenCode's formatter.ts pattern
 */

import { logExtension } from "./extension-log.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BoundedLruCache } from "./bounded-cache.js";
import { normalizeMapKey } from "./path-utils.js";
import { TERRAGRUNT_FILENAMES } from "./file-kinds.js";
import {
	detectIndentation,
	hasDetectableIndentation,
} from "./dispatch/indent-detect.js";
import { logLatency } from "./latency-logger.js";
import {
	type AvailabilityLatch,
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";
import { findGlobalBinary } from "./package-manager.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { assertInstallAllowed } from "./project-trust.js";
import {
	getAutoInstallToolIdForFormatter,
	getFormatterPolicyForFile,
	getSmartDefaultFormatterName,
	hasBiomeConfig,
	hasBlackConfig,
	hasClangFormatConfig,
	hasCljfmtConfig,
	hasCmakeFormatConfig,
	hasGoogleJavaFormatConfig,
	hasKtfmtConfig,
	hasKtlintConfig,
	hasNearestPackageJsonDependency,
	hasNearestPackageJsonField,
	hasOcamlformatConfig,
	hasOxfmtConfig,
	hasOxfmtSvelteConfig,
	hasPhpCsFixerConfig,
	hasPrettierConfig,
	hasRubocopConfig,
	hasRuffConfig,
	hasSqlfluffConfig,
	hasStandardrbConfig,
	hasStyluaConfig,
	hasVitePlusConfig,
	OXFMT_SUPPORTED_EXTENSIONS,
} from "./tool-policy.js";

const _lazyInstallAttempts = new Set<string>();

export async function tryLazyInstallFormatterTool(
	tool: "rubocop" | "rustfmt",
	cwd: string,
): Promise<boolean> {
	if (!assertInstallAllowed(`formatter lazy install: ${tool}`)) return false;
	const attemptKey = `${tool}:${cwd}`;
	if (_lazyInstallAttempts.has(attemptKey)) return false;
	_lazyInstallAttempts.add(attemptKey);

	if (tool === "rubocop") {
		const res = await safeSpawnAsync("gem", ["install", "rubocop", "--no-document"], {
			timeout: 180000,
			cwd,
			ignoreAmbientSignal: true,
		});
		const ok = !res.error && res.status === 0;
		// A fresh binary on PATH invalidates every "not found" verdict (#1495).
		if (ok) resetWhichLatches();
		if (!ok) {
			logExtension({
				subsystem: "format",
				message: `lazy-install rubocop failed: ${res.error?.message ?? res.stderr ?? "exit " + res.status}`,
				metadata: { tool: "rubocop", cwd },
			});
		}
		return ok;
	}

	const res = await safeSpawnAsync("rustup", ["component", "add", "rustfmt"], {
		timeout: 180000,
		cwd,
		ignoreAmbientSignal: true,
	});
	const ok = !res.error && res.status === 0;
	if (ok) resetWhichLatches();
	if (!ok) {
		logExtension({
			subsystem: "format",
			message: `lazy-install rustfmt failed: ${res.error?.message ?? res.stderr ?? "exit " + res.status}`,
			metadata: { tool: "rustfmt", cwd },
		});
	}
	return ok;
}

// --- Types ---

/**
 * Sentinel a `resolveCommand` returns to mean "do not format this file at
 * all" — distinct from `null`, which means "fall back to the static
 * `command`". #1144's style-preserving resolvers return this when the repo
 * has no config AND the file's indentation is undetectable: running the
 * stock command there is exactly the stock-style imposition the fix bans.
 */
export const SKIP_FORMATTING = "skip-formatting" as const;
export type ResolvedFormatterCommand =
	| string[]
	| null
	| typeof SKIP_FORMATTING;

export interface FormatterInfo {
	name: string;
	command: string[]; // Command with $FILE placeholder — used as fallback
	extensions: string[];
	/** Basenames (lowercase) this formatter applies to regardless of extension. */
	filenames?: readonly string[];
	/** Detect if this formatter should be used for a project */
	detect(cwd: string): Promise<boolean>;
	/**
	 * Optionally resolve the full command at runtime (venv, vendor/bin, bundle exec).
	 * Return null to fall back to the static `command` field.
	 * filePath is already resolved to an absolute path.
	 */
	resolveCommand?(
		filePath: string,
		cwd: string,
	): Promise<ResolvedFormatterCommand>;
	/**
	 * Opt OUT of exit-code strictness, with the justification as the value.
	 *
	 * `formatFile` is strict BY DEFAULT (#1337): a nonzero exit is a formatting
	 * failure, because a formatter that never ran leaves the file byte-identical
	 * and that is indistinguishable from "already formatted". The old default was
	 * the reverse — opt-IN strictness — and it let `ruff format` reject invented
	 * flags with exit 2 and report a clean no-op for a full release cycle (#1336).
	 *
	 * Set this ONLY for lint-autofix formatters, which exit nonzero when offenses
	 * remain AFTER a successful rewrite (`rubocop -a`, `ktlint -F`,
	 * `standardrb --fix`, `sqlfluff fix`); failing those would surface an error on
	 * every file with an unfixable offense. The type is a string rather than a
	 * boolean so the evidence is structurally required at the opt-out site — an
	 * opt-out with no documented benign-nonzero mode cannot be written silently.
	 * `tests/clients/dispatch/formatter-exit-code-posture.test.ts` pins the set.
	 */
	lenientExitCode?: string;
	/**
	 * The EXACT nonzero statuses the documented benign mode covers (#1343
	 * review): lenient tools distinguish "offenses remain after a successful
	 * rewrite" (typically 1) from command/config/crash failure (typically 2+).
	 * Required whenever `lenientExitCode` is set -- a lenient formatter
	 * accepting ALL nonzero statuses would let a bad flag or crashed child
	 * read as success (the #1336 bug surviving behind the lenient label).
	 */
	lenientStatuses?: number[];
}

export interface FormatterResult {
	success: boolean;
	changed: boolean;
	error?: string;
}

// --- Utility Functions ---

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findUp(
	targets: string[],
	startDir: string,
	stopDir: string = path.parse(startDir).root,
): Promise<string[]> {
	const found: string[] = [];
	let currentDir = startDir;

	while (currentDir !== stopDir) {
		for (const target of targets) {
			const checkPath = path.join(currentDir, target);
			if (await fileExists(checkPath)) {
				found.push(checkPath);
			}
		}
		const parent = path.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}

	return found;
}

const WHICH_BUDGET_MS = 5000;

/**
 * PATH lookups, governed by the shared availability policy (#1495).
 *
 * `which()` is a spawn on a 5 s budget, not a filesystem check, and around a
 * dozen `detect*` implementations gate on it. A transient timeout used to drop
 * the formatter AND get written to `detectionCache` as an empty enabled-list —
 * a cache invalidated only by a config file's mtime or size, never by time. One
 * stalled `which rustfmt` therefore disabled Rust formatting for the session
 * unless the user happened to edit a config file.
 *
 * Now: only a genuine absence latches, a stall expires on a cooldown, and the
 * detection pass refuses to cache an empty result a stall caused.
 */
const whichLatchByCommand = new Map<
	string,
	{ latch: AvailabilityLatch; resolved: string | null }
>();

/**
 * Commands whose CURRENT `which` verdict is transient — a probe that never got a
 * fair hearing, still inside its cooldown.
 *
 * Scoped per command on purpose (#1495 review). The first cut counted transient
 * verdicts process-wide and compared the count across a detection pass, which
 * over-suppressed: one stalled `which rustfmt` stopped an unrelated Python or
 * shell detection from caching, and stamped `reason: "probe-timeout"` on
 * selections where nothing had timed out. A command leaves the set as soon as
 * its verdict becomes trustworthy — a resolved path or a genuine absence.
 */
const whichTransientCommands = new Set<string>();

/** Drop the PATH verdicts, so a newly installed binary is visible at once. */
function resetWhichLatches(): void {
	whichLatchByCommand.clear();
	whichTransientCommands.clear();
}

async function which(command: string): Promise<string | null> {
	let entry = whichLatchByCommand.get(command);
	if (!entry) {
		entry = { latch: createAvailabilityLatch(), resolved: null };
		whichLatchByCommand.set(command, entry);
	}
	const memo = entry.latch.read();
	if (memo !== null) return memo ? entry.resolved : null;

	const stallSampler = startHostStallSampler();
	const startedAt = Date.now();
	const result = await safeSpawnAsync(
		process.platform === "win32" ? "where" : "which",
		[command],
		{ timeout: WHICH_BUDGET_MS },
	);
	const hostStallMs = stallSampler.stop();
	const elapsedMs = Date.now() - startedAt;

	const resolved =
		!result.error && result.status === 0
			? (result.stdout?.trim().split(/\r?\n/)[0] ?? null)
			: null;
	if (resolved) {
		entry.resolved = resolved;
		entry.latch.noteAvailable();
		whichTransientCommands.delete(command);
		logAvailabilityDecision({
			tool: command,
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs,
			latched: true,
			hostStallMs,
			budgetMs: WHICH_BUDGET_MS,
		});
		return resolved;
	}

	entry.resolved = null;
	// A `which`/`where` that RAN and found nothing exits nonzero with NO spawn
	// error, and only that is a genuine absence an install would fix.
	//
	// An UNSPAWNABLE prober is the opposite (#1495 review): EACCES, `spawn
	// UNKNOWN`, EMFILE, an unresolvable cwd, or `where`/`which` itself missing
	// says nothing about the tool that was asked for. Claiming `missing` there
	// was the worst version of this bug, because the prober is shared by every
	// which-gated formatter — one EACCES would have latched a dozen of them off
	// for the session. So the `missing` override is granted only to a prober that
	// ran, and anything that stopped it from running stays transient.
	const proberRan = !result.error;
	const classified = classifyProbeFailure(result, {
		hostStallMs,
		...(proberRan && { unclassifiedFailureOutcome: "missing" as const }),
	});
	let { outcome, cause } = classified;
	if (!proberRan && outcome !== "transient") {
		outcome = "transient";
		cause = "probe-rejected";
	}
	const retryAfterMs = entry.latch.noteUnavailable(outcome, cause);
	if (outcome === "transient") whichTransientCommands.add(command);
	else whichTransientCommands.delete(command);
	logAvailabilityDecision({
		tool: command,
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs,
		latched: retryAfterMs === 0,
		hostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: WHICH_BUDGET_MS,
	});
	return null;
}

async function resolveGoFmtBinary(): Promise<string | null> {
	const inPath = await which("gofmt");
	if (inPath) return inPath;

	const goCheck = await safeSpawnAsync("go", ["env", "GOROOT"], {
		timeout: 5000,
	});
	if (goCheck.error || goCheck.status !== 0) return null;

	const goroot = (goCheck.stdout ?? "").trim();
	if (!goroot) return null;

	const binary = path.join(
		goroot,
		"bin",
		process.platform === "win32" ? "gofmt.exe" : "gofmt",
	);
	return (await fileExists(binary)) ? binary : null;
}

// --- Venv / Local Binary Helpers ---

/**
 * Walk up from cwd looking for a binary in .venv or venv.
 * Returns the absolute path if found, null otherwise.
 */
async function findInVenv(binary: string, cwd: string): Promise<string | null> {
	const isWin = process.platform === "win32";
	const candidates = isWin
		? [
				`.venv/Scripts/${binary}.exe`,
				`venv/Scripts/${binary}.exe`,
				`.venv/Scripts/${binary}`,
				`venv/Scripts/${binary}`,
			]
		: [`.venv/bin/${binary}`, `venv/bin/${binary}`];

	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Check vendor/bin for PHP Composer-managed tools.
 * Walks up from cwd to find vendor/bin/<binary>.
 */
async function findInVendorBin(
	binary: string,
	cwd: string,
): Promise<string | null> {
	const isWin = process.platform === "win32";
	const names = isWin ? [`${binary}.bat`, binary] : [binary];
	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		for (const name of names) {
			const full = path.join(dir, "vendor", "bin", name);
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Check node_modules/.bin for locally installed Node tools.
 * Walks up from cwd to find node_modules/.bin/<binary>.
 */
async function findInNodeModules(
	binary: string,
	cwd: string,
): Promise<string | null> {
	const isWin = process.platform === "win32";
	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		const candidates = isWin
			? [
					path.join(dir, "node_modules", ".bin", `${binary}.cmd`),
					path.join(dir, "node_modules", ".bin", binary),
				]
			: [path.join(dir, "node_modules", ".bin", binary)];
		for (const full of candidates) {
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Returns true if `bundle exec <gem>` should be used:
 * bundle binary is available AND Gemfile.lock exists in the tree.
 */
async function canUseBundleExec(cwd: string): Promise<boolean> {
	if ((await which("bundle")) === null) return false;
	const lockfiles = await findUp(["Gemfile.lock"], cwd);
	return lockfiles.length > 0;
}

async function resolveManagedSmartDefaultCommand(
	formatterName: string,
	filePath: string,
	args: string[],
): Promise<string[] | null> {
	const toolId = getAutoInstallToolIdForFormatter(formatterName);
	if (!toolId) return null;
	const { ensureTool } = await import("./installer/index.js");
	const installed = await ensureTool(toolId);
	if (!installed) return null;
	return [installed, ...args, filePath];
}

function hasExplicitFormatterConfig(
	formatterName: string,
	cwd: string,
	ext: string,
): boolean {
	switch (formatterName) {
		case "biome":
			return hasBiomeConfig(cwd);
		case "prettier":
			return (
				hasPrettierConfig(cwd) || hasNearestPackageJsonField(cwd, "prettier")
			);
		case "oxfmt":
			// .svelte is conditional beyond "an oxfmt config exists": oxfmt
			// requires the `svelte` package installed AND the config's `svelte`
			// flag enabled (verified empirically — see hasOxfmtSvelteConfig).
			// The generic checks below are NOT sufficient for .svelte — an
			// oxfmt.toml with no svelte flag, or an oxfmt dependency alone,
			// both fail at runtime for .svelte specifically (other extensions
			// are unaffected by this stricter gate).
			if (ext === ".svelte") {
				return hasOxfmtSvelteConfig(cwd);
			}
			return (
				hasOxfmtConfig(cwd) ||
				hasVitePlusConfig(cwd) ||
				// The published package is `oxfmt`; `@oxc-project/oxfmt` does not
				// exist on npm. Accept both (scoped kept for forward-compat).
				hasNearestPackageJsonDependency(cwd, "oxfmt") ||
				hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt")
			);
		case "ruff":
			return hasRuffConfig(cwd);
		case "black":
			return hasBlackConfig(cwd);
		case "sqlfluff":
			return hasSqlfluffConfig(cwd);
		case "rubocop":
			return hasRubocopConfig(cwd);
		case "standardrb":
			return hasStandardrbConfig(cwd);
		case "clang-format":
			return hasClangFormatConfig(cwd);
		case "php-cs-fixer":
			return hasPhpCsFixerConfig(cwd);
		case "stylua":
			return hasStyluaConfig(cwd);
		case "ocamlformat":
			return hasOcamlformatConfig(cwd);
		case "google-java-format":
			return hasGoogleJavaFormatConfig(cwd);
		case "ktfmt":
			return hasKtfmtConfig(cwd);
		case "ktlint":
			return hasKtlintConfig(cwd);
		case "cljfmt":
			return hasCljfmtConfig(cwd);
		case "cmake-format":
			return hasCmakeFormatConfig(cwd);
		default:
			return false;
	}
}

// --- Formatter Definitions ---

async function hasEditorConfig(cwd: string): Promise<boolean> {
	try {
		await fs.access(path.join(cwd, ".editorconfig"));
		return true;
	} catch {
		return false;
	}
}

async function indentationArgs(
	filePath: string,
	tool: "biome" | "prettier" | "ruff" | "shfmt",
	cwd: string,
): Promise<string[] | null> {
	if (await hasEditorConfig(cwd) || hasExplicitFormatterConfig(tool, cwd, path.extname(filePath))) {
		return [];
	}
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch {
		// Resolution tests and callers may probe a path before it exists.
		return [];
	}
	if (!hasDetectableIndentation(content)) return null;
	const indentation = detectIndentation(content);
	if (tool === "shfmt") return indentation.style === "tab" ? ["-i", "0"] : ["-i", String(indentation.width)];
	if (tool === "prettier") {
		return [indentation.style === "tab" ? "--use-tabs" : "--no-use-tabs", "--tab-width", String(indentation.width)];
	}
	if (tool === "ruff") {
		// `ruff format` has NO --indent-style/--indent-width flags (it errors with
		// "unexpected argument" and exits 2, which formatFile reported as a silent
		// clean no-op back when exit-code strictness was opt-in). Style is pinned
		// through inline TOML overrides instead (#1144 follow-up).
		return [
			"--config",
			`indent-width=${indentation.width}`,
			"--config",
			`format.indent-style='${indentation.style}'`,
		];
	}
	return ["--indent-style", indentation.style, "--indent-width", String(indentation.width)];
}

/**
 * Every biome invocation must carry this. Biome exits 1 with "No files were
 * processed in the specified paths" when the path is ignored by the repo's own
 * biome.json or carries an extension biome does not handle — a benign outcome
 * that, under #1337's strict default, would otherwise report a formatting
 * failure on every edit under an ignored directory. Verified against biome
 * 2.4.12: ignored path → exit 1, +flag → exit 0; unsupported extension → exit
 * 1, +flag → exit 0; and a real syntax error still exits 1 WITH the flag, so
 * strictness is preserved for actual failures.
 *
 * `clients/dispatch/runners/biome-check.ts:108` already passes this on the lint
 * path; the formatter path did not, which is what made biome the one
 * misclassified formatter in the #1337 audit.
 */
const BIOME_UNMATCHED_FLAG = "--no-errors-on-unmatched";

export const biomeFormatter: FormatterInfo = {
	name: "biome",
	command: [
		"npx",
		"@biomejs/biome",
		"format",
		"--write",
		BIOME_UNMATCHED_FLAG,
		"$FILE",
	],
	async resolveCommand(filePath, cwd) {
		const editorConfigFlag = (await hasEditorConfig(cwd))
			? ["--use-editorconfig=true"]
			: [];
		const styleArgs = await indentationArgs(filePath, "biome", cwd);
		if (styleArgs === null) return SKIP_FORMATTING;
		const args = [
			"format",
			"--write",
			BIOME_UNMATCHED_FLAG,
			...editorConfigFlag,
			...styleArgs,
		];
		const local = await findInNodeModules("biome", cwd);
		if (local) return [local, ...args, filePath];
		// Any package manager's global bin dir (npm/pnpm/yarn/bun) before we
		// auto-install — catches a `pnpm add -g @biomejs/biome` PATH misses (#375).
		const global = await findGlobalBinary("biome");
		if (global) return [global, ...args, filePath];
		const toolId = getAutoInstallToolIdForFormatter("biome");
		if (!toolId) return null;
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool(toolId);
		if (installed) return [installed, ...args, filePath];
		return null;
	},
	extensions: [
		".js",
		".jsx",
		".mjs",
		".cjs",
		".ts",
		".tsx",
		".mts",
		".cts",
		".json",
		".jsonc",
		".css",
		".scss",
		".sass",
		".vue",
		".svelte",
		".html",
		".htm",
	],
	async detect(cwd: string) {
		return (
			hasBiomeConfig(cwd) ||
			hasNearestPackageJsonDependency(cwd, "@biomejs/biome")
		);
	},
};

export const prettierFormatter: FormatterInfo = {
	name: "prettier",
	command: ["npx", "prettier", "--write", "$FILE"],
	async resolveCommand(filePath, cwd) {
		const styleArgs = await indentationArgs(filePath, "prettier", cwd);
		if (styleArgs === null) return SKIP_FORMATTING;
		const args = ["--write", ...styleArgs];
		const local = await findInNodeModules("prettier", cwd);
		if (local) return [local, ...args, filePath];
		// Global bin of any manager (npm/pnpm/yarn/bun) before auto-install (#375).
		const global = await findGlobalBinary("prettier");
		if (global) return [global, ...args, filePath];
		return resolveManagedSmartDefaultCommand("prettier", filePath, args);
	},
	extensions: [
		".js",
		".jsx",
		".mjs",
		".cjs",
		".ts",
		".tsx",
		".mts",
		".cts",
		".json",
		".jsonc",
		".css",
		".scss",
		".sass",
		".less",
		".vue",
		".svelte",
		".html",
		".htm",
		".md",
		".mdx",
		".yaml",
		".yml",
		".graphql",
		".gql",
	],
	async detect(cwd: string) {
		return (
			hasPrettierConfig(cwd) ||
			hasNearestPackageJsonDependency(cwd, "prettier") ||
			hasNearestPackageJsonField(cwd, "prettier")
		);
	},
};

export const oxfmtFormatter: FormatterInfo = {
	name: "oxfmt",
	command: ["oxfmt", "$FILE"],
	// #1337 audit: oxfmt (and the `vp fmt --write` path) publish no exit-code
	// table. `--write` is the default and `--check` is the separate verification
	// mode, so there is no documented nonzero-on-reformat. Absent a documented
	// benign-nonzero mode, it stays strict — the safe direction, since the failure
	// mode of guessing wrong the other way is a silent no-op (#1336).
	async resolveCommand(filePath, cwd) {
		if (hasVitePlusConfig(cwd)) {
			const localVp = await findInNodeModules("vp", cwd);
			if (localVp) return [localVp, "fmt", filePath, "--write"];
			const globalVp = await which("vp");
			if (globalVp) return [globalVp, "fmt", filePath, "--write"];
		}
		const local = await findInNodeModules("oxfmt", cwd);
		if (local) return [local, filePath];
		const found = await which("oxfmt");
		if (found) return [found, filePath];
		return null;
	},
	// Single source of truth: OXFMT_SUPPORTED_EXTENSIONS in tool-policy.ts.
	// Do not hand-maintain a second copy of this list (#1134 — previously two
	// parallel hand-maintained lists, the #883 single-source-of-truth class).
	extensions: [...OXFMT_SUPPORTED_EXTENSIONS],
	async detect(cwd: string) {
		return (
			hasOxfmtConfig(cwd) ||
			hasVitePlusConfig(cwd) ||
			// Published package is `oxfmt` (the scoped name does not exist on npm).
			hasNearestPackageJsonDependency(cwd, "oxfmt") ||
			hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt")
		);
	},
};

export const ruffFormatter: FormatterInfo = {
	name: "ruff",
	command: ["ruff", "format", "$FILE"],
	extensions: [".py", ".pyi"],
	// Strict (the #1337 default): `ruff format` exits 0 on a successful in-place
	// rewrite and 2 on argument rejection / syntax error (verified, ruff 0.x:
	// well-formed → 0, reformatted → 0, unparseable → 2). The exit-2 no-op is
	// exactly what hid the bad --indent-style flags for a full release cycle.
	async resolveCommand(filePath, cwd) {
		const styleArgs = await indentationArgs(filePath, "ruff", cwd);
		if (styleArgs === null) return SKIP_FORMATTING;
		const args = ["format", ...styleArgs];
		const venv = await findInVenv("ruff", cwd);
		if (venv) return [venv, ...args, filePath];
		const toolId = getAutoInstallToolIdForFormatter("ruff");
		if (!toolId) return null;
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool(toolId);
		if (installed) return [installed, ...args, filePath];
		return null;
	},
	async detect(cwd: string) {
		if (hasRuffConfig(cwd)) return true;
		// No-config fallback: if Ruff is already available, allow formatter usage.
		// This keeps Python default behavior consistent with startup defaults.
		const { getToolPath } = await import("./installer/index.js");
		const installed = await getToolPath("ruff");
		return Boolean(installed);
	},
};

export const blackFormatter: FormatterInfo = {
	name: "black",
	command: ["black", "$FILE"],
	extensions: [".py", ".pyi"],
	async resolveCommand(filePath, cwd) {
		const venv = await findInVenv("black", cwd);
		if (venv) return [venv, filePath];
		return null;
	},
	async detect(cwd: string) {
		return hasBlackConfig(cwd);
	},
};

export const sqlfluffFormatter: FormatterInfo = {
	name: "sqlfluff",
	command: ["sqlfluff", "fix", "--force", "$FILE"],
	extensions: [".sql"],
	lenientExitCode:
		"lint-autofix: `sqlfluff fix` writes the corrected file and then exits 1 " +
		"when unfixable violations remain (its documented exit codes are 0 = all " +
		"clean, 1 = violations remain, 2 = command/config failure), so a nonzero " +
		"exit routinely accompanies a successful rewrite.",
	lenientStatuses: [1],
	async resolveCommand(filePath, cwd) {
		const venv = await findInVenv("sqlfluff", cwd);
		if (venv) return [venv, "fix", "--force", filePath];
		return null;
	},
	async detect(cwd: string) {
		return hasSqlfluffConfig(cwd);
	},
};

export const gofmtFormatter: FormatterInfo = {
	name: "gofmt",
	command: ["gofmt", "-w", "$FILE"],
	extensions: [".go"],
	async resolveCommand(filePath, _cwd) {
		const gofmtBinary = await resolveGoFmtBinary();
		if (!gofmtBinary) return null;
		return [gofmtBinary, "-w", filePath];
	},
	async detect(_cwd: string) {
		return (await resolveGoFmtBinary()) !== null;
	},
};

export const rustfmtFormatter: FormatterInfo = {
	name: "rustfmt",
	command: ["rustfmt", "$FILE"],
	extensions: [".rs"],
	async detect(cwd: string) {
		if ((await which("rustfmt")) !== null) return true;
		// If we're in a Rust project, attempt one lazy install of rustfmt component.
		const rustProject = (await findUp(["Cargo.toml"], cwd)).length > 0;
		if (!rustProject) return false;
		if ((await which("rustup")) === null) return false;
		await tryLazyInstallFormatterTool("rustfmt", cwd);
		return (await which("rustfmt")) !== null;
	},
};

export const zigFormatter: FormatterInfo = {
	name: "zig",
	command: ["zig", "fmt", "$FILE"],
	extensions: [".zig", ".zon"],
	async detect(_cwd: string) {
		return (await which("zig")) !== null;
	},
};

export const dartFormatter: FormatterInfo = {
	name: "dart",
	command: ["dart", "format", "$FILE"],
	extensions: [".dart"],
	async detect(_cwd: string) {
		return (await which("dart")) !== null;
	},
};

export const shfmtFormatter: FormatterInfo = {
	name: "shfmt",
	command: ["shfmt", "-w", "$FILE"],
	extensions: [".sh", ".bash"],
	async resolveCommand(filePath, cwd) {
		const styleArgs = await indentationArgs(filePath, "shfmt", cwd);
		if (styleArgs === null) return SKIP_FORMATTING;
		const inPath = await which("shfmt");
		if (inPath) return [inPath, "-w", ...styleArgs, filePath];
		return resolveManagedSmartDefaultCommand("shfmt", filePath, ["-w", ...styleArgs]);
	},
	async detect(_cwd: string) {
		if ((await which("shfmt")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("shfmt"));
	},
};

export const nixfmtFormatter: FormatterInfo = {
	name: "nixfmt",
	command: ["nixfmt", "$FILE"],
	// #1337 audit: nixfmt's README documents in-place formatting but has no
	// exit-code section and no change-detection mode, so nothing documents a
	// benign nonzero. Strict by default (see oxfmt above for the rationale).
	extensions: [".nix"],
	async detect(_cwd: string) {
		return (await which("nixfmt")) !== null;
	},
};

export const mixFormatter: FormatterInfo = {
	name: "mix",
	command: ["mix", "format", "$FILE"],
	extensions: [".ex", ".exs", ".eex", ".heex", ".leex"],
	async detect(_cwd: string) {
		return (await which("mix")) !== null;
	},
};

export const ocamlformatFormatter: FormatterInfo = {
	name: "ocamlformat",
	command: ["ocamlformat", "-i", "$FILE"],
	extensions: [".ml", ".mli"],
	async detect(cwd: string) {
		const hasBinary = (await which("ocamlformat")) !== null;
		if (!hasBinary) return false;
		const configs = [".ocamlformat"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const clangFormatFormatter: FormatterInfo = {
	name: "clang-format",
	command: ["clang-format", "-i", "$FILE"],
	extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ino"],
	async detect(cwd: string) {
		const hasBinary = (await which("clang-format")) !== null;
		if (!hasBinary) return false;
		const configs = [".clang-format", "_clang-format"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const ktlintFormatter: FormatterInfo = {
	name: "ktlint",
	command: ["ktlint", "-F", "$FILE"],
	extensions: [".kt", ".kts"],
	lenientExitCode:
		"lint-autofix: `ktlint -F` autocorrects what it can and then exits 1 if " +
		"any lint error remains unfixed — the documented CLI contract (ktlint " +
		"exits nonzero whenever violations are reported, and -F does not suppress " +
		"the ones it cannot correct).",
	lenientStatuses: [1],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("ktlint");
		if (inPath) return [inPath, "-F", filePath];
		return resolveManagedSmartDefaultCommand("ktlint", filePath, ["-F"]);
	},
	async detect(_cwd: string) {
		if ((await which("ktlint")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("ktlint"));
	},
};

export const ktfmtFormatter: FormatterInfo = {
	name: "ktfmt",
	// ktfmt formats in place when given a file path (no flag needed).
	command: ["ktfmt", "$FILE"],
	extensions: [".kt", ".kts"],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("ktfmt");
		if (inPath) return [inPath, filePath];
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool("ktfmt");
		return installed ? [installed, filePath] : null;
	},
	async detect(cwd: string) {
		// Opt-in only: ktfmt becomes the formatter when the project elects it,
		// otherwise ktlint stays the Kotlin smart-default (#129).
		return hasKtfmtConfig(cwd);
	},
};

export const rubocopFormatter: FormatterInfo = {
	name: "rubocop",
	command: ["rubocop", "-a", "--no-color", "$FILE"],
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
	lenientExitCode:
		"lint-autofix: `rubocop -a` exits 1 whenever ANY offense remains after it " +
		"has already rewritten the file. Verified locally (rubocop on Ruby 3.4): a " +
		"file with an unfixable Lint/UselessAssignment exits 1, and even a " +
		"tidy file exits 1 on an unfixable Style/Documentation offense — nonzero " +
		"is the normal outcome, not a failure.",
	lenientStatuses: [1],
	async resolveCommand(filePath, cwd) {
		if (await canUseBundleExec(cwd))
			return ["bundle", "exec", "rubocop", "-a", "--no-color", filePath];
		return null;
	},
	async detect(cwd: string) {
		if (!hasRubocopConfig(cwd)) return false;
		if ((await which("rubocop")) !== null) return true;
		await tryLazyInstallFormatterTool("rubocop", cwd);
		return (await which("rubocop")) !== null;
	},
};

export const standardrbFormatter: FormatterInfo = {
	name: "standardrb",
	command: ["standardrb", "--fix", "$FILE"],
	extensions: [".rb", ".rake"],
	lenientExitCode:
		"lint-autofix: standardrb is a RuboCop wrapper and inherits its exit " +
		"contract — `--fix` exits 1 when offenses remain after the rewrite.",
	lenientStatuses: [1],
	async resolveCommand(filePath, cwd) {
		if (await canUseBundleExec(cwd))
			return ["bundle", "exec", "standardrb", "--fix", filePath];
		return null;
	},
	async detect(cwd: string) {
		if (!hasStandardrbConfig(cwd)) return false;
		return (await which("standardrb")) !== null;
	},
};

export const gleamFormatter: FormatterInfo = {
	name: "gleam",
	command: ["gleam", "format", "$FILE"],
	extensions: [".gleam"],
	async detect(cwd: string) {
		// Present if gleam.toml exists (any Gleam project)
		const found = await findUp(["gleam.toml"], cwd);
		if (found.length > 0) return (await which("gleam")) !== null;
		return false;
	},
};

export const terraformFormatter: FormatterInfo = {
	name: "terraform",
	command: ["terraform", "fmt", "$FILE"],
	extensions: [".tf", ".tfvars"],
	async detect(_cwd: string) {
		return (await which("terraform")) !== null;
	},
};

export const terragruntHclFormatter: FormatterInfo = {
	name: "terragrunt-hcl",
	command: ["terragrunt", "hcl", "fmt", "--file", "$FILE"],
	extensions: [],
	filenames: TERRAGRUNT_FILENAMES,
	// Strict (the #1337 default): verified exit 0 on a successful in-place format
	// against terragrunt v1.1.2. A binary predating the `hcl` command group exits
	// nonzero and touches nothing, which unguarded reads as "already formatted".
	async detect(_cwd: string) {
		return (await which("terragrunt")) !== null;
	},
};

export const phpCsFixerFormatter: FormatterInfo = {
	name: "php-cs-fixer",
	command: ["php-cs-fixer", "fix", "$FILE"],
	extensions: [".php"],
	async resolveCommand(filePath, cwd) {
		const vendor = await findInVendorBin("php-cs-fixer", cwd);
		if (vendor) return [vendor, "fix", filePath];
		return null;
	},
	async detect(cwd: string) {
		const vendorBin = await findInVendorBin("php-cs-fixer", cwd);
		const globalBin = await which("php-cs-fixer");
		if (!vendorBin && !globalBin) return false;
		// Only run if project has explicit config
		const configs = [".php-cs-fixer.php", ".php-cs-fixer.dist.php"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const csharpierFormatter: FormatterInfo = {
	name: "csharpier",
	// CSharpier ≥1.0 is a standalone `csharpier format <file>`; the `dotnet
	// csharpier <file>` form was removed (a bare `dotnet csharpier` now errors
	// "a dotnet-prefixed executable with this name could not be found"). Keep the
	// legacy form as a fallback for CSharpier 0.x via resolveCommand.
	command: ["csharpier", "format", "$FILE"],
	extensions: [".cs"],
	async resolveCommand(filePath, _cwd) {
		if ((await which("csharpier")) !== null) {
			return ["csharpier", "format", filePath];
		}
		// CSharpier 0.x: invoked through the dotnet driver.
		if ((await which("dotnet")) !== null) {
			const legacy = await safeSpawnAsync("dotnet", ["csharpier", "--version"], {
				timeout: 5000,
			});
			if (!legacy.error && legacy.status === 0) {
				return ["dotnet", "csharpier", filePath];
			}
		}
		return null;
	},
	async detect(_cwd: string) {
		// CSharpier ≥1.0 standalone binary …
		if ((await which("csharpier")) !== null) return true;
		// … or the legacy dotnet-driver form (CSharpier 0.x).
		if ((await which("dotnet")) === null) return false;
		const result = await safeSpawnAsync("dotnet", ["csharpier", "--version"], {
			timeout: 5000,
		});
		return !result.error && result.status === 0;
	},
};

export const fantomasFormatter: FormatterInfo = {
	name: "fantomas",
	command: ["fantomas", "$FILE"],
	extensions: [".fs", ".fsi", ".fsx"],
	async detect(_cwd: string) {
		return (await which("fantomas")) !== null;
	},
};

export const swiftformatFormatter: FormatterInfo = {
	name: "swiftformat",
	command: ["swiftformat", "$FILE"],
	extensions: [".swift"],
	async detect(_cwd: string) {
		return (await which("swiftformat")) !== null;
	},
};

export const styluaFormatter: FormatterInfo = {
	name: "stylua",
	command: ["stylua", "$FILE"],
	extensions: [".lua"],
	async detect(cwd: string) {
		if ((await which("stylua")) === null) return false;
		// Prefer explicit config but also run if binary is present in a Lua project
		const configs = ["stylua.toml", ".stylua.toml"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const ormoluFormatter: FormatterInfo = {
	name: "ormolu",
	command: ["ormolu", "--mode", "inplace", "$FILE"],
	extensions: [".hs", ".lhs"],
	async detect(_cwd: string) {
		return (await which("ormolu")) !== null;
	},
};

export const taploFormatter: FormatterInfo = {
	name: "taplo",
	command: ["taplo", "fmt", "$FILE"],
	extensions: [".toml"],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("taplo");
		if (inPath) return [inPath, "fmt", filePath];
		return resolveManagedSmartDefaultCommand("taplo", filePath, ["fmt"]);
	},
	async detect(_cwd: string) {
		if ((await which("taplo")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("taplo"));
	},
};

export const googleJavaFormatFormatter: FormatterInfo = {
	name: "google-java-format",
	command: ["google-java-format", "--replace", "$FILE"],
	extensions: [".java"],
	async detect(cwd: string) {
		if ((await which("google-java-format")) === null) return false;
		return hasGoogleJavaFormatConfig(cwd);
	},
};

export const cljfmtFormatter: FormatterInfo = {
	name: "cljfmt",
	command: ["cljfmt", "fix", "$FILE"],
	extensions: [".clj", ".cljc", ".cljs"],
	async detect(cwd: string) {
		if ((await which("cljfmt")) === null) return false;
		return hasCljfmtConfig(cwd);
	},
};

export const cmakeFormatFormatter: FormatterInfo = {
	name: "cmake-format",
	command: ["cmake-format", "-i", "$FILE"],
	extensions: [".cmake"],
	async detect(cwd: string) {
		if ((await which("cmake-format")) === null) return false;
		return hasCmakeFormatConfig(cwd);
	},
};

/**
 * The PowerShell one-liner behind `psscriptanalyzer-format`.
 *
 * #1337 audit finding: without `$ErrorActionPreference = 'Stop'`, a failing
 * `Invoke-Formatter` is a NON-TERMINATING error — pwsh still exits 0, so this
 * formatter could never report a failure through the strict seam and the #1336
 * silent-no-op class survived intact for `.ps1/.psm1/.psd1`. Verified: an
 * `Invoke-Formatter` argument-validation failure exits 0 under the old script.
 *
 * Two more defects fixed here rather than left as landmines:
 *  - the old script ran `Set-Content -Value $formatted` even when `$formatted`
 *    was `$null`, which TRUNCATES the file it was asked to format;
 *  - single-quoted interpolation broke on any path containing an apostrophe.
 * An empty/whitespace-only file exits 0 without touching anything, so "nothing
 * to format" stays a clean no-op rather than a reported failure.
 */
function psScriptAnalyzerCommand(filePath: string): string {
	// PowerShell single-quoted strings escape an apostrophe by doubling it.
	const quoted = filePath.replace(/'/g, "''");
	return [
		"$ErrorActionPreference = 'Stop'",
		`$p = '${quoted}'`,
		"$content = Get-Content -Raw -LiteralPath $p",
		"if ([string]::IsNullOrWhiteSpace($content)) { exit 0 }",
		"$formatted = Invoke-Formatter -ScriptDefinition $content",
		"if ($null -eq $formatted) { throw 'Invoke-Formatter returned no output' }",
		"Set-Content -LiteralPath $p -Value $formatted",
	].join("; ");
}

export const psscriptanalyzerFormatFormatter: FormatterInfo = {
	name: "psscriptanalyzer-format",
	command: ["pwsh", "-NoProfile", "-Command", psScriptAnalyzerCommand("$FILE")],
	extensions: [".ps1", ".psm1", ".psd1"],
	async resolveCommand(filePath, _cwd) {
		const pwsh = (await which("pwsh")) ?? (await which("powershell"));
		if (!pwsh) return null;
		return [pwsh, "-NoProfile", "-Command", psScriptAnalyzerCommand(filePath)];
	},
	async detect(_cwd: string) {
		const pwsh = (await which("pwsh")) ?? (await which("powershell"));
		if (!pwsh) return false;
		// Check PSScriptAnalyzer module is available
		const result = await safeSpawnAsync(
			pwsh,
			[
				"-NoProfile",
				"-Command",
				"Get-Module -ListAvailable PSScriptAnalyzer | Select-Object -First 1 -ExpandProperty Name",
			],
			{ timeout: 5_000 },
		);
		return (result.stdout ?? "").includes("PSScriptAnalyzer");
	},
};

// --- Registry ---

// Exported for the formatter/policy drift guard (tests/clients/
// formatter-policy-consistency.test.ts, #1135): the test cross-checks these
// definitions against tool-policy.ts's FORMATTER_POLICY_BY_EXTENSION so the two
// hand-maintained inverse mappings can never silently diverge.
export const ALL_FORMATTERS: FormatterInfo[] = [
	biomeFormatter,
	prettierFormatter,
	oxfmtFormatter,
	ruffFormatter,
	blackFormatter,
	sqlfluffFormatter,
	gofmtFormatter,
	rustfmtFormatter,
	zigFormatter,
	dartFormatter,
	shfmtFormatter,
	nixfmtFormatter,
	mixFormatter,
	ocamlformatFormatter,
	clangFormatFormatter,
	ktlintFormatter,
	ktfmtFormatter,
	terraformFormatter,
	terragruntHclFormatter,
	phpCsFixerFormatter,
	csharpierFormatter,
	fantomasFormatter,
	swiftformatFormatter,
	styluaFormatter,
	ormoluFormatter,
	rubocopFormatter,
	standardrbFormatter,
	gleamFormatter,
	taploFormatter,
	googleJavaFormatFormatter,
	cljfmtFormatter,
	cmakeFormatFormatter,
	psscriptanalyzerFormatFormatter,
];

// Basenames claimed by a filename-keyed formatter, e.g. terragrunt.hcl.
const FILENAME_FORMATTER_BASENAMES = new Set(
	ALL_FORMATTERS.flatMap((f) => f.filenames ?? []),
);

// Cache for detection results - stores array of enabled formatter names per cwd+ext
const detectionCache = new BoundedLruCache<
	string,
	{ signature: string; entries: Map<string, string[]> }
>(32);

// These are the formatter configuration files consulted by the policy helpers
// above. Their metadata is part of detection cache identity: changing a file
// must re-run detection even when PATH and installed tools are unchanged.
const FORMATTER_CONFIG_FILES = [
	"package.json", "biome.json", "biome.jsonc", ".prettierrc", ".prettierrc.json",
	".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", ".prettierrc.cjs",
	".prettierrc.mjs", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
	"prettier.config.ts", "pyproject.toml", "ruff.toml", ".ruff.toml", "black.toml",
	".black", "tox.ini", "requirements.txt", "Pipfile", ".sqlfluff", ".rubocop.yml", ".rubocop.yaml", "Gemfile", ".clang-format",
	"_clang-format", ".php-cs-fixer.php", ".php-cs-fixer.dist.php", "stylua.toml",
	".stylua.toml", ".ocamlformat", ".editorconfig", ".ktfmt", ".ktfmt.kts",
	".cljfmt.edn", "cmake-format.py", ".cmake-format.yaml", ".cmake-format.json",
	"oxfmt.toml", ".oxfmtrc.json", "vite.config.ts", "vite.config.js", "vite.config.mjs",
];

async function formatterConfigSignature(cwd: string): Promise<string> {
	const paths = await findUp(FORMATTER_CONFIG_FILES, cwd);
	const parts = await Promise.all(
		paths.sort((a, b) => a.localeCompare(b)).map(async (filePath) => {
			try {
				const stat = await fs.stat(filePath);
				return `${filePath}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return `${filePath}:missing`;
			}
		}),
	);
	return parts.join("|");
}

// --- Public API ---

export async function getFormattersForFile(
	filePath: string,
	cwd: string,
): Promise<FormatterInfo[]> {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath).toLowerCase();
	// Filename-keyed formatters (e.g. terragrunt.hcl) can share an extension
	// with unrelated files in the same dir (.terraform.lock.hcl next to
	// terragrunt.hcl). Fold the basename into the cache key only when a
	// filename-based formatter actually applies, so a plain .hcl file cached
	// first doesn't poison the cache for terragrunt.hcl/root.hcl, or vice versa.
	const normalizedCwd = normalizeMapKey(cwd);
	const cacheKey = FILENAME_FORMATTER_BASENAMES.has(base)
		? `${normalizedCwd}:${ext}:${base}`
		: `${normalizedCwd}:${ext}`;

	const configSignature = await formatterConfigSignature(cwd);
	// Check cache
	let cached = detectionCache.get(normalizedCwd);
	if (cached && cached.signature !== configSignature) {
		// An EXISTING entry whose signature moved is the user telling us the world
		// changed. Re-probe PATH too, so "install the tool, touch the config" still
		// works within one session now that a durable absence latches (#1495).
		// Scoped to a real change on purpose: keying this off "no entry yet" would
		// drop every PATH verdict on the first save in each new directory, which in
		// a monorepo means re-probing forever.
		detectionCache.delete(normalizedCwd);
		cached = undefined;
		resetWhichLatches();
	}
	if (!cached) {
		cached = { signature: configSignature, entries: new Map() };
		detectionCache.set(normalizedCwd, cached);
	}

	if (cached.entries.has(cacheKey)) {
		const enabledNames = cached.entries.get(cacheKey);
		if (!enabledNames || enabledNames.length === 0) return [];
		// Return cached formatters by name (preserves priority order)
		return ALL_FORMATTERS.filter((f) => enabledNames.includes(f.name));
	}

	// Detect formatters for this extension (or exact filename, e.g. terragrunt.hcl)
	const matching = ALL_FORMATTERS.filter(
		(f) => f.extensions.includes(ext) || f.filenames?.includes(base),
	);
	const formatterPolicy = getFormatterPolicyForFile(filePath);
	const smartDefaultFormatterName = getSmartDefaultFormatterName(filePath);

	const candidateFormatters = formatterPolicy?.formatterNames?.length
		? matching.filter((f) => formatterPolicy.formatterNames.includes(f.name))
		: matching;

	let selected: FormatterInfo | undefined;
	if (formatterPolicy) {
		const explicitlyConfigured = candidateFormatters.filter((formatter) =>
			hasExplicitFormatterConfig(formatter.name, cwd, ext),
		);
		if (explicitlyConfigured.length > 0) {
			// A formatter with explicit project config was found — use it.
			// Prefer the policy's defaultFormatter only if it has explicit config,
			// otherwise pick the first explicitly-configured formatter.
			selected = formatterPolicy.defaultFormatter
				? (explicitlyConfigured.find(
						(f) => f.name === formatterPolicy.defaultFormatter,
					) ?? explicitlyConfigured[0])
				: explicitlyConfigured[0];
		} else if (smartDefaultFormatterName) {
			// Reached only when explicitlyConfigured is empty, so no candidate
			// has explicit config. Safe to activate the smart-default.
			const smartDefaultFormatter = candidateFormatters.find(
				(f) => f.name === smartDefaultFormatterName,
			);
			if (smartDefaultFormatter) {
				const autoInstallToolId = getAutoInstallToolIdForFormatter(
					smartDefaultFormatter.name,
				);
				if (autoInstallToolId || (await smartDefaultFormatter.detect(cwd))) {
					selected = smartDefaultFormatter;
				}
			}
		}
	} else {
		for (const formatter of candidateFormatters) {
			try {
				if (await formatter.detect(cwd)) {
					selected = formatter;
					break;
				}
			} catch (err) {
				// pi-lens-ignore: missing-error-propagation — optional formatter detection, skip on failure
				logExtension({
					subsystem: "format",
					message: `Detection failed for ${formatter.name}: ${
						err instanceof Error ? err.message : String(err)
					}`,
					metadata: { formatter: formatter.name, cwd },
				});
			}
		}
	}

	const enabled = selected ? [selected] : [];
	// The #925/#1467 `wouldPoisonCache` shape: an empty result produced while a
	// PATH probe was timing out is not a finding about this project. Caching it
	// would survive until a config file's mtime or size changed, so leave the
	// cache untouched and let the next turn re-detect.
	// Which of THIS file's candidates are currently un-answered? Scoped to the
	// candidates' own binaries, so a stalled `which rustfmt` cannot stop a shell
	// or Python detection from caching (#1495 review).
	//
	// Residual: a formatter whose detection consults MORE than `command[0]` is
	// matched on that primary only, and the extras come in two shapes.
	//   * Install fallbacks — `rustfmt`→`rustup`, `csharpier`→`dotnet`. Harmless
	//     here: they are reached only after the primary already answered, so the
	//     primary is in the transient set whenever the answer was not real.
	//   * Co-equal ALTERNATIVES — psscriptanalyzer-format's `pwsh` ?? `powershell`,
	//     oxfmt's global `vp`. Neither is `command[0]`, so a stall on the
	//     alternative alone still yields an empty result this guard will cache.
	// That second shape is tracked with the degraded-selection work in #1539, and
	// `tests/clients/formatter-probe-commands.test.ts` fails if a new formatter
	// grows an extra probed binary without being accounted for.
	const stalledCandidateCommands = candidateFormatters
		.map((formatter) => formatter.command[0])
		.filter((command) => command && whichTransientCommands.has(command));
	const poisonedByTransientProbe =
		enabled.length === 0 && stalledCandidateCommands.length > 0;

	let selectionReason: string;
	if (!selected) {
		selectionReason = "none";
	} else if (!formatterPolicy) {
		selectionReason = "detect";
	} else {
		selectionReason = candidateFormatters.some((f) =>
			hasExplicitFormatterConfig(f.name, cwd, ext),
		)
			? "explicit-config"
			: "smart-default";
	}
	logLatency({
		type: "phase",
		phase: "formatter_selected",
		filePath: filePath,
		durationMs: 0,
		metadata: {
			formatter: selected?.name ?? null,
			reason: poisonedByTransientProbe ? "probe-timeout" : selectionReason,
			cwd,
			...(poisonedByTransientProbe && {
				cached: false,
				stalledProbes: stalledCandidateCommands,
			}),
		},
	});

	if (poisonedByTransientProbe) return enabled;

	// Store the list of enabled formatter names in cache
	const enabledNames = enabled.map((f) => f.name);
	cached.entries.set(cacheKey, enabledNames);
	return enabled;
}

export function clearFormatterCache(): void {
	detectionCache.clear();
	resetWhichLatches();
}

export function clearFormatterRuntimeState(): void {
	detectionCache.clear();
	resetWhichLatches();
	_lazyInstallAttempts.clear();
}

// ESC is built via fromCharCode so no raw control byte sits in the source.
const ANSI_ESCAPE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
	"g",
);
const BOX_DRAWING_GLOBAL = /[\u2500-\u257F]/g;
const HAS_BOX_DRAWING = /[\u2500-\u257F]/;

/**
 * First line of `text` that actually carries a diagnostic.
 *
 * #1337 made nonzero exits user-visible, which put whatever this returns in
 * front of the agent (`clients/pipeline.ts`) and in the end-of-turn summary
 * (`clients/runtime-agent-end.ts`) — so "first line of stderr" is no longer
 * good enough. Biome opens stderr with a decorated section rule
 * (`format ━━━━━━━━━━━`), which as an error message is pure noise.
 *
 * Skips blank lines, pure box-drawing rules, and short banner headings; strips
 * ANSI colour so the message stays readable in a plain-text surface.
 */
export function firstDiagnosticLine(text: string | undefined): string | undefined {
	for (const raw of (text ?? "").split("\n")) {
		const line = raw.replace(ANSI_ESCAPE, "").trimEnd();
		const stripped = line.replace(BOX_DRAWING_GLOBAL, "").trim();
		if (!stripped) continue;
		// "format ━━━━━━━━" is a section banner, not a diagnostic. Require a rule
		// AND a short remainder so a real one-line error containing a box
		// character is not discarded.
		if (HAS_BOX_DRAWING.test(line) && stripped.length <= 24) continue;
		return stripped.slice(0, 300);
	}
	return undefined;
}

/**
 * Resolve a formatter command without allowing the static command fallback to
 * bypass a resolver's style-preservation refusal (#1345). `null` means the
 * primary command is unavailable; the explicit sentinel means formatting is
 * forbidden for this file and must be returned before the static command is
 * materialized.
 */
async function resolveFormatterCommand(
	formatter: FormatterInfo,
	absolutePath: string,
	cwd: string,
): Promise<string[] | typeof SKIP_FORMATTING> {
	const resolved = formatter.resolveCommand
		? await formatter.resolveCommand(absolutePath, cwd)
		: null;
	if (resolved === SKIP_FORMATTING) return SKIP_FORMATTING;
	if (resolved !== null) return resolved;
	const fallback = formatter.command.map((c) => c.replace("$FILE", absolutePath));
	// Trust gate on the install-capable static fallback (#1334 S5): npx can
	// DOWNLOAD packages, so an untrusted project treats the fallback as
	// unavailable -- a skip, not a formatter failure; may converge next turn.
	if (
		fallback[0] === "npx" &&
		!assertInstallAllowed(`formatter npx fallback: ${formatter.name}`)
	) {
		// No second ledger entry here (#1366 review): assertInstallAllowed just
		// recorded the trust-refusal with this formatter's context — recording
		// formatter-skip too would count one user-visible degradation twice.
		return SKIP_FORMATTING;
	}
	return fallback;
}

export async function formatFile(
	filePath: string,
	formatter: FormatterInfo,
): Promise<FormatterResult> {
	try {
		const absolutePath = path.resolve(filePath);
		const cwd = path.dirname(absolutePath);
		const contentBefore = await fs.readFile(absolutePath, "utf-8");

		// Resolve command: prefer local (venv/vendor/node_modules) over global.
		// The shared seam must honor SKIP_FORMATTING before selecting the static
		// command, including its npx fallback (#1345).
		const cmd = await resolveFormatterCommand(formatter, absolutePath, cwd);
		if (cmd === SKIP_FORMATTING) {
			// Style-preserving refusal (#1144): no repo config and no detectable
			// indentation to pin — formatting would impose the tool's stock style.
			return { success: true, changed: false };
		}
		// Run formatter without blocking the event loop.
		const result = await safeSpawnAsync(cmd[0], cmd.slice(1), {
			timeout: 15000,
			cwd,
		});

		// Strict by default (#1337): only a formatter with a documented
		// benign-nonzero mode (`lenientExitCode`) may exit nonzero and still be
		// read as a successful run. Everything else that exits nonzero never
		// rewrote the file, and reporting {success: true, changed: false} there is
		// indistinguishable from "already formatted" — the #1336 silent no-op.
		const lenientOk =
			formatter.lenientExitCode !== undefined &&
			result.status !== null &&
			(formatter.lenientStatuses ?? []).includes(result.status);
		if (result.error || (result.status !== 0 && !lenientOk)) {
			return {
				success: false,
				changed: false,
				error:
					result.error?.message ||
					firstDiagnosticLine(result.stderr) ||
					// biome, ktlint and `mix format` report on STDOUT; without this
					// their diagnostic is discarded and the user is told only that
					// the tool "exited with status 1".
					firstDiagnosticLine(result.stdout) ||
					`${formatter.name} exited with status ${result.status}`,
			};
		}

		// Check if content changed
		const contentAfter = await fs.readFile(absolutePath, "utf-8");
		const changed = contentBefore !== contentAfter;

		return {
			success: true,
			changed,
		};
	} catch (err) {
		return {
			success: false,
			changed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function listAllFormatters(): string[] {
	return ALL_FORMATTERS.map((f) => f.name);
}
