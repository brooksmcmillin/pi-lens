/**
 * #4689 item 6 (batch 7): the formatter config walk (`findUp`) climbs the start
 * directory's PATH IDENTITY, the tree the kernel opens, not the spelling it was
 * handed.
 *
 * Shape (AGENTS.md shape 1, the walk-start member): `repo/src/linked` is a link
 * to `repo/shared`. The walk for a file spelled `repo/src/linked/util.c`
 * climbed `repo/src/linked` → `repo/src` → …, so `repo/src`'s own
 * `gleam.toml` — a directory that is NOT an ancestor of the file, which lives
 * in `repo/shared` — made gleam the project's formatter, and
 * `formatterConfigSignature` took a cache key from the same wrong tree.
 * Recurrence: the #4844 remainder's 65 spelling-started walks; this is the
 * `clients/formatters.ts:870` member (rebased onto `walkUpDirs` in #4858).
 *
 * The doubles: a real executable `gleam` on `PATH` for one case (the
 * formatter's `detect()` gates on a real `which` probe, and that binary is the
 * only one this host can supply) and the real fixture filesystem. Everything
 * else — the config-first policy entry, `findUp`, `getFormatterConfigSignature`,
 * `getFormattersForFile` — is production code. `.gleam` is the extension whose
 * formatter policy (`defaultWhenUnconfigured: true`) asks `detect()`, so the
 * walk decides the answer; `.c` and `.lua` are `config-first` and never reach
 * it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearFormatterCache,
	getFormattersForFile,
} from "../../clients/formatters.js";
import {
	createPathIdentityFixture,
	setupTestEnvironment,
} from "./test-utils.js";

let env: { tmpDir: string; cleanup: () => void };
let previousPath: string | undefined;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-formatter-identity-");
	previousPath = process.env.PATH;
	clearFormatterCache();
});

afterEach(() => {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	clearFormatterCache();
	env.cleanup();
});

/** A real `gleam` on PATH: `detect()` probes it before the walk runs. */
function plantFakeGleam(): void {
	const bin = path.join(env.tmpDir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const binary = path.join(bin, "gleam");
	fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(binary, 0o755);
	process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
}

const selectedNames = async (filePath: string, cwd: string) =>
	(await getFormattersForFile(filePath, cwd)).map(
		(formatter) => formatter.name,
	);

describe("the formatter config walk climbs the path identity (#4689)", () => {
	// lane: the Linux unit shards; the Windows leg runs tests/config only, and
	// `where` does not answer a plain script the way `which` does.
	it.skipIf(process.platform === "win32")(
		"does not read a config from the link spelling's own ancestor",
		(ctx) => {
			// RECURRENCE GUARDED: `findUp` started at `startDir`, so the walk from
			// `repo/src/linked` reached `repo/src` and reported its `gleam.toml`
			// for a file that really lives in `repo/shared`.
			const fx = createPathIdentityFixture(env.tmpDir);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const spelledDir = path.join(fx.repo, "src", "linked");
			const spelledFile = path.join(spelledDir, "util.gleam");
			fs.writeFileSync(spelledFile, "pub fn main() {\n  1\n}\n");
			// The link's parent carries the only config on disk.
			fs.writeFileSync(path.join(fx.repo, "src", "gleam.toml"), 'name = "a"\n');
			plantFakeGleam();

			return selectedNames(spelledFile, spelledDir).then((names) => {
				expect(names).not.toContain("gleam");
			});
		},
	);

	// lane: the Linux unit shards (see above).
	it.skipIf(process.platform === "win32")(
		"reads the config of the directory the file really lives in",
		async (ctx) => {
			// The other direction of the same walk: the identity's own ancestor is
			// where a config legitimately applies.
			const fx = createPathIdentityFixture(env.tmpDir);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const spelledDir = path.join(fx.repo, "src", "linked");
			const spelledFile = path.join(spelledDir, "util.gleam");
			fs.writeFileSync(spelledFile, "pub fn main() {\n  1\n}\n");
			fs.writeFileSync(
				path.join(fx.repo, "shared", "gleam.toml"),
				'name = "a"\n',
			);
			plantFakeGleam();

			await expect(selectedNames(spelledFile, spelledDir)).resolves.toContain(
				"gleam",
			);
		},
	);
});
