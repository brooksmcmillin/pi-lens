/**
 * #4689 item 2: the file a formatter writes is the file's identity (the real
 * path of its nearest existing ancestor plus the missing tail), never the link
 * that named it. The real FormatService, formatter selection and
 * `formatFile` run in-process; only the child process is doubled, and the
 * double behaves like Prettier (it rejects an explicit symlink argument).
 *
 * Shapes the cells guard:
 * - `AGENTS.md -> CLAUDE.md` (link inside the session, target inside): the
 *   target is formatted and nothing fails (the #4675 symptom).
 * - a link inside the session whose target is another project (fixture d1):
 *   the identity classifies as `adopted`, so nothing is written.
 * - a link inside the session whose target is a vendor path: `none`.
 * - a plain (non-link) file outside every writable root: `none`, the same
 *   refusal, because the gate decides on identity and not on the spelling.
 * - a new file under a directory link: the missing tail lands beside the
 *   directory's target, not under the link.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { FormatService } from "../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../clients/formatters.js";
import {
	getPathIdentityFallbacks,
	normalizeMapKey,
	resetPathIdentityFallbacks,
} from "../../clients/path-utils.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import {
	getTmpRootRegistry,
	registerTmpRoot,
} from "../support/tmp-root-registry.js";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => false,
}));

/** A project root a Prettier run resolves locally, with a repo config. */
function plantPrettierProject(root: string): void {
	fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/prettier": { version: "3.0.0" } },
		}),
	);
	const bin = path.join(root, "node_modules", ".bin", "prettier");
	fs.writeFileSync(bin, "mock prettier\n");
	fs.chmodSync(bin, 0o755);
	fs.writeFileSync(path.join(root, ".prettierrc"), "{}\n");
}

/** Prettier exits 2 on a symlink argument; otherwise it rewrites the file. */
function installPrettierDouble(): string[] {
	const written: string[] = [];
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
		const file = args[args.length - 1] as string;
		if (fs.lstatSync(file).isSymbolicLink()) {
			return {
				status: 2,
				stdout: "",
				stderr: `[error] Explicitly specified pattern "${path.basename(file)}" is a symbolic link.`,
			};
		}
		fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd()}\n\n`);
		written.push(fs.realpathSync(file));
		return { status: 0, stdout: "", stderr: "" };
	});
	return written;
}

describe("FormatService formats the identity of a symlinked file (#4689)", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		safeSpawnAsync.mockReset();
		clearFormatterRuntimeState();
		resetDegradationLedger();
		resetPathIdentityFallbacks();
	});

	/**
	 * The session root (a tmp fixture) and a second project root. The second
	 * sits beside the checkout, where the analysis-root seam adopts a marked
	 * project; a marked directory under the tmp root is refused outright.
	 * It cannot move to the OS tmp dir: the tmp-fixture hygiene gate requires a
	 * `pi-lens-` prefix there, and `isPiOwnedTempPath` refuses any `pi-*` entry
	 * as pi's own (`none`), so no tmp name is both admitted and adopted.
	 */
	function layout(): {
		session: string;
		outside: string;
		cleanup: () => void;
	} {
		const sessionEnv = setupTestEnvironment("pi-lens-format-identity-");
		// #4867: the "other project" must be ADOPTABLE, and an adoptable root
		// cannot sit under the tmp root (a direct tmp child is pi-owned staging,
		// `isPiOwnedTempPath`). It stays inside the checkout under the git-ignored
		// `.probe-home`, never at the checkout root itself (#4864).
		fs.mkdirSync(path.join(process.cwd(), ".probe-home"), { recursive: true });
		const outside = fs.realpathSync(
			fs.mkdtempSync(
				path.join(process.cwd(), ".probe-home", "format-identity-project-"),
			),
		);
		registerTmpRoot(getTmpRootRegistry(), outside, "registered");
		const session = fs.realpathSync(sessionEnv.tmpDir);
		plantPrettierProject(session);
		plantPrettierProject(outside);
		return {
			session,
			outside,
			cleanup: () => {
				fs.rmSync(outside, { recursive: true, force: true });
				sessionEnv.cleanup();
			},
		};
	}

	it("formats CLAUDE.md for AGENTS.md -> CLAUDE.md and reports no failure", async () => {
		const fx = layout();
		try {
			const target = path.join(fx.session, "CLAUDE.md");
			const link = path.join(fx.session, "AGENTS.md");
			fs.writeFileSync(target, "# title\n");
			fs.symlinkSync("CLAUDE.md", link);
			const written = installPrettierDouble();

			const service = new FormatService("identity-link", true);
			service.recordRead(link);
			const summary = await service.formatFile(link, {
				sessionRoot: fx.session,
			});

			expect(summary.filePath).toBe(target);
			expect(summary.allSucceeded).toBe(true);
			expect(summary.formatters).toEqual([
				expect.objectContaining({
					name: "prettier",
					success: true,
					changed: true,
					outcome: "formatted",
				}),
			]);
			expect(written).toEqual([target]);
			expect(fs.readFileSync(target, "utf8")).toBe("# title\n\n");
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		} finally {
			fx.cleanup();
		}
	});

	it("formats a new file under a directory link beside the directory's target", async () => {
		const fx = layout();
		try {
			const realDir = path.join(fx.session, "docs-real");
			fs.mkdirSync(realDir);
			fs.symlinkSync("docs-real", path.join(fx.session, "docs"));
			const viaLink = path.join(fx.session, "docs", "note.md");
			fs.writeFileSync(path.join(realDir, "note.md"), "# note\n");
			const written = installPrettierDouble();

			const service = new FormatService("identity-dir", true);
			service.recordRead(viaLink);
			const summary = await service.formatFile(viaLink, {
				sessionRoot: fx.session,
			});

			expect(summary.filePath).toBe(path.join(realDir, "note.md"));
			expect(written).toEqual([path.join(realDir, "note.md")]);
		} finally {
			fx.cleanup();
		}
	});

	it("refuses and writes nothing when the identity is another project (fixture d1)", async () => {
		const fx = layout();
		try {
			const real = path.join(fx.outside, "real.md");
			fs.writeFileSync(real, "# outside\n");
			const escape = path.join(fx.session, "escape.md");
			fs.symlinkSync(path.join(fx.outside, "real.md"), escape);
			const written = installPrettierDouble();

			const service = new FormatService("identity-d1", true);
			service.recordRead(escape);
			const summary = await service.formatFile(escape, {
				sessionRoot: fx.session,
			});

			expect(summary.formatters).toEqual([]);
			expect(summary.anyChanged).toBe(false);
			expect(written).toEqual([]);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
			expect(fs.readFileSync(real, "utf8")).toBe("# outside\n");
			const refusal = getDegradationSummary().find(
				(group) => group.kind === "adopted-root-writer-skipped",
			);
			expect(refusal?.latestReasons[0]).toMatchObject({
				subject: `${real}:format`,
			});
			expect(refusal?.latestReasons[0]?.reason).toContain("adopted");
		} finally {
			fx.cleanup();
		}
	});

	it("refuses a link whose identity is a vendor path", async () => {
		const fx = layout();
		try {
			const vendored = path.join(fx.session, "node_modules", "dep");
			fs.mkdirSync(vendored, { recursive: true });
			const real = path.join(vendored, "README.md");
			fs.writeFileSync(real, "# dep\n");
			const link = path.join(fx.session, "dep-readme.md");
			fs.symlinkSync(path.join("node_modules", "dep", "README.md"), link);
			const written = installPrettierDouble();

			const service = new FormatService("identity-none", true);
			service.recordRead(link);
			const summary = await service.formatFile(link, {
				sessionRoot: fx.session,
			});

			expect(summary.formatters).toEqual([]);
			expect(written).toEqual([]);
			expect(fs.readFileSync(real, "utf8")).toBe("# dep\n");
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "adopted-root-writer-skipped",
				)?.latestReasons[0]?.reason,
			).toContain("none");
		} finally {
			fx.cleanup();
		}
	});

	it("refuses a regular file with no project root outside the session (not a link)", async () => {
		const fx = layout();
		const strayEnv = setupTestEnvironment("pi-lens-format-identity-stray-", {
			rootMarker: false,
		});
		try {
			const stray = path.join(fs.realpathSync(strayEnv.tmpDir), "stray.md");
			fs.writeFileSync(stray, "# stray\n");
			const written = installPrettierDouble();

			const service = new FormatService("identity-stray", true);
			service.recordRead(stray);
			const summary = await service.formatFile(stray, {
				sessionRoot: fx.session,
			});

			// The refusal is the class decision on the identity, whatever the
			// spelling: a plain file outside every writable root is not written.
			expect(summary.formatters).toEqual([]);
			expect(written).toEqual([]);
			expect(fs.readFileSync(stray, "utf8")).toBe("# stray\n");
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "adopted-root-writer-skipped",
				)?.latestReasons[0]?.reason,
			).toContain("none");
		} finally {
			strayEnv.cleanup();
			fx.cleanup();
		}
	});

	it("still formats a regular in-session file", async () => {
		const fx = layout();
		try {
			const file = path.join(fx.session, "README.md");
			fs.writeFileSync(file, "# readme\n");
			const written = installPrettierDouble();

			const service = new FormatService("identity-control", true);
			service.recordRead(file);
			const summary = await service.formatFile(file, {
				sessionRoot: fx.session,
			});

			expect(summary.allSucceeded).toBe(true);
			expect(written).toEqual([file]);
		} finally {
			fx.cleanup();
		}
	});

	// #4675 F1: the identity step is `realpathOrResolve`, which answers the
	// spelling for a link loop (and tallies the errno) instead of rethrowing the
	// way the PR's own `realPathIdentity` did. Through `formatFile` after
	// `recordRead`, as `runFormatPhase` calls it, the selected Prettier row still
	// fails with `ELOOP` (as on master); nothing is written. Recurrence: an
	// `ELOOP` out of the identity step rejected `FormatService.formatFile`, so one
	// cyclic link in a session's edit set threw out of every drain that reached it.
	it("keeps a link loop non-throwing: the pipeline shape yields a failed Prettier row with an ELOOP tally", async () => {
		const fx = layout();
		try {
			fs.symlinkSync("loop-b", path.join(fx.session, "loop-a"));
			fs.symlinkSync("loop-a", path.join(fx.session, "loop-b"));
			const viaLoop = path.join(fx.session, "loop-a", "x.ts");
			const written = installPrettierDouble();

			const service = new FormatService("identity-loop", true);
			service.recordRead(viaLoop);
			const summary = await service.formatFile(viaLoop, {
				sessionRoot: fx.session,
			});

			expect(summary.filePath).toBe(viaLoop);
			expect(summary.formatters).toEqual([
				expect.objectContaining({
					name: "prettier",
					success: false,
					outcome: "failed",
					error: expect.stringContaining("ELOOP"),
				}),
			]);
			expect(written).toEqual([]);
			expect(getPathIdentityFallbacks()).toEqual([
				expect.objectContaining({ code: "ELOOP" }),
			]);
		} finally {
			fx.cleanup();
		}
	});

	// #4675 verify F-N2: `hasChanged` and `assertUnchanged` resolve the identity
	// like `recordRead` does. No in-tree caller reaches them, so this cell is the
	// only guard: a raw-path revert of either line reds it ("never read" for a link).
	it("keeps FileTime state under the link spelling (recordRead, hasChanged, assertUnchanged)", async () => {
		const fx = layout();
		try {
			const target = path.join(fx.session, "CLAUDE.md");
			const link = path.join(fx.session, "AGENTS.md");
			fs.writeFileSync(target, "# title\n");
			fs.symlinkSync("CLAUDE.md", link);

			const service = new FormatService("identity-filetime", true);
			service.recordRead(link);

			expect(service.hasChanged(target)).toBe(false);
			expect(() => service.assertUnchanged(target)).not.toThrow();
			expect(service.hasChanged(link)).toBe(false);
			expect(() => service.assertUnchanged(link)).not.toThrow();
		} finally {
			fx.cleanup();
		}
	});

	// #4689 item 3 / #4675 F2: the widget keys a row syntactically (#1020), so
	// every writer hands it the file's path identity. The pipeline records its
	// diagnostics under `normalizeMapKey(filePath)`; the formatter row for the
	// same file must land on that key, not on the link spelling the agent typed.
	// RECURRENCE GUARDED: `recordFormatter(path.resolve(filePath))` kept the
	// spelling, so a formatted link left a second, never-finished widget row
	// beside the pipeline's (one file, two records, one of them pending).
	it("records the formatter row under the identity, one row per inode", async () => {
		const fx = layout();
		try {
			const target = path.join(fx.session, "CLAUDE.md");
			const link = path.join(fx.session, "AGENTS.md");
			fs.writeFileSync(target, "# title\n");
			fs.symlinkSync("CLAUDE.md", link);
			installPrettierDouble();
			clearWidgetState();

			const service = new FormatService("identity-widget", true);
			service.recordRead(link);
			await service.formatFile(link, { sessionRoot: fx.session });
			// The pipeline's writer, at its entry (`analysePipeline`'s widget key).
			recordDiagnostics(normalizeMapKey(link), []);

			expect(getFileDiagnosticSummaries().map((s) => s.filePath)).toEqual([
				target,
			]);
		} finally {
			fx.cleanup();
		}
	});
});
