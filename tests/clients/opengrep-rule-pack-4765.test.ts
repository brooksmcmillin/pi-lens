/**
 * #4765: Opengrep does not download rules at spawn once pi-lens has a pack. The
 * rule file order is the repo's own rule file, then the registry pack the user's
 * own machine refreshed into its cache, then (until the first refresh lands)
 * `auto`. pi-lens ships no rules (maintainer decision 2026-10-23).
 *
 * Recurrence these cases prevent: `--config auto` made every spawn download
 * about 1074 registry rules (about 8 s online, NO findings offline, measured in
 * the issue). The expected paths below are written out here, not read back from
 * the module under test, so a resolver that returns `auto` once a pack exists,
 * or the wrong file, cannot satisfy them by agreeing with itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpengrepServer } from "../../clients/lsp/server.js";
import { resolveOpengrepConfig } from "../../clients/opengrep-config.js";
import { OpengrepClient } from "../../clients/opengrep-client.js";
import { stripPackRuleIdPrefix } from "../../clients/opengrep-rule-pack.js";
import * as safeSpawn from "../../clients/safe-spawn.js";
import { withEnv } from "../support/with-env.js";
import { pinFixtureHome, removeTempDirSync } from "./test-utils.js";

let home: string;
let restoreHome: () => void;
let restoreEnv: () => void;
let project: string;
const tempDirs: string[] = [];

beforeEach(() => {
	({ home, restore: restoreHome } = pinFixtureHome("opengrep-pack-4765"));
	// `getGlobalPiLensDir()` reads PI_LENS_HOME at call time; the cached pack
	// lives under it, so the case owns it.
	restoreEnv = withEnv({ PI_LENS_HOME: home });
	project = path.join(home, "project");
	fs.mkdirSync(project, { recursive: true });
	tempDirs.push(project);
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	restoreEnv();
	restoreHome();
	vi.restoreAllMocks();
});

/** What the refresh leaves behind: the documented cache location. */
function writeCachedPack(body = "rules:\n  - id: cached\n"): string {
	const cached = path.join(home, "rules", "opengrep-registry.yaml");
	fs.mkdirSync(path.dirname(cached), { recursive: true });
	fs.writeFileSync(cached, body);
	return cached;
}

describe("rule file order: repo file, then cached pack, then `auto`", () => {
	it("with no repo file and no cached pack, falls back to `auto` (pi-lens ships no rules)", () => {
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe("auto");
		expect(resolved.source).toBe("flag");
	});

	it("a cached pack supersedes `auto`", () => {
		const cached = writeCachedPack();
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe(cached);
		expect(resolved.configArg).toBe(
			path.join(home, "rules", "opengrep-registry.yaml"),
		);
		expect(resolved.source).toBe("pack");
	});

	it("an empty cached file is not a pack: `auto` answers", () => {
		writeCachedPack("");
		expect(resolveOpengrepConfig(project, { enabled: true }).configArg).toBe(
			"auto",
		);
	});

	it("a repo rule file wins over the cached pack", () => {
		writeCachedPack();
		const repoRules = path.join(project, ".opengrep.yml");
		fs.writeFileSync(repoRules, "rules: []\n");
		const resolved = resolveOpengrepConfig(project, { enabled: true });
		expect(resolved.configArg).toBe(repoRules);
		expect(resolved.source).toBe("local");
	});

	it("a user who types `--lens-opengrep-config auto` still gets what they asked for", () => {
		writeCachedPack();
		expect(
			resolveOpengrepConfig(project, { enabled: true, config: "auto" })
				.configArg,
		).toBe("auto");
	});
});

describe.skipIf(process.platform === "win32")(
	"the spawn the language server and the CLI scan actually make",
	() => {
		const launched: Array<{ process: { process: { kill(): boolean } } }> = [];
		let restorePath: (() => void) | undefined;

		afterEach(() => {
			for (const server of launched.splice(0)) server.process.process.kill();
			restorePath?.();
			restorePath = undefined;
		});

		/**
		 * The real `OpengrepServer.spawn` launches a real child: a PATH stub named
		 * `opengrep` that only stays alive (the process boundary). What is under
		 * test is the initialization the server hands it.
		 */
		async function spawnInitialization(): Promise<{
			scan: { configuration: string[] };
		}> {
			const stubDir = path.join(home, "stub-bin");
			fs.mkdirSync(stubDir, { recursive: true });
			const stub = path.join(stubDir, "opengrep");
			fs.writeFileSync(stub, "#!/bin/sh\nexec sleep 60\n");
			fs.chmodSync(stub, 0o755);
			restorePath ??= withEnv({
				PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
			});
			const server = await OpengrepServer.spawn(project, {
				allowInstall: false,
			});
			launched.push(server as never);
			return server?.initialization as { scan: { configuration: string[] } };
		}

		// Recurrence: #4765. `opengrepInitialization` handed `auto` to every spawn,
		// even after a refreshed pack sat in the cache.
		it("OpengrepServer.spawn initializes with `auto` only while no pack exists", async () => {
			expect((await spawnInitialization()).scan.configuration).toEqual([
				"auto",
			]);
			const cached = writeCachedPack();
			const init = await spawnInitialization();
			expect(init.scan.configuration).toEqual([cached]);
			expect(init.scan.configuration).not.toContain("auto");
		});

		it("OpengrepServer.spawn prefers a cached pack, and a repo file over it", async () => {
			const cached = writeCachedPack();
			expect((await spawnInitialization()).scan.configuration).toEqual([
				cached,
			]);
			const repoRules = path.join(project, ".semgrep.yml");
			fs.writeFileSync(repoRules, "rules: []\n");
			expect((await spawnInitialization()).scan.configuration).toEqual([
				repoRules,
			]);
		});

		// Recurrence: #4765. The CLI scan (`lens_diagnostics mode=full`) carried its
		// own `?? "auto"` fallback beside the server's.
		it("the CLI scan passes the same rule file to `opengrep scan --config`", async () => {
			const cached = writeCachedPack();
			const client = new OpengrepClient();
			client.ensureAvailable = vi.fn().mockResolvedValue(true);
			let argv: string[] = [];
			vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
				async (_command, args: string[]) => {
					argv = args;
					fs.writeFileSync(
						args[args.indexOf("--json-output") + 1] as string,
						JSON.stringify({ results: [], paths: { scanned: [] } }),
					);
					return { status: 0, stdout: "", stderr: "" };
				},
			);
			await client.scan(project);
			expect(argv[argv.indexOf("--config") + 1]).toBe(cached);
			expect(argv).not.toContain("auto");
		});
	},
);

describe("rule ids the CLI scan reports for the cached pack", () => {
	// Recurrence: #4765's first cut handed the CLI a path, and Opengrep's CLI
	// prefixes every rule id loaded from a file with that file's directory, so
	// `lens_diagnostics mode=full` showed `opengrep:home.u..pi-lens.rules.python...`
	// (an install path in a rule id, different on every machine) where `auto`
	// gave `opengrep:python.lang...`. The pair below is verbatim from
	// `opengrep scan --config <abs path>/rules/opengrep-registry.yaml` on 1.30.0.
	it("strips the config directory Opengrep 1.30.0 prefixes onto a rule id", () => {
		expect(
			stripPackRuleIdPrefix(
				"home.akis..local.share.pi-lens-orchestrator.tmp.4765-opengrep-pinned-rules.e2e-home.rules.python.lang.security.audit.eval-detected.eval-detected",
				"/home/akis/.local/share/pi-lens-orchestrator/tmp/4765-opengrep-pinned-rules/e2e-home/rules/opengrep-registry.yaml",
			),
		).toBe("python.lang.security.audit.eval-detected.eval-detected");
		expect(
			stripPackRuleIdPrefix(
				"python.lang.security.audit.eval-detected.eval-detected",
				"/home/u/.pi-lens/rules/opengrep-registry.yaml",
			),
		).toBe("python.lang.security.audit.eval-detected.eval-detected");
	});

	async function scanReporting(checkId: string) {
		const client = new OpengrepClient();
		client.ensureAvailable = vi.fn().mockResolvedValue(true);
		vi.spyOn(safeSpawn, "safeSpawnAsync").mockImplementationOnce(
			async (_command, args: string[]) => {
				fs.writeFileSync(
					args[args.indexOf("--json-output") + 1] as string,
					JSON.stringify({
						results: [
							{
								check_id: checkId,
								path: "a.py",
								start: { line: 2, col: 1 },
								end: { line: 2, col: 8 },
								extra: { message: "eval", severity: "WARNING" },
							},
						],
						errors: [],
						paths: { scanned: ["a.py"] },
					}),
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		);
		return (await client.scan(project)).findings.map((f) => f.checkId);
	}

	it("the CLI scan reports the registry-form id for a pack, and leaves a repo file's ids alone", async () => {
		// Opengrep's prefix for the cached pack: its directory, dot-joined.
		const cachedDir = path
			.dirname(writeCachedPack())
			.replace(/^\//, "")
			.replaceAll("/", ".");
		const bare = "python.lang.security.audit.eval-detected.eval-detected";
		expect(await scanReporting(`${cachedDir}.${bare}`)).toEqual([bare]);

		// A repo's own rule file keeps the ids Opengrep gives it, prefix included
		// (pre-existing behaviour users' dispositions may already key on). Two
		// spellings, because each catches a different way of losing the gate: an id
		// under the PROJECT directory reds when the strip uses the resolved config's
		// own directory, and an id under the PACK directory reds when the strip is
		// applied to every finding with the cached pack's prefix (#4780 review).
		fs.writeFileSync(path.join(project, ".opengrep.yml"), "rules: []\n");
		const projectDir = project.replace(/^\//, "").replaceAll("/", ".");
		expect(await scanReporting(`${projectDir}.repo-eval`)).toEqual([
			`${projectDir}.repo-eval`,
		]);
		expect(await scanReporting(`${cachedDir}.repo-eval`)).toEqual([
			`${cachedDir}.repo-eval`,
		]);
	});
});
