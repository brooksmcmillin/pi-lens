/**
 * A global config file for one test scope (#4913 part D).
 *
 * A quiet flag moved off the pi double (`no-lsp`, `no-autoformat`, `lens-guard`,
 * ...) becomes its registry `configKey` in the global config
 * (`clients/lens-flag-registry.ts`). `PI_LENS_CONFIG_PATH` names that file, and
 * the loaded copy reads it while the factory runs (`index.ts`
 * `loadPiLensGlobalConfig()`), so the variable must name the file for the
 * factory and the session. `useGlobalConfig` scopes it to a describe block;
 * `withGlobalConfig` scopes it to one callback; `useConfigPath` is the bare
 * path setter for a test whose subject is the path itself.
 *
 * A flag a test is ABOUT does not come here: it moves to tier 2 (`pi-session.ts`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

/**
 * The path setter (#4937 remainder 1, round 2). Register the restore for the
 * enclosing scope and return `setConfigPath`. Call it at collection time
 * (module or `describe` body). `setConfigPath(file)` points
 * `PI_LENS_CONFIG_PATH` at `file` for the rest of the current test and writes
 * nothing, which expresses an absent file, an explicit file the test wrote, or
 * the default under a fixture HOME. `setConfigPath(file, text)` first writes
 * `text` verbatim to `file` (creating its directory), which expresses a
 * malformed config as well as a valid one. `setConfigPath(undefined)` unsets
 * the variable. The restore runs after every test of the scope and puts the
 * variable back to the value it had when this function was called, so the next
 * test starts from the harness default.
 */
export function useConfigPath(): (
	file: string | undefined,
	text?: string,
) => void {
	const saved = process.env.PI_LENS_CONFIG_PATH;
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = saved;
	});
	return (file, text) => {
		if (file === undefined) {
			delete process.env.PI_LENS_CONFIG_PATH;
			return;
		}
		if (text !== undefined) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
		process.env.PI_LENS_CONFIG_PATH = file;
	};
}

/**
 * Register the restore for the enclosing scope and return the setter. Call it
 * at collection time (module or `describe` body). Each setter call writes the
 * config to a fresh file and points `PI_LENS_CONFIG_PATH` at it for the rest of
 * the current test. The restore runs after every test of the scope and puts the
 * variable back to the value it had when this function was called, so the
 * next test starts from the harness default.
 */
export function useGlobalConfig(): (config: Record<string, unknown>) => void {
	const setConfigPath = useConfigPath();
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});
	return (config) => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-config-"),
		);
		dirs.push(dir);
		setConfigPath(path.join(dir, "config.json"), JSON.stringify(config));
	};
}

/**
 * The callback-scoped companion to `useGlobalConfig` (#4937 remainder 1).
 * Writes `config` to `file`, points `PI_LENS_CONFIG_PATH` at it for the
 * duration of `body`, and puts the variable back afterwards, also when `body`
 * throws. The caller owns `file` and its directory: the companion never deletes
 * them, so a path the callback returns stays readable after the call (the
 * release-qa row asserts it).
 */
export async function withGlobalConfig<T>(
	file: string,
	config: unknown,
	body: () => T | Promise<T>,
): Promise<T> {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config));
	const previous = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_CONFIG_PATH = file;
	try {
		return await body();
	} finally {
		if (previous === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = previous;
	}
}
