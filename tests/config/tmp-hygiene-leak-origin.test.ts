import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { stripSource } from "../support/sweep-kit.js";
import { formatTmpHygieneLeakOrigin } from "../support/vitest-setup.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * #4591: the census names a leaked root but not when it appeared or what it
 * holds, so `pi-lens-4577-resolver-cqF0yk` could not be attributed to a HOME
 * writer or a `cwd` writer after it reappeared post-sweep. One bounded line per
 * leaked entry closes that: birth time (comparable to the owning file's
 * `[tmp-hygiene-sweep]` line) and the entry's first-level children.
 */
describe("tmp-hygiene leak origin record (#4591)", () => {
	it("names the entry, its birth time and its first-level children", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-");
		const leaked = path.join(env.tmpDir, "leaked-entry");
		try {
			fs.mkdirSync(path.join(leaked, "home"), { recursive: true });
			fs.mkdirSync(path.join(leaked, "workspace"));
			const born = fs.statSync(leaked).birthtimeMs;
			const line = formatTmpHygieneLeakOrigin(leaked, born + 181_000);
			expect(line.startsWith("[tmp-hygiene-origin] leaked-entry ")).toBe(true);
			expect(line).toContain("first-level children: home,workspace");
			// A filesystem that reports no creation time says so; NTFS and the
			// Linux filesystems this suite runs on report one, and both arms are
			// asserted through the same seam.
			if (born > 0) {
				expect(line).toContain("born 181000ms before this line");
				expect(line).toContain(`created at ${new Date(born).toISOString()}`);
			} else {
				expect(line).toContain("birth time unavailable");
			}
			expect(line.endsWith("\n")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("bounds the children it names and counts the rest", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-many-");
		const leaked = path.join(env.tmpDir, "many-children");
		try {
			fs.mkdirSync(leaked);
			for (const name of ["c1", "c2", "c3", "c4", "c5", "c6"])
				fs.mkdirSync(path.join(leaked, name));
			const line = formatTmpHygieneLeakOrigin(leaked);
			expect(line).toContain("first-level children: c1,c2,c3,c4 (+2 more)");
			expect(line).not.toContain("c5");
		} finally {
			env.cleanup();
		}
	});

	it("names an empty entry as holding nothing and floors a future birth time at zero", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-empty-");
		const empty = path.join(env.tmpDir, "empty-entry");
		try {
			fs.mkdirSync(empty);
			expect(formatTmpHygieneLeakOrigin(empty)).toContain(
				"first-level children: none",
			);
			// A filesystem timestamp microseconds ahead of the process clock is a
			// negative age, which reads as `born 0ms`, never as a negative one. The
			// birth time is passed explicitly so this cell drives the floor on a
			// filesystem that reports no creation time instead of failing the
			// formatter's correct "unavailable" arm (the sibling cell above takes
			// the same axis from `stat` and guards it).
			const line = formatTmpHygieneLeakOrigin(empty, 1_000, {
				birthtimeMs: 6_000,
				children: [],
			});
			expect(line).toContain("born 0ms before this line");
		} finally {
			env.cleanup();
		}
	});

	it("reports a zero birth time as unavailable, never as 1970", () => {
		// The arm a filesystem that keeps no creation time takes: `stat` answered,
		// and the birth time it answered with is 0. No filesystem on this host
		// produces it, so the facts are injected — the same explicit-input shape
		// `removeRunBackstopDirs(home)` and `unadmittedRootBackstopEntries(before)`
		// take for their own unreachable-on-this-host arms.
		const line = formatTmpHygieneLeakOrigin("/nowhere/zero-born", 1_000, {
			birthtimeMs: 0,
			children: ["home"],
		});
		expect(line).toBe(
			"[tmp-hygiene-origin] zero-born birth time unavailable (first-level children: home)\n",
		);
	});

	it("reports an entry that cannot be read instead of a fabricated birth time", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-gone-");
		const gone = path.join(env.tmpDir, "already-removed");
		try {
			const line = formatTmpHygieneLeakOrigin(gone);
			expect(line).toBe(
				`[tmp-hygiene-origin] already-removed birth time unavailable (first-level children unavailable)\n`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("records the origin before the destructive owner removes the entry", () => {
		// The runtime path cannot be driven from a test: the only caller,
		// `cleanupTmpHygiene`, sweeps the LIVE run's tmp root, so invoking it here
		// would perform this run's own cleanup and delete a sibling worker's
		// entries. The wiring is pinned as source, the shape the census suite
		// already uses for the same function's backstop call.
		// `stripSource` blanks comments and string literals first, so a comment
		// naming the call can never satisfy this and a commented-out record reds
		// (#4591 F1): the same idiom the census suite uses for the backstop call.
		const source = stripSource(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			),
		);
		const body =
			/export function cleanupTmpHygiene\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
		expect(
			body,
			"cleanupTmpHygiene is no longer declared as expected",
		).not.toBe("");
		const record = body.indexOf(
			"process.stderr.write(formatTmpHygieneLeakOrigin(entryDir))",
		);
		expect(record).toBeGreaterThan(-1);
		expect(record).toBeLessThan(body.indexOf("removeTempDirSync(entryDir)"));
	});
});
