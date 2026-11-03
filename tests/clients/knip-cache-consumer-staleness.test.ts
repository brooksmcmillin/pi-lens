// real-home: read-only PATH probe for the maintainer's managed knip (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, and the suite skips where neither that nor a PATH knip exists.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { KnipClient } from "../../clients/knip-client.js";
import { REAL_HOME } from "../support/vitest-setup.js";
import { setupTestEnvironment } from "./test-utils.js";
import { setProjectTrustState } from "../../clients/project-trust.js";

// #4530: the knip CLI under test is this checkout's own devDependency, found
// through the test runner's `node_modules/.bin` PATH entry. That entry is the
// session repository's own bytes, which a bare lookup refuses until pi trusts
// the project. This file tests the tool, not trust, so it adopts trust the way
// the maintenance hosts do; the trust rule has its own suite.
setProjectTrustState("trusted");

// End-to-end proof for #1630 against the real knip binary. knip's glob cache
// only revalidates directories that contributed a matched path, so a consumer
// added to a directory that matched nothing stays invisible and the export it
// imports keeps being reported as unused. Fixed upstream in knip 6.28.0; this
// test still guards the pi-lens side, which must stay correct on the older
// versions the managed install can resolve to.
//
// Skipped where knip is not installed. The version-independent regression is
// the glob-cache prune assertion in knip-client.test.ts, which always runs.
const probeKnip = (env?: NodeJS.ProcessEnv): boolean => {
	try {
		return (
			spawnSync("knip", ["--version"], {
				shell: process.platform === "win32",
				encoding: "utf8",
				env: env ?? process.env,
			}).status === 0
		);
	} catch {
		return false;
	}
};

// The suite redirects PI_LENS_HOME, HOME and the XDG directories to per-worker
// temp dirs (#4789), so the client's managed-tool lookup cannot see a real knip
// install. Find that install through `REAL_HOME`, a named opt-out in
// `tests/support/real-home-readers.ts`, and put its bin dir on PATH for the
// duration of the test.
const managedKnipBinDir = (() => {
	const dir = path.join(REAL_HOME, ".pi-lens", "tools", "node_modules", ".bin");
	// The directory alone is not the tool: a partial managed tree with a `.bin`
	// and no `knip` shim must skip the case, not run it and red (#4794 review F9).
	const shim = path.join(
		dir,
		process.platform === "win32" ? "knip.cmd" : "knip",
	);
	return fs.existsSync(shim) ? dir : null;
})();

const knipAvailable = probeKnip() || managedKnipBinDir !== null;

describe("knip cache consumer-import staleness (#1630)", () => {
	it.skipIf(!knipAvailable)(
		"reports no unused export after a new test imports it",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-1630-");
			const originalPath = process.env.PATH;
			try {
				if (managedKnipBinDir) {
					process.env.PATH = `${managedKnipBinDir}${path.delimiter}${originalPath ?? ""}`;
				}

				fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
				// `tests/` exists but matches nothing at cache time — the exact
				// shape knip's glob cache fails to revalidate.
				fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
				fs.writeFileSync(
					path.join(tmpDir, "package.json"),
					JSON.stringify({
						name: "knip-1630",
						version: "1.0.0",
						private: true,
						type: "module",
					}),
				);
				fs.writeFileSync(
					path.join(tmpDir, "knip.json"),
					JSON.stringify({
						entry: ["src/index.ts", "tests/**/*.test.ts"],
						project: ["src/**/*.ts", "tests/**/*.ts"],
					}),
				);
				fs.writeFileSync(
					path.join(tmpDir, "src", "util.ts"),
					"export function assertSafeForCmdShell(s: string): string { return s; }\n" +
						'export function used(): string { return "x"; }\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, "src", "index.ts"),
					'import { used } from "./util.js";\nconsole.log(used());\n',
				);

				const cacheLocation = path.join(
					getProjectDataDir(tmpDir),
					"cache",
					"knip",
				);
				fs.rmSync(cacheLocation, { recursive: true, force: true });

				const client = new KnipClient(false);

				const first = await client.analyze(tmpDir);
				expect(first.success).toBe(true);
				// Baseline: with no consumer, knip flags the export.
				expect(first.unusedExports.map((e) => e.name)).toContain(
					"assertSafeForCmdShell",
				);
				expect(fs.existsSync(cacheLocation)).toBe(true);

				fs.writeFileSync(
					path.join(tmpDir, "tests", "consumer.test.ts"),
					'import { assertSafeForCmdShell } from "../src/util.js";\n' +
						'export const t = assertSafeForCmdShell("a");\n',
				);

				const second = await client.analyze(tmpDir);
				expect(second.success).toBe(true);
				expect(second.unusedExports.map((e) => e.name)).not.toContain(
					"assertSafeForCmdShell",
				);
			} finally {
				process.env.PATH = originalPath;
				cleanup();
			}
		},
		120_000,
	);
});
