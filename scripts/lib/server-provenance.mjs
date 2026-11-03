// #4512 acceptance 1: what a matrix row ran. A capability change cannot be
// told apart from a server upgrade or a different install route unless the row
// records both, so the nightly writes each server's `version` and `install`
// source next to its measurements.
//
// Pure over injected facts (installer statuses, a version reader) so the
// recorded-run tests need no spawn; `readVersionFromBinary` is the one place
// that runs the server's own `--version`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scratchHomeEnv } from "./scratch-home-env.mjs";

const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;

/** First semver-ish token of a `--version` answer, or `undefined`. */
export function versionToken(output) {
	return String(output ?? "").match(VERSION_RE)?.[0];
}

/**
 * The installer tool a fixture's server runs through: its only `tools` entry.
 * A fixture that names none (native `tsc --lsp`, a fake server) or several
 * (a linter beside the server) has no unambiguous answer and records nothing,
 * which the matrix keeps as the last known value or `—`.
 */
export function serverToolId(fixture) {
	const tools = fixture?.tools ?? [];
	return tools.length === 1 ? tools[0] : undefined;
}

/** The wait for a version read when the caller names none, in ms. */
const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/**
 * Run the resolved binary's version command, bounded. A server that does not
 * know the flag and starts speaking LSP is closed by EOF on stdin; a hang is
 * killed by the timeout. Anything but a clean read is `undefined`, never a
 * guess. `args` is the tool's registered `checkArgs` (`cue` answers `version`,
 * not `--version`); `timeoutMs` is its registered verification timeout (a slow
 * server such as `bash-language-server` is allowed 20 s to answer).
 *
 * The child runs under a scratch home (the whole set, AGENTS.md shape 82):
 * `npm --version` writes `$HOME/.npm/_logs`, and the nightly's job-level
 * `PI_LENS_HOME` makes `withScratchHome()` return before pinning HOME.
 *
 * @param {string | undefined} binPath
 * @param {readonly string[]} [args]
 * @param {number} [timeoutMs]
 */
export function readVersionFromBinary(
	binPath,
	args = ["--version"],
	timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
) {
	if (!binPath) return undefined;
	let home;
	try {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-version-probe-"));
		const run = spawnSync(binPath, [...args], {
			input: "",
			encoding: "utf8",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...scratchHomeEnv(home) },
		});
		if (run.error || run.status !== 0) return undefined;
		return `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	} catch {
		return undefined;
	} finally {
		if (home) fs.rmSync(home, { recursive: true, force: true });
	}
}

/**
 * Per-lang provenance for a run: `Map<lang, { install, version? }>`. A server
 * the installer cannot find (not installed, or only an `npx` fallback) gets no
 * entry: a miss, so the matrix keeps the row's last known value.
 *
 * @param {Array<{ lang: string, tools?: string[] }>} fixtures
 * @param {{ statuses: Array<{ id: string, installed: boolean, source: string, path?: string }>, readVersion?: (status: object) => string | undefined }} facts
 */
export function collectServerProvenance(fixtures, facts) {
	const byTool = new Map(facts.statuses.map((s) => [s.id, s]));
	const out = new Map();
	for (const fx of fixtures) {
		const id = serverToolId(fx);
		const status = id ? byTool.get(id) : undefined;
		if (!status?.installed) continue;
		const version = versionToken(facts.readVersion?.(status));
		out.set(fx.lang, {
			install: status.source,
			...(version ? { version } : {}),
		});
	}
	return out;
}

/**
 * The nightly's provenance read over the installer: resolve every fixture's
 * tool once, then read `--version` for each. A tree-manifest launcher answers
 * any argument by starting a JVM (installer `verification`), so `--version` is
 * no probe there and its row records the install source alone.
 *
 * @param {Array<{ lang: string, tools?: string[] }>} fixtures
 * @param {{ TOOLS: Array<{ id: string, verification?: string, checkArgs?: string[] }>, getToolVerificationTimeout: (tool: object) => number, getAllToolStatuses: (ids: string[]) => Promise<Array<{ id: string, installed: boolean, source: string, path?: string }>> }} installer
 * @param {(binPath: string | undefined, args: readonly string[], timeoutMs: number) => string | undefined} [readVersion]
 */
export async function resolveFixtureProvenance(
	fixtures,
	installer,
	readVersion = readVersionFromBinary,
) {
	const toolById = new Map(installer.TOOLS.map((t) => [t.id, t]));
	return collectServerProvenance(fixtures, {
		statuses: await installer.getAllToolStatuses(
			fixtures.map(serverToolId).filter(Boolean),
		),
		readVersion: (status) => {
			const tool = toolById.get(status.id);
			if (tool?.verification === "tree-manifest") return undefined;
			return readVersion(
				status.path,
				tool?.checkArgs ?? ["--version"],
				tool
					? installer.getToolVerificationTimeout(tool)
					: DEFAULT_VERSION_TIMEOUT_MS,
			);
		},
	});
}
