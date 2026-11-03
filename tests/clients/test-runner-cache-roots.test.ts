import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeEphemeralMapKey } from "../../clients/path-utils.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";

const tempRoots: string[] = [];

function linkAlias(root: string, alias: string): void {
	try {
		fs.symlinkSync(root, alias, "junction");
	} catch {
		fs.symlinkSync(root, alias, "dir");
	}
}

function makeUnlinkedProject(prefix: string): { root: string; alias: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const root = path.join(parent, "project");
	const alias = path.join(parent, "project-alias");
	fs.mkdirSync(root);
	tempRoots.push(parent);
	return { root, alias };
}

function makeProject(): { root: string; alias: string } {
	const { root, alias } = makeUnlinkedProject("pi-lens-2048-");
	linkAlias(root, alias);
	return { root, alias };
}

function existingWindowsAlias(root: string): string | undefined {
	const alias = root
		.replace(/[A-Za-z]/g, (letter) =>
			letter === letter.toLowerCase()
				? letter.toUpperCase()
				: letter.toLowerCase(),
		)
		.replace(/[\\/]/g, "\\");
	return alias !== root && fs.existsSync(alias) ? alias : undefined;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("TestRunnerClient project-root caches (#2048)", () => {
	it("shares availability and Vitest glob state across a real symlink", () => {
		const { root, alias } = makeProject();
		const client = new TestRunnerClient();

		// No config yet through either spelling. #2252: a miss is never
		// memoized, so this is a live check each time, not a cached latch.
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['changed/**/*.test.ts'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});

	it("re-resolves an alias first probed before its symlink existed (#2077)", () => {
		const { root, alias } = makeUnlinkedProject("pi-lens-2077-");
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		const client = new TestRunnerClient();

		// The alias does not exist yet, so canonicalization must NOT memoize
		// the fallback key it falls back to — #2077's fix is precisely that
		// this call leaves no memo entry behind for `alias`.
		expect(client.detectRunner(alias)).toBeNull();

		linkAlias(root, alias);

		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		// #2252 fix-round F1: the two assertions above pass even if the alias
		// got pinned to a WRONG (fallback) canonical key here, because a live
		// `fs.existsSync` check through the now-real symlink still finds the
		// config file regardless of which cache bucket the probe lands in —
		// #2252 stopped caching negatives, so a wrong-bucket miss just
		// re-derives the right answer instead of serving a stale wrong one.
		// Pin the ACTUAL contract (alias and root share ONE cache entry) with
		// a positive-verdict content-divergence probe: parseVitestTestGlobs
		// never re-reads a cached HIT (only re-validates the evidence path's
		// existence), so if `alias` were still keyed under the pre-symlink
		// fallback — the #2077 defect this test exists to catch — this call
		// would MISS that bucket, re-read the file fresh, and see the NEW
		// content instead of the stale cached one.
		const rootGlobs = client.parseVitestTestGlobs(root);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['changed/**/*.test.ts'] } }\n",
		);
		expect(client.parseVitestTestGlobs(alias)).toEqual(rootGlobs);
	});

	// #4689 batch 2: a cwd that does not exist yet has no realpath, so the key
	// came from its spelling and a link spelling of the same future directory
	// split from the real one. The identity of the nearest existing ancestor
	// plus the missing tail (`realpathOrResolve`) names both spellings alike.
	// Recurrence: master keys `alias/later` and `root/later` apart.
	it("keys a cwd that does not exist yet by its path identity, through either spelling (#4689)", () => {
		const { root, alias } = makeProject();
		const client = new TestRunnerClient();

		const viaAlias = client._getCanonicalProjectRootForTests(
			path.join(alias, "later"),
		);
		const viaRoot = client._getCanonicalProjectRootForTests(
			path.join(root, "later"),
		);

		expect(viaAlias).toBe(viaRoot);
		expect(viaAlias).toBe(
			normalizeEphemeralMapKey(
				path.join(fs.realpathSync.native(root), "later"),
			),
		);
	});

	// #4689 batch 2 round 2: `path.resolve` folds `..` before the identity is
	// derived, so `lnk/../pkg` (lnk -> deep/inner) keyed `parent/pkg` while the
	// kernel opens `deep/pkg`. Recurrence: #4853 F1, the same shape in the
	// coordinator, and CodeRabbit's note on this file's `canonicalFailedPath`.
	it("keys a cwd spelled with `..` after a link by the kernel's identity (#4689)", (ctx) => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4689-dd-"));
		tempRoots.push(parent);
		fs.mkdirSync(path.join(parent, "deep", "inner"), { recursive: true });
		fs.mkdirSync(path.join(parent, "deep", "pkg"));
		fs.mkdirSync(path.join(parent, "pkg"));
		// A host without symlink support must skip this cell, not fail its
		// setup: only the `..`-after-a-link reading is under test here.
		try {
			linkAlias(path.join(parent, "deep", "inner"), path.join(parent, "lnk"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}
		const client = new TestRunnerClient();

		const key = client._getCanonicalProjectRootForTests(
			// not path.join: it folds the `..` lexically, which is the defect
			[parent, "lnk", "..", "pkg"].join(path.sep),
		);

		expect(key).toBe(
			normalizeEphemeralMapKey(
				path.join(fs.realpathSync.native(parent), "deep", "pkg"),
			),
		);
	});

	// #4689 batch 2 round 3 (verify F7): dropping the `absolute` local moved
	// `resolved` from `existsSync(path.resolve(cwd))` to `existsSync(cwd)`. That
	// is a behaviour change, not a simplification: `lnk/../pkg` with `lnk`
	// missing folds to an existing `pkg`, so the folded probe counted as
	// resolved, memoized the folded key, and the link appearing later never
	// corrected it — #2077's own defect class, one level up. Recurrence: the
	// round's mutation D (`existsSync(cwd)` back to `existsSync(path.resolve(cwd))`)
	// survived every suite that touches this helper until this cell existed.
	it("re-derives a cwd whose folded spelling resolved before its link existed (#4689)", (ctx) => {
		const parent = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-4689-resolved-"),
		);
		tempRoots.push(parent);
		fs.mkdirSync(path.join(parent, "deep", "inner"), { recursive: true });
		fs.mkdirSync(path.join(parent, "deep", "pkg"));
		fs.mkdirSync(path.join(parent, "pkg"));
		const spelling = [parent, "lnk", "..", "pkg"].join(path.sep);
		const client = new TestRunnerClient();

		// `lnk` does not exist yet, so the kernel cannot open this spelling at
		// all, even though `path.resolve` folds it to the real `parent/pkg`.
		expect(client._getCanonicalProjectRootForTests(spelling)).toBe(
			normalizeEphemeralMapKey(
				path.join(fs.realpathSync.native(parent), "pkg"),
			),
		);

		try {
			linkAlias(path.join(parent, "deep", "inner"), path.join(parent, "lnk"));
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}

		// Same spelling, now through the link: the kernel opens `deep/pkg`, so
		// the memo must not serve the pre-link key.
		expect(client._getCanonicalProjectRootForTests(spelling)).toBe(
			normalizeEphemeralMapKey(
				path.join(fs.realpathSync.native(parent), "deep", "pkg"),
			),
		);
	});

	it("shares caches across a confirmed Windows separator and case alias", (ctx) => {
		const { root } = makeProject();
		const alias = existingWindowsAlias(root);
		if (!alias) {
			ctx.skip();
			return;
		}

		const client = new TestRunnerClient();
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { exclude: ['changed/**'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});
});
