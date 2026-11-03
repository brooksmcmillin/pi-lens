/**
 * #4689 item 6, the non-LSP half: the shared upward walk (`walkUpDirs`,
 * `findNearestContaining`, `findLocalToolConfig`) climbs the file's PATH
 * IDENTITY, and every other end of a walk (the home ceiling, a project root)
 * is compared on the axis the walk climbs.
 *
 * Shape (AGENTS.md shape 1, divergent path keys), the walk-start member: a
 * walk climbed from the spelling while the keys, the dispatch context and the
 * home it compared against were identities, or the reverse. `pkg-a/lib` is a
 * link to `pkg-b/lib` and `pkg-a/src/blink.ts` a link to `pkg-b/b.ts`; a walk
 * from either spelling reached `pkg-a`'s config for a file that is
 * `pkg-b`'s. A directory realpath does not follow a FILE link, so the walks
 * that start from a file take that file's identity.
 *
 * The walks that stay on the spelling by design (`configRootOnFileSpelling`,
 * the git checkout's `spelledRoot`, the project-local bin resolver and its
 * trust classifier) are pinned here or by their own suites (#4734, #3872).
 *
 * Every cell builds its tree from the #4689 symlinked-fixture family
 * (`createPathIdentityFixture`, `plantPackageLink`); a host that cannot create
 * symlinks skips visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCargoPackageEdition } from "../../clients/cargo-manifest.js";
import { resolveRunnerPath } from "../../clients/dispatch/runner-context.js";
import { getPackageRoot } from "../../clients/package-root.js";
import { findNearestProjectRoot } from "../../clients/startup-scan.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";
import { AUXILIARY_LSP_PROFILES } from "../../clients/dispatch/auxiliary-lsp.js";
import { configSearchDirs } from "../../clients/config-locations.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import { resolvePiLensFlagWithSource } from "../../clients/lens-config.js";
import {
	type LensFlagSpec,
	getLensFlagSpec,
} from "../../clients/lens-flag-registry.js";
import {
	findLocalBinUpwards,
	isProjectLocalBinPath,
} from "../../clients/package-manager.js";
import {
	findLocalToolConfig,
	isAtOrAboveHomeDir,
	normalizeMapKey,
} from "../../clients/path-utils.js";
import { runAutofix } from "../../clients/pipeline.js";
import {
	findNestedProjectMutationValue,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	detectPythonEnvironment,
	detectPythonTargetVersion,
} from "../../clients/python-environment.js";
import { findLocalTyposConfig } from "../../clients/typos-config.js";
import { findGoverningTsconfigDir } from "../../clients/workspace-topology.js";
import {
	createPathIdentityFixture,
	plantPackageLink,
	setupTestEnvironment,
} from "./test-utils.js";

const spawned = vi.hoisted(() => ({ cwds: [] as string[] }));
// Process boundary only: `cargo` and `dart` are not on the CI image, so their
// `--version` probes answer "installed" and the fix run records its cwd.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: async (
			command: string,
			args: string[],
			options: { cwd?: string } = {},
		) => {
			if (command !== "cargo" && command !== "dart")
				return actual.safeSpawnAsync(command, args, options);
			if (args[0] !== "--version") spawned.cwds.push(options.cwd ?? "");
			return { status: 0, stdout: `${command} 1.0`, stderr: "" };
		},
	};
});

const noAutoformat = getLensFlagSpec("no-autoformat") as LensFlagSpec;
const real = (p: string): string => fs.realpathSync.native(p);

interface Tree {
	base: string;
	repo: string;
	alias: string;
	pkgA: string;
	pkgB: string;
	fileLink: string;
	realFile: string;
	dirLink: string;
	libFile: string;
	outLink: string;
	outside: string;
	skipReason?: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	resetProjectLensConfigCache();
	resetProjectTrust();
	vi.unstubAllEnvs();
	spawned.cwds.length = 0;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(prefix: string): Tree {
	const env = setupTestEnvironment(`pi-lens-4689-walk-${prefix}-`);
	cleanups.push(env.cleanup);
	const fx = createPathIdentityFixture(env.tmpDir);
	const pkg = plantPackageLink(fx.repo);
	const skipReason = fx.skipReason ?? pkg.skipReason;
	return {
		base: env.tmpDir,
		repo: fx.repo,
		alias: fx.aliasRoot,
		pkgA: pkg.pkgA,
		pkgB: pkg.pkgB,
		fileLink: pkg.fileLink,
		realFile: pkg.realFile,
		dirLink: pkg.dirLink,
		libFile: pkg.libFile,
		outLink: fx.outLink,
		outside: path.dirname(fx.outsideFile),
		...(skipReason !== undefined && { skipReason }),
	};
}

/** The same path spelled through the alias root. */
function viaAlias(t: Tree, p: string): string {
	return path.join(t.alias, path.relative(t.repo, p));
}

function writeConfig(dir: string, value: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(value));
}

/** A file in `pkg-a/src` that is a link to the same-named file in `pkg-b`. */
function linkIntoPkgB(t: Tree, name: string, body: string): string {
	fs.writeFileSync(path.join(t.pkgB, name), body);
	const link = path.join(t.pkgA, "src", name);
	fs.symlinkSync(path.join("..", "..", "pkg-b", name), link, "file");
	return link;
}

describe("#4689 item 6: the shared walk climbs the path identity", () => {
	it("a config finder reached through a directory link finds the target package's config", (ctx) => {
		// RECURRENCE GUARDED: `walkUpDirs` started at `path.resolve(startDir)`,
		// so a start spelled through `pkg-a/lib -> pkg-b/lib` climbed `pkg-a`
		// and returned `pkg-a`'s typos config for a directory of `pkg-b`.
		const t = tree("finder");
		if (t.skipReason) return ctx.skip(t.skipReason);
		fs.writeFileSync(path.join(t.pkgA, "typos.toml"), "# a\n");
		fs.writeFileSync(path.join(t.pkgB, "typos.toml"), "# b\n");
		const expected = path.join(real(t.pkgB), "typos.toml");
		expect({
			throughLink: findLocalTyposConfig(t.dirLink),
			throughTarget: findLocalTyposConfig(path.join(t.pkgB, "lib")),
		}).toEqual({ throughLink: expected, throughTarget: expected });
	});

	it("a link-spelled session root discovers the project config above the real root", (ctx) => {
		// RECURRENCE GUARDED: `configSearchDirs` climbed the alias's parents,
		// so a session opened through `elsewhere/alias -> mono/repo` never saw
		// `mono/.pi-lens.json`, which the real spelling of the same root reads.
		const env = setupTestEnvironment("pi-lens-4689-walk-mono-");
		cleanups.push(env.cleanup);
		const mono = path.join(env.tmpDir, "mono");
		const repo = path.join(mono, "repo");
		const alias = path.join(env.tmpDir, "elsewhere", "alias");
		fs.mkdirSync(repo, { recursive: true });
		fs.mkdirSync(path.dirname(alias), { recursive: true });
		try {
			fs.symlinkSync(repo, alias, "dir");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		writeConfig(mono, { rules: { "high-complexity": { threshold: 3 } } });
		const threshold = (root: string) =>
			loadPiLensProjectConfig(root).rules["high-complexity"]?.threshold;
		expect({ real: threshold(repo), alias: threshold(alias) }).toEqual({
			real: 3,
			alias: 3,
		});
	});

	it("a write through a directory link dispatches in the target package", (ctx) => {
		// RECURRENCE GUARDED: `handleToolResult` derives the dispatch cwd with
		// `resolveLanguageRootForFile(spelling, workspace)`; a spelled walk gave
		// `pkg-a`, and `createDispatchContext` then clamped the identity's
		// `pkg-b` under it, so `ctx.cwd` (project config, the auxiliary
		// servers' blocking gate) was the other package's.
		const t = tree("dispatch-dir");
		if (t.skipReason) return ctx.skip(t.skipReason);
		fs.writeFileSync(path.join(t.pkgB, "typos.toml"), "# b\n");
		const spelled = path.join(t.dirLink, "lib.ts");
		const dispatched = createDispatchContext(
			spelled,
			resolveLanguageRootForFile(spelled, t.repo),
			{ getFlag: () => false },
			new FactStore("4689-walk"),
		);
		const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");
		expect({
			cwd: dispatched.cwd,
			typosMayBlock: typos?.allowBlocking?.(dispatched.cwd),
		}).toEqual({ cwd: real(t.pkgB), typosMayBlock: true });
	});

	it("a write through a file link dispatches in the target package", (ctx) => {
		// RECURRENCE GUARDED: the directory of a FILE link is a real directory,
		// so a start realpath alone still climbs `pkg-a/src`; the language root
		// walk takes the file's identity before it takes the directory.
		const t = tree("dispatch-file");
		if (t.skipReason) return ctx.skip(t.skipReason);
		expect({
			throughLink: resolveLanguageRootForFile(t.fileLink, t.repo),
			throughTarget: resolveLanguageRootForFile(t.realFile, t.repo),
		}).toEqual({ throughLink: real(t.pkgB), throughTarget: real(t.pkgB) });
	});

	it("a nested mutation config applies to a file reached through a file link", (ctx) => {
		// RECURRENCE GUARDED: `findNestedProjectMutationValue` climbed the
		// link's directory, so `pkg-b`'s `format.enabled: false` did not stop
		// the formatter for `pkg-b/b.ts` written as `pkg-a/src/blink.ts`.
		const t = tree("nested-file");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.pkgB, { format: { enabled: false } });
		const nested = (file: string) =>
			findNestedProjectMutationValue(noAutoformat, file, t.repo);
		expect({
			throughLink: nested(t.fileLink),
			throughTarget: nested(t.realFile),
		}).toEqual({
			throughLink: { value: false, dir: real(t.pkgB) },
			throughTarget: { value: false, dir: real(t.pkgB) },
		});
	});

	it("a nested mutation config applies under a link-spelled project root", (ctx) => {
		// RECURRENCE GUARDED: the walk's root bound compared the climbed
		// directory with the root's spelling, so a file under an alias-spelled
		// root (or the reverse) was outside the root at its first step and its
		// package's config was never read.
		const t = tree("nested-alias");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.pkgB, { format: { enabled: false } });
		expect({
			realFileAliasRoot: findNestedProjectMutationValue(
				noAutoformat,
				t.realFile,
				t.alias,
			),
			aliasFileRealRoot: findNestedProjectMutationValue(
				noAutoformat,
				viaAlias(t, t.realFile),
				t.repo,
			),
		}).toEqual({
			realFileAliasRoot: { value: false, dir: real(t.pkgB) },
			aliasFileRealRoot: { value: false, dir: real(t.pkgB) },
		});
	});

	it("a link out of the root reads no config or package from outside the root", (ctx) => {
		// RECURRENCE GUARDED: the identity start now reaches the target's
		// directory, so `repo/src/out-link.ts -> outside/ext.ts` climbs
		// `outside`. The root bound is what keeps a bounded walk from widening:
		// the nested mutation walk stops at its first step and the language root
		// falls back to the workspace, never `outside`'s package.
		const t = tree("out-link");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.outside, { format: { enabled: false } });
		fs.writeFileSync(path.join(t.outside, "package.json"), "{}\n");
		expect({
			nested: findNestedProjectMutationValue(noAutoformat, t.outLink, t.repo),
			languageRoot: resolveLanguageRootForFile(t.outLink, t.repo),
		}).toEqual({ nested: undefined, languageRoot: t.repo });
	});

	it("the root's own config keeps the project source under a link-spelled root", (ctx) => {
		// RECURRENCE GUARDED: `resolvePiLensFlagWithSource` labels a value found
		// at the project root `project` by comparing the walk's directory with
		// the root; an identity directory against an alias spelling read as a
		// nested project.
		const t = tree("nested-label");
		if (t.skipReason) return ctx.skip(t.skipReason);
		writeConfig(t.repo, { format: { enabled: false } });
		const resolved = resolvePiLensFlagWithSource(
			"no-autoformat",
			false,
			undefined,
			loadPiLensProjectConfig(t.alias),
			viaAlias(t, t.realFile),
			t.alias,
		);
		expect(resolved).toEqual({ value: true, source: "project" });
	});

	it("a python target version is read from the linked file's own project", async (ctx) => {
		// RECURRENCE GUARDED: `detectPythonTargetVersion` climbed the link's
		// directory and took `pkg-a`'s `requires-python` for a `pkg-b` module.
		const t = tree("python");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const pyproject = (v: string) =>
			`[project]\nname = "x"\nrequires-python = ">=${v}"\n`;
		fs.writeFileSync(path.join(t.pkgA, "pyproject.toml"), pyproject("3.9"));
		fs.writeFileSync(path.join(t.pkgB, "pyproject.toml"), pyproject("3.12"));
		const link = linkIntoPkgB(t, "m.py", "x = 1\n");
		const version = async (file: string) => {
			const found = await detectPythonTargetVersion(file);
			return found && `${found.major}.${found.minor}`;
		};
		expect({
			throughLink: await version(link),
			throughTarget: await version(path.join(t.pkgB, "m.py")),
		}).toEqual({ throughLink: "3.12", throughTarget: "3.12" });
	});

	it("a uv workspace member under a link-spelled root keeps its workspace environment", async (ctx) => {
		// RECURRENCE GUARDED: `detectPythonEnvironment` compares the walk's
		// nearest project with its own start (`isStartDir`); a start spelled
		// through the alias against a walk that climbs the identity never
		// matched, so the member lost the workspace `.venv`.
		const t = tree("uv");
		if (t.skipReason) return ctx.skip(t.skipReason);
		setProjectTrustState("trusted");
		fs.writeFileSync(
			path.join(t.repo, "pyproject.toml"),
			'[project]\nname = "ws"\n\n[tool.uv.workspace]\nmembers = ["pkg-b"]\n',
		);
		fs.writeFileSync(
			path.join(t.pkgB, "pyproject.toml"),
			'[project]\nname = "b"\n',
		);
		const venvBin = path.join(t.repo, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		fs.writeFileSync(path.join(venvBin, "python"), "");
		const env = await detectPythonEnvironment(viaAlias(t, t.pkgB), t.base, {
			allowAmbient: false,
		});
		expect(env?.source).toBe("uv-workspace");
	});

	const wholePackageFixers: Array<[string, string, string, string]> = [
		["cargo clippy --fix", "Cargo.toml", '[package]\nname = "x"\n', "f.rs"],
		["dart fix --apply", "pubspec.yaml", "name: x\n", "f.dart"],
	];
	it("an alias-spelled VIRTUAL_ENV inside the project is the project's own environment", async (ctx) => {
		// RECURRENCE GUARDED (#4847 review F1): the environment root became an
		// identity while the ambient containment check resolved the candidate
		// lexically, so `VIRTUAL_ENV=<alias>/.venv312` read as outside the
		// project and was dropped under `allowAmbient: false`, the pytest
		// own-install path (`test-runner-client.ts`).
		const t = tree("venv-alias");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const venvBin = path.join(t.repo, ".venv312", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		fs.writeFileSync(path.join(venvBin, "python"), "");
		vi.stubEnv("VIRTUAL_ENV", viaAlias(t, path.join(t.repo, ".venv312")));
		vi.stubEnv("CONDA_PREFIX", undefined);
		vi.stubEnv("UV_PROJECT_ENVIRONMENT", undefined);
		const source = async (root: string) =>
			(await detectPythonEnvironment(root, t.base, { allowAmbient: false }))
				?.source;
		expect({
			aliasRoot: await source(t.alias),
			realRoot: await source(t.repo),
		}).toEqual({ aliasRoot: "virtual-env", realRoot: "virtual-env" });
	});

	it.for(wholePackageFixers)(
		"%s for a linked file runs in the file's own package",
		async ([, manifest, body, name], ctx) => {
			// RECURRENCE GUARDED: `tryRustClippyFix` and `tryDartFix` found the
			// manifest from the link's directory, so the whole-package fixer
			// rewrote `pkg-a` for a `pkg-b` source written through `pkg-a/src`.
			const t = tree(manifest.replace(/\W/g, ""));
			if (t.skipReason) return ctx.skip(t.skipReason);
			fs.writeFileSync(path.join(t.pkgA, manifest), body);
			fs.writeFileSync(path.join(t.pkgB, manifest), body);
			const link = linkIntoPkgB(t, name, "main() {}\n");
			// The cwd `handleToolResult` hands the pipeline for this spelling.
			await runAutofix(
				link,
				resolveLanguageRootForFile(link, t.repo),
				() => false,
				() => {},
				{
					biomeClient: {} as never,
					ruffClient: {} as never,
					fixedThisTurn: new Set<string>(),
				},
				undefined,
				undefined,
				t.repo,
			);
			expect(spawned.cwds).toEqual([real(t.pkgB)]);
		},
	);
});

describe("#4689 item 6: a home ceiling is compared on the axis the walk climbs", () => {
	// RECURRENCE GUARDED: the walks start at an identity (the dispatch context
	// has carried one since #4712) while each compared the climbed directory
	// with the home's SPELLING. With `$HOME` a link (`home-link -> home-real`)
	// the identity walk never met the spelled home and read configs in and
	// above the real home: the #622/#625 adoption the ceiling exists to stop.
	function homeTree(ctx: { skip: (note?: string) => void }) {
		const env = setupTestEnvironment("pi-lens-4689-walk-home-");
		cleanups.push(env.cleanup);
		const homeReal = path.join(env.tmpDir, "home-real");
		const homeLink = path.join(env.tmpDir, "home-link");
		const src = path.join(homeReal, "proj", "src");
		fs.mkdirSync(src, { recursive: true });
		try {
			fs.symlinkSync(homeReal, homeLink, "dir");
		} catch (err) {
			ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		// One marker of each walk's kind at the home itself, none below it.
		fs.writeFileSync(path.join(homeReal, "typos.toml"), "");
		fs.writeFileSync(path.join(homeReal, "tsconfig.json"), "{}");
		fs.writeFileSync(
			path.join(homeReal, "pyproject.toml"),
			'[project]\nname = "h"\nrequires-python = ">=3.8"\n',
		);
		fs.writeFileSync(path.join(src, "m.py"), "x = 1\n");
		return { homeReal, homeLink, src };
	}

	/** Each row answers whether the walk reached the home or above it. */
	const rows: Array<
		[
			string,
			(start: string, home: string, homeReal: string) => Promise<boolean>,
		]
	> = [
		[
			"configSearchDirs",
			async (start, home, homeReal) =>
				configSearchDirs(start, home).some((dir) =>
					isAtOrAboveHomeDir(dir, real(homeReal)),
				),
		],
		[
			"findLocalToolConfig({ homeDir })",
			async (start, home) =>
				findLocalToolConfig(start, ["typos.toml"], { homeDir: home }) !==
				undefined,
		],
		[
			"findGoverningTsconfigDir (workspace topology)",
			async (start, home) =>
				findGoverningTsconfigDir(start, home) !== undefined,
		],
		[
			"detectPythonTargetVersion",
			async (start, home) =>
				(await detectPythonTargetVersion(path.join(start, "m.py"), home)) !==
				undefined,
		],
	];

	it.for(rows)(
		"%s stops at a link-spelled home under either start spelling",
		async ([, crossed], ctx) => {
			const { homeReal, homeLink, src } = homeTree(ctx);
			const viaLink = path.join(homeLink, path.relative(homeReal, src));
			expect({
				realStart: await crossed(src, homeLink, homeReal),
				linkStart: await crossed(viaLink, homeLink, homeReal),
			}).toEqual({ realStart: false, linkStart: false });
		},
	);

	it("a link inside the home to a folder outside it reads configs where the folder lives", (ctx) => {
		// RECURRENCE GUARDED (#4847 review F2; the maintainer kept the identity
		// ceiling on 2026-10-25): the walk climbs the link's target, so a
		// checkout linked in from outside the home reads the configs above
		// the target, the same answer its real spelling gets. A spelled
		// start would climb the home subtree and read none of them.
		const { homeReal } = homeTree(ctx);
		const other = path.join(path.dirname(homeReal), "other");
		const outside = path.join(other, "outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(other, "typos.toml"), "");
		const link = path.join(homeReal, "proj", "share");
		fs.symlinkSync(outside, link, "dir");
		const typos = (start: string) =>
			findLocalToolConfig(start, ["typos.toml"], { homeDir: homeReal });
		expect({
			viaLink: typos(link),
			viaTarget: typos(outside),
			dirs: configSearchDirs(link, homeReal),
		}).toEqual({
			viaLink: path.join(real(other), "typos.toml"),
			viaTarget: path.join(real(other), "typos.toml"),
			dirs: [real(outside), real(other)],
		});
	});

	it("a link to the home itself reads nothing the home holds", (ctx) => {
		// RECURRENCE GUARDED (#4847 review F2): a start that IS the home under
		// another name yields no directory, as the home's own spelling does.
		// On master the spelled climb read `proj/up/typos.toml`, the home's own
		// file, through the link: the adoption the ceiling exists to stop.
		const { homeReal } = homeTree(ctx);
		const up = path.join(homeReal, "proj", "up");
		fs.symlinkSync(homeReal, up, "dir");
		expect({
			viaLink: configSearchDirs(up, homeReal),
			viaHome: configSearchDirs(homeReal, homeReal),
			typos: findLocalToolConfig(up, ["typos.toml"], { homeDir: homeReal }),
		}).toEqual({ viaLink: [], viaHome: [], typos: undefined });
	});
});

describe("#4689 item 6: the project-local bin resolver and its classifier stay on the spelling", () => {
	it("a project shim spelled through a link-spelled root is still project-local", (ctx) => {
		// RECURRENCE GUARDED: the resolver and the trust classifier must climb
		// on ONE axis (#2556 trust inputs). An identity bin directory holds
		// neither the alias spelling of `node_modules/.bin/tool` nor its
		// identity (the shim's target), so `isProjectLocalBinPath` answered
		// false for the project's own binary and the trust refusal that keys on
		// it stopped applying.
		const t = tree("bins");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const bin = path.join(t.repo, "node_modules", ".bin");
		const pkg = path.join(t.repo, "node_modules", "tool");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env node\n");
		fs.symlinkSync(path.join("..", "tool", "cli.js"), path.join(bin, "tool"));
		setProjectTrustState("trusted");
		const found = findLocalBinUpwards("tool", t.alias);
		expect({
			found,
			shimIsLocal: isProjectLocalBinPath(
				path.join(t.alias, "node_modules", ".bin", "tool"),
				t.alias,
			),
			foundIsLocal:
				typeof found === "string" && isProjectLocalBinPath(found, t.alias),
		}).toEqual({
			found: path.join(t.alias, "node_modules", ".bin", "tool"),
			shimIsLocal: true,
			foundIsLocal: true,
		});
	});
});

describe("#4689 item 6, batch 6: hand-rolled walks folded onto walkUpDirs", () => {
	// Pure refactors with no new cell: `shellcheck.ts` and `vale.ts` (their
	// `cwd` is the dispatch context's / `resolveToolCwd`'s identity before the
	// walk starts, pinned by the dispatch cells above), `sg-runner.ts`
	// (`process.cwd()` is the kernel's own path) and `startup-scan.ts` (kept
	// spelled with `{ spelling: true }`, its stop rule unchanged).

	it("a Cargo workspace above a link-spelled home is still out of reach", async (ctx) => {
		// RECURRENCE GUARDED: the inherited-edition climb compared its identity
		// directory (`findNearestMarkerRoot` returns one) with the home's
		// SPELLING, so with `$HOME` a link the climb never met the home and
		// read the `[workspace.package]` of a manifest above it.
		const env = setupTestEnvironment("pi-lens-4689-walk-cargo-");
		cleanups.push(env.cleanup);
		// The link lives under a sibling directory: the workspace directory is
		// not an ancestor of its spelling, so the lexical home test cannot stop
		// the climb there by accident.
		const wsDir = path.join(env.tmpDir, "ws");
		const homeReal = path.join(wsDir, "home-real");
		const homeLink = path.join(env.tmpDir, "elsewhere", "home-link");
		fs.mkdirSync(path.dirname(homeLink), { recursive: true });
		fs.mkdirSync(wsDir, { recursive: true });
		fs.writeFileSync(
			path.join(wsDir, "Cargo.toml"),
			'[workspace]\nmembers = ["home-real/project"]\n\n[workspace.package]\nedition = "2018"\n',
		);
		const member = path.join(homeReal, "project");
		fs.mkdirSync(path.join(member, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(member, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const file = path.join(member, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");
		try {
			fs.symlinkSync(homeReal, homeLink, "dir");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		expect({
			realHome: await resolveCargoPackageEdition(file, homeReal),
			linkHome: await resolveCargoPackageEdition(file, homeLink),
		}).toEqual({ realHome: undefined, linkHome: undefined });
	});

	it("the Cargo workspace climb keeps its 64-directory cap", async () => {
		// RECURRENCE GUARDED: the fold onto `walkUpDirs` must carry the climb's
		// own depth cap (`maxDepth: 64`); without it a package nested deeper
		// than the cap reads a workspace manifest the hand-rolled loop never
		// reached.
		const env = setupTestEnvironment("pi-lens-4689-walk-cargo-depth-");
		cleanups.push(env.cleanup);
		fs.writeFileSync(
			path.join(env.tmpDir, "Cargo.toml"),
			'[workspace]\n\n[workspace.package]\nedition = "2018"\n',
		);
		const deep = path.join(env.tmpDir, ...Array<string>(70).fill("d"));
		fs.mkdirSync(path.join(deep, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(deep, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const file = path.join(deep, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");
		const beyondCap = await resolveCargoPackageEdition(file);
		// A workspace 60 directories up is inside the cap: found.
		fs.writeFileSync(
			path.join(env.tmpDir, ...Array<string>(10).fill("d"), "Cargo.toml"),
			'[workspace]\n\n[workspace.package]\nedition = "2021"\n',
		);
		expect({
			beyondCap,
			inside: await resolveCargoPackageEdition(file),
		}).toEqual({ beyondCap: undefined, inside: "2021" });
	});

	it("a relative runner path resolves against the ancestors of a link-spelled cwd's target", (ctx) => {
		// RECURRENCE GUARDED: `resolveAgainstAncestors` climbed the cwd's
		// spelling, so a tool run in `pkg-a/lib -> pkg-b/lib` that reported
		// `marker.txt` was credited to `pkg-a/marker.txt`, a file of the other
		// package; the kernel resolves the tool's `..` through `pkg-b`.
		const t = tree("runner-path");
		if (t.skipReason) return ctx.skip(t.skipReason);
		fs.writeFileSync(path.join(t.pkgA, "marker.txt"), "a\n");
		fs.writeFileSync(path.join(t.pkgB, "marker.txt"), "b\n");
		const expected = normalizeMapKey(path.join(real(t.pkgB), "marker.txt"));
		expect({
			throughLink: resolveRunnerPath(t.dirLink, "marker.txt"),
			throughTarget: resolveRunnerPath(path.join(t.pkgB, "lib"), "marker.txt"),
		}).toEqual({ throughLink: expected, throughTarget: expected });
	});

	it("the package root of a module reached through a directory link is the target's", (ctx) => {
		// RECURRENCE GUARDED: `getPackageRoot` climbed the URL's spelling, so a
		// module at `pkg-a/lib/x.js -> pkg-b/lib/x.js` rooted at `pkg-a` and
		// read the other package's rules, grammars and configs.
		const t = tree("package-root");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const url = (dir: string) => pathToFileURL(path.join(dir, "x.js")).href;
		expect({
			throughLink: getPackageRoot(url(t.dirLink)),
			throughTarget: getPackageRoot(url(path.join(t.pkgB, "lib"))),
		}).toEqual({ throughLink: real(t.pkgB), throughTarget: real(t.pkgB) });
	});

	it("the startup scan's project root climbs the spelling it was given", (ctx) => {
		// RECURRENCE GUARDED: `findNearestProjectRoot` stays on the spelling
		// (`{ spelling: true }`) because its callers compare the root with a
		// spelled home and cwd. An identity climb through `outer/app -> real/pkg`
		// answers the fixture root (`real/pkg`'s parents), not `outer`; the four
		// `startup-scan-*` suites stayed green with the option removed.
		const env = setupTestEnvironment("pi-lens-4689-walk-scan-");
		cleanups.push(env.cleanup);
		const outer = path.join(env.tmpDir, "outer");
		const sub = path.join(env.tmpDir, "real", "pkg", "sub");
		fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
		fs.mkdirSync(sub, { recursive: true });
		try {
			fs.symlinkSync(
				path.join("..", "real", "pkg"),
				path.join(outer, "app"),
				"dir",
			);
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		expect(findNearestProjectRoot(path.join(outer, "app", "sub"))).toBe(outer);
	});
});
