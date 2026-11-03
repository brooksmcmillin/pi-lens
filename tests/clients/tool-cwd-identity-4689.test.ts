/**
 * #4689 item 6: a marker walk and a child's cwd start at the file's PATH
 * IDENTITY, the directory the kernel opens, never at the spelling that named
 * it.
 *
 * Shape (AGENTS.md shape 1, divergent path keys): `pkg-a/src/blink.ts` is a
 * link to `pkg-b/b.ts`. Walking up from the link's spelling reaches `pkg-a`'s
 * `package.json`; walking up from the file's identity reaches `pkg-b`'s. The
 * autofix writer (`runAutofix` -> `BiomeClient.fixFileAsync`) hands the
 * spelling the agent typed to `resolveToolCwd`, so a write through the link
 * ran biome in the other package, with the other package's config, while the
 * same file written as `pkg-b/b.ts` ran it in `pkg-b`.
 *
 * Every cell builds its project from the #4689 symlinked-fixture family
 * (`createPathIdentityFixture` and `plantPackageLink`) and compares the link
 * spelling with the identity spelling of the SAME file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BiomeClient } from "../../clients/biome-client.js";
import { resolveToolCwd } from "../../clients/tool-cwd.js";
import {
	findNearestMarkerRoot,
	findNearestMarkerRootDetailed,
} from "../../clients/path-utils.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import {
	createPathIdentityFixture,
	plantPackageLink,
	setupTestEnvironment,
} from "./test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => true,
}));

interface Layout {
	repo: string;
	pkgB: string;
	link: string;
	real: string;
	dirLink: string;
	linkedLibFile: string;
	cleanup: () => void;
	skipReason?: string;
}

function layout(): Layout {
	const env = setupTestEnvironment("pi-lens-tool-cwd-identity-");
	const fx = createPathIdentityFixture(env.tmpDir);
	const pkg = plantPackageLink(fx.repo);
	// The repo is a project of its own, so a walk that does not find a package
	// marker still stops at the repo (and never at the host's home).
	fs.writeFileSync(path.join(fx.repo, "package.json"), "{}\n");
	// A project-local biome in each package, so the client keeps the project
	// cwd it was given instead of the neutral npx cwd.
	for (const dir of [pkg.pkgA, pkg.pkgB]) {
		const bin = path.join(dir, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "biome"), "#!/bin/sh\necho biome\n");
		fs.chmodSync(path.join(bin, "biome"), 0o755);
	}
	const skipReason = fx.skipReason ?? pkg.skipReason;
	return {
		repo: fx.repo,
		pkgB: pkg.pkgB,
		link: pkg.fileLink,
		real: pkg.realFile,
		dirLink: pkg.dirLink,
		linkedLibFile: path.join(pkg.dirLink, "lib.ts"),
		cleanup: env.cleanup,
		...(skipReason !== undefined && { skipReason }),
	};
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	setProjectTrustState("trusted");
});

describe("#4689 item 6: resolveToolCwd starts at the file's identity", () => {
	// RECURRENCE GUARDED: the biome and typescript cwd for a write through
	// `pkg-a/src/blink.ts` was `pkg-a`, for `pkg-b/b.ts` it was `pkg-b`
	// (#4689 audit, marker walk row): one file, two project configs.
	for (const kind of ["runner", "formatter"] as const) {
		it(`${kind}: the link spelling and the identity spelling share one cwd`, (ctx) => {
			const fx = layout();
			try {
				if (fx.skipReason) return ctx.skip(fx.skipReason);
				const options = { cwd: fx.repo, suppressTelemetry: true };
				const viaLink = resolveToolCwd(kind, "biome", fx.link, options).cwd;
				const viaReal = resolveToolCwd(kind, "biome", fx.real, options).cwd;
				expect(viaReal).toBe(fx.pkgB);
				expect(viaLink).toBe(viaReal);
			} finally {
				fx.cleanup();
			}
		});
	}

	it("a file reached through a directory link walks up from the directory's target", (ctx) => {
		// RECURRENCE GUARDED: the directory-link member of the same shape.
		// `pkg-a/lib/lib.ts` lives in `pkg-b/lib`; the marker is in `pkg-b`, so
		// the spelling's parents (`pkg-a/lib`, `pkg-a`) name the wrong package.
		const fx = layout();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const cwd = resolveToolCwd("runner", "biome", fx.linkedLibFile, {
				cwd: fx.repo,
				suppressTelemetry: true,
			}).cwd;
			expect(cwd).toBe(fx.pkgB);
		} finally {
			fx.cleanup();
		}
	});
});

describe("#4689 item 6: the marker walks start at the identity directory", () => {
	// RECURRENCE GUARDED: `findNearestMarkerRoot` and its detailed sibling
	// began at `path.resolve(startDir)`, so a directory reached through a
	// link walked up the link's parents (dead-code, cargo, tool-agreement and
	// the test runner all root their projects through them).
	it("findNearestMarkerRoot: a directory link and its target find one root", (ctx) => {
		const fx = layout();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const viaLink = findNearestMarkerRoot(fx.dirLink, ["package.json"]);
			expect(viaLink).toBe(fx.pkgB);
		} finally {
			fx.cleanup();
		}
	});

	it("findNearestMarkerRootDetailed: a directory link and its target find one root", (ctx) => {
		const fx = layout();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const walk = findNearestMarkerRootDetailed(fx.dirLink, ["package.json"], {
				markerPredicate: (markerPath) => ({
					kind: fs.existsSync(markerPath) ? "valid" : "absent",
				}),
			});
			expect(walk).toEqual({ kind: "found", root: fx.pkgB });
		} finally {
			fx.cleanup();
		}
	});
});

describe("#4689 item 6: the home ceiling holds on the identity axis", () => {
	// RECURRENCE GUARDED: starting the climb at the identity while the ceiling
	// stays a spelling. A home that is itself a link (`/home` -> `/mnt/home`)
	// then never meets the identity's parents, and the walk climbs past `$HOME`
	// into unrelated trees (the #250 runaway). `repo-alias` -> `repo` plays the
	// home; `repo/package.json` plays the marker the climb must not reach.
	function homeAsLink(): { fx: Layout; home: string; start: string } {
		const fx = layout();
		// The link lives OUTSIDE the repo's ancestors: a home spelled beside the
		// repo would sit under the same parent, and the walk stops at any
		// ancestor of the home it is given, hiding a ceiling on the wrong axis.
		const elsewhere = setupTestEnvironment("pi-lens-home-link-");
		const home = path.join(elsewhere.tmpDir, "home");
		let skipReason = fx.skipReason;
		try {
			fs.symlinkSync(fx.repo, home, "dir");
		} catch (err) {
			skipReason ??= `cannot create symlinks here: ${String(err)}`;
		}
		return {
			fx: {
				...fx,
				cleanup: () => {
					fx.cleanup();
					elsewhere.cleanup();
				},
				...(skipReason !== undefined && { skipReason }),
			},
			home,
			start: path.join(home, "src"),
		};
	}

	it("findNearestMarkerRoot: a link-spelled home stops the climb", (ctx) => {
		const { fx, home, start } = homeAsLink();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			expect(
				findNearestMarkerRoot(start, ["package.json"], { homeDir: home }),
			).toBeNull();
		} finally {
			fx.cleanup();
		}
	});

	it("findNearestMarkerRootDetailed: a link-spelled home stops the climb", (ctx) => {
		const { fx, home, start } = homeAsLink();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			expect(
				findNearestMarkerRootDetailed(start, ["package.json"], {
					homeDir: home,
					markerPredicate: (markerPath) => ({
						kind: fs.existsSync(markerPath) ? "valid" : "absent",
					}),
				}),
			).toEqual({ kind: "not-found", reason: "home-ceiling" });
		} finally {
			fx.cleanup();
		}
	});

	it("resolveToolCwd: a link-spelled home stops the climb and the file's own directory answers", (ctx) => {
		const { fx, home } = homeAsLink();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			// The marker the climb must not reach: one directory above the "home".
			fs.writeFileSync(path.join(path.dirname(fx.repo), ".gitignore"), "\n");
			const file = path.join(home, "src", "real.ts");
			const cwd = resolveToolCwd("formatter", "shfmt", file, {
				cwd: path.parse(file).root,
				homeDir: home,
				suppressTelemetry: true,
			}).cwd;
			// `shfmt` roots at `.editorconfig`/`.gitignore`, which the repo does
			// not hold; with the ceiling at the repo only the planted one above
			// it would answer, and the ceiling forbids it.
			expect(cwd).toBe(path.join(fx.repo, "src"));
		} finally {
			fx.cleanup();
		}
	});
});

describe("#4689 item 6: the autofix writer runs biome in the identity's package", () => {
	// RECURRENCE GUARDED: the production writer that still hands
	// `resolveToolCwd` a spelling. The child process is the only double; the
	// client, the seam and the fixture are production.
	async function fixCwd(file: string, sessionRoot: string): Promise<string> {
		const client = new BiomeClient();
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation(async () => ({
			status: 0,
			stdout: "2.0.0",
			stderr: "",
			output: "",
		}));
		await client.fixFileAsync(file, sessionRoot);
		const fix = safeSpawnAsync.mock.calls.find((call) =>
			(call[1] as string[]).includes("--write"),
		);
		expect(fix, "biome was spawned for the fix").toBeDefined();
		return ((fix?.[2] ?? {}) as { cwd?: string }).cwd ?? "";
	}

	it("a write through the cross-package link and a write to the file share one biome cwd", async (ctx) => {
		const fx = layout();
		try {
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const viaReal = await fixCwd(fx.real, fx.repo);
			const viaLink = await fixCwd(fx.link, fx.repo);
			expect(viaReal).toBe(fx.pkgB);
			expect(viaLink).toBe(viaReal);
		} finally {
			fx.cleanup();
		}
	});
});
