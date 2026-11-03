/**
 * #4689 batch 10: the async identity seam (`realpathOrResolveAsync`).
 *
 * AGENTS.md shape 1 (divergent path keys) at the two callers that could not use
 * the sync seam: the host mutation queue (`clients/file-mutation-queue.ts`) and
 * the LSP workspace-edit preflight (`clients/lsp/edits.ts`). Both reached the
 * kernel only after a lexical fold, so `path.resolve` decided first: a
 * `<dir-link>/../f.ts` spelling locked (R3) or confined (R12) a path the kernel
 * never opens, and `clients/lsp/edits.ts` carried its own copy of the upward
 * walk the seam owns (R12, the net-count rule). The rule, from the issue: a
 * file's identity is the realpath of its nearest existing ancestor plus the
 * missing tail, with no lexical `..` collapse first.
 *
 * Measured (#4689 batch 10, Linux): `fs.realpathSync` returns the LEXICALLY
 * folded answer for a `link/../f.ts` spelling, while `realpathSync.native` and
 * `fs/promises.realpath` both return what the kernel opens (`uv_fs_realpath`).
 * The seam's async form is therefore the async twin of `realpathOrResolve`,
 * not of `realpathSync`.
 *
 * R13 has no behavioural cell: `confine` hands `contentFor` a path that
 * `uriToPath` already normalized to its identity, so the expected-content
 * lookup answered the producer's key before and after the change. Its
 * recurrence guard is the sweep row shrinking, not a red test — see the PR
 * body's Test assessment.
 *
 * Every cell builds its tree from the #4689 symlinked-fixture family; a host
 * that cannot create symlinks skips visibly (`ctx.skip`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	setHostFileMutationQueueLoader,
	withHostFileMutationQueue,
	withHostFileMutationQueues,
} from "../../clients/file-mutation-queue.js";
import {
	applyWorkspaceEdit,
	StaleWorkspaceEditContentError,
	validateWorkspaceEdit,
} from "../../clients/lsp/edits.js";
import {
	kernelPathIdentityAsync,
	realpathOrResolve,
	realpathOrResolveAsync,
} from "../../clients/path-utils.js";
import {
	createPathIdentityFixture,
	setupTestEnvironment,
} from "./test-utils.js";

const real = (value: string): string => fs.realpathSync.native(value);

interface Tree {
	base: string;
	repo: string;
	alias: string;
	realFile: string;
	fileLink: string;
	dirLink: string;
	/** `<repo>/src/outdir` -> `<base>/outside`: a directory link out of the repo. */
	outDirLink: string;
	outsideFile: string;
	skipReason?: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	setHostFileMutationQueueLoader(undefined);
	resetDegradationLedger();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(prefix: string): Tree {
	const env = setupTestEnvironment(`pi-lens-4689-async-${prefix}-`);
	cleanups.push(env.cleanup);
	const fx = createPathIdentityFixture(env.tmpDir);
	const outDirLink = path.join(fx.repo, "src", "outdir");
	let skipReason = fx.skipReason;
	if (skipReason === undefined) {
		try {
			fs.symlinkSync(path.join(env.tmpDir, "outside"), outDirLink, "dir");
		} catch (err) {
			skipReason = `cannot create symlinks here: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	return {
		base: env.tmpDir,
		repo: fx.repo,
		alias: fx.aliasRoot,
		realFile: fx.realFile,
		fileLink: fx.fileLink,
		dirLink: path.join(fx.repo, "src", "linked", "util.ts"),
		outDirLink,
		outsideFile: fx.outsideFile,
		...(skipReason !== undefined && { skipReason }),
	};
}

/** The same path spelled through the fixture's alias root. */
function viaAlias(t: Tree, value: string): string {
	return path.join(t.alias, path.relative(t.repo, value));
}

/** A zero-width insertion at the top of `filePath`, keyed as a bare URI. */
function textEdit(filePath: string) {
	return {
		changes: {
			[pathToFileURL(filePath).href]: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
					newText: "// touched\n",
				},
			],
		},
	};
}

/** A resource create keyed as a bare URI, the op kind a confiner sees whole. */
function createEdit(filePath: string) {
	return {
		documentChanges: [
			{
				kind: "create",
				uri: pathToFileURL(filePath).href,
				options: { overwrite: true },
			},
		],
	};
}

/**
 * A path whose identity the kernel refuses: a link that loops on itself, and a
 * link into a directory this process may not traverse. Both `lstat` as existing
 * entries, so a preflight alone still sees something to write.
 */
function plantUnresolvable(t: Tree): {
	paths: string[];
	restore: () => void;
	skipReason?: string;
} {
	const loop = path.join(t.repo, "self-loop");
	const hidden = path.join(t.repo, "hidden");
	const behind = path.join(t.repo, "behind-eacces");
	try {
		fs.symlinkSync("self-loop", loop, "file");
		fs.mkdirSync(hidden, { recursive: true });
		fs.writeFileSync(path.join(hidden, "y.ts"), "export {};\n");
		fs.symlinkSync(path.join(hidden, "y.ts"), behind, "file");
		fs.chmodSync(hidden, 0o000);
	} catch (error) {
		return {
			paths: [],
			restore: () => {},
			skipReason: `cannot plant a refused link here: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const restore = (): void => fs.chmodSync(hidden, 0o700);
	// Before the fixture's own removal: a mode-000 directory cannot be walked.
	cleanups.unshift(restore);
	const codes = [loop, behind].map((spelled) => {
		try {
			fs.realpathSync.native(spelled);
			return "answered";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code ?? "unknown";
		}
	});
	if (codes.some((code) => code !== "EACCES" && code !== "ELOOP"))
		return {
			paths: [],
			restore,
			skipReason: `this host does not refuse the traversal (measured ${codes.join(", ")})`,
		};
	return { paths: [loop, behind], restore };
}

/**
 * A spelling whose missing tail folds a `..` INTO an unreadable directory: the
 * first walk climbs all the way to `<base>/real` on absence alone, the fold then
 * names `<base>/real/locked/x.ts`, and the settle walk meets the `EACCES` the
 * first walk never reached. The flag travels from the settle walk to the
 * containment decision, so this is the only shape that pins the conjunct.
 */
function plantUnreadableSettle(t: Tree): {
	spelling: string;
	restore: () => void;
	skipReason?: string;
} {
	const realDir = path.join(t.base, "real");
	const locked = path.join(realDir, "locked");
	try {
		fs.mkdirSync(locked, { recursive: true });
		fs.chmodSync(locked, 0o000);
	} catch (error) {
		return {
			spelling: "",
			restore: () => {},
			skipReason: `cannot plant an unreadable directory here: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const restore = (): void => fs.chmodSync(locked, 0o700);
	// Before the fixture's own removal: a mode-000 directory cannot be walked.
	cleanups.unshift(restore);
	let code = "answered";
	try {
		fs.realpathSync.native(path.join(locked, "x.ts"));
	} catch (error) {
		code = (error as NodeJS.ErrnoException).code ?? "unknown";
	}
	if (code !== "EACCES")
		return {
			spelling: "",
			restore,
			skipReason: `this host does not refuse this traversal (measured ${code})`,
		};
	// Built by concatenation: `path.join` would normalize `ghost/..` away.
	return { spelling: `${realDir}/ghost/../locked/x.ts`, restore };
}

/** Enter the real multi-path writer and return the queue keys it took. */
async function queuedKeys(
	filePaths: readonly string[],
): Promise<{ keys: string[]; ran: boolean }> {
	const keys: string[] = [];
	let ran = false;
	setHostFileMutationQueueLoader(async () => ({
		withFileMutationQueue: async <T>(key: string, fn: () => Promise<T>) => {
			keys.push(key);
			return fn();
		},
	}));
	await withHostFileMutationQueues(filePaths, async () => {
		ran = true;
	});
	return { keys, ran };
}

describe("#4689 batch 10: the async identity seam", () => {
	it("the async identity answers the sync identity for a file link, a `link/..` and an alias root", async (ctx) => {
		const t = tree("seam");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const spellings = [
			t.fileLink,
			`${t.outDirLink}/../ext.ts`,
			viaAlias(t, t.realFile),
			t.dirLink,
			`${t.outDirLink}/new/deep.ts`,
		];
		expect(await Promise.all(spellings.map(realpathOrResolveAsync))).toEqual(
			spellings.map(realpathOrResolve),
		);
		// Independent oracle: the kernel's own answers, not the seam's.
		expect(await Promise.all(spellings.map(realpathOrResolveAsync))).toEqual([
			real(t.realFile),
			path.join(real(t.base), "ext.ts"),
			real(t.realFile),
			real(path.join(t.repo, "shared", "util.ts")),
			path.join(real(t.outsideFile), "..", "new", "deep.ts"),
		]);
	});

	it("the mutation queue keys a `link/../` spelling by the file the kernel opens", async (ctx) => {
		// RECURRENCE GUARDED: `withHostFileMutationQueues` keyed by
		// `realpath(path.resolve(filePath))`, so `<repo>/src/outdir/../ext.ts`
		// took `<repo>/src/ext.ts`'s queue while the writer opened
		// `<base>/ext.ts`: pi's edit of that file never serialised with this
		// writer (AGENTS.md shape 1).
		const t = tree("queue-dotdot");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const { keys, ran } = await queuedKeys([
			`${t.outDirLink}/../ext.ts`,
			path.join(t.base, "ext.ts"),
		]);
		expect(ran).toBe(true);
		expect(keys).toEqual([path.join(real(t.base), "ext.ts")]);
	});

	it("the mutation queue keys a file not created yet under an alias root by its real root", async (ctx) => {
		// RECURRENCE GUARDED: the key fell back to the caller's spelling when
		// `realpath` refused a missing file, so the alias root and the real root
		// took two queues for one file to be.
		const t = tree("queue-alias");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const { keys } = await queuedKeys([
			path.join(t.alias, "src", "new.ts"),
			path.join(t.repo, "src", "new.ts"),
		]);
		expect(keys).toEqual([path.join(real(t.repo), "src", "new.ts")]);
	});

	it("the single-file queue entry is keyed by the identity, not a folded spelling", async (ctx) => {
		// RECURRENCE GUARDED: the single-path entry handed
		// `path.resolve(filePath)` to the host queue, and pi's own key
		// derivation realpaths what it is handed, so the folded spelling locked a
		// different file than the writer opened.
		const t = tree("queue-single");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const keys: string[] = [];
		setHostFileMutationQueueLoader(async () => ({
			withFileMutationQueue: async <T>(key: string, fn: () => Promise<T>) => {
				keys.push(key);
				return fn();
			},
		}));
		await withHostFileMutationQueue(
			`${t.outDirLink}/../ext.ts`,
			async () => {},
		);
		expect(keys).toEqual([path.join(real(t.base), "ext.ts")]);
	});

	it("a workspace edit confines to the directory a `link/..` cwd opens", async (ctx) => {
		// RECURRENCE GUARDED: the confiner's root walked from
		// `path.resolve(cwd)`, so a cwd spelled `<repo>/src/outdir/..` was the
		// kernel's `<base>` but classified as `<repo>/src`, and an edit inside the
		// real workspace was refused as escaping it (AGENTS.md shape 1: a
		// `path.resolve` in front of an identity key).
		const t = tree("confine-cwd");
		if (t.skipReason) return ctx.skip(t.skipReason);
		await expect(
			validateWorkspaceEdit(
				textEdit(path.join(t.repo, "shared", "util.ts")),
				`${t.outDirLink}/..`,
			),
		).resolves.toBeUndefined();
	});

	it("a workspace edit whose cwd is an alias root still refuses a file outside the workspace", async (ctx) => {
		const t = tree("confine-alias");
		if (t.skipReason) return ctx.skip(t.skipReason);
		await expect(
			validateWorkspaceEdit(
				textEdit(path.join(t.repo, "shared", "util.ts")),
				t.alias,
			),
		).resolves.toBeUndefined();
		await expect(
			validateWorkspaceEdit(textEdit(t.outsideFile), t.alias),
		).rejects.toThrow(/escapes workspace/);
	});

	it("the stale-content guard matches the producer's identity through a file link", async (ctx) => {
		// R13: the expected-content key is the producer's path identity
		// (`captureRenameExpectedContent`, `actionable-warnings`), so the apply
		// must find it for a link-spelled and an alias-spelled text edit and
		// refuse bytes that differ. Passes before and after the change (the
		// confiner hands `contentFor` an identity either way); its recurrence
		// guard is the sweep row, which no longer admits a raw `realpath` here.
		const t = tree("expected");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const expectedContent = new Map([[real(t.realFile), "documented bytes\n"]]);
		await expect(
			applyWorkspaceEdit(textEdit(t.fileLink), t.repo, { expectedContent }),
		).rejects.toBeInstanceOf(StaleWorkspaceEditContentError);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "lsp-edit-stale-content",
				count: 1,
				latestReasons: [expect.objectContaining({ subject: real(t.realFile) })],
			}),
		]);
		expect(fs.readFileSync(t.realFile, "utf8")).toBe(
			"export const real = 1;\n",
		);
		resetDegradationLedger();
		const applied = await applyWorkspaceEdit(
			textEdit(viaAlias(t, t.realFile)),
			t.repo,
			{
				expectedContent: new Map([
					[real(t.realFile), fs.readFileSync(t.realFile, "utf8")],
				]),
			},
		);
		expect(applied.files).toEqual([real(t.realFile)]);
		expect(fs.readFileSync(t.realFile, "utf8")).toBe(
			"// touched\nexport const real = 1;\n",
		);
	});

	it("the identity is its own re-resolution when the missing tail folds a `..`", async (ctx) => {
		// RECURRENCE GUARDED (F-CR1): the missing tail was folded with `path.join`
		// and the answer returned as it stood, so a fold could promote a directory
		// link the kernel had refused to traverse into the answer
		// (`<missing>/../<dir-link>/child`) and resolving that answer again crossed
		// the link: one spelling, two keys, and a queue entry keyed by a path the
		// seam never returns.
		const t = tree("fixpoint");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const spelled = `${t.repo}/src/missing/../linked/util.ts`;
		const once = await realpathOrResolveAsync(spelled);
		expect(realpathOrResolve(spelled)).toBe(once);
		expect(realpathOrResolve(once)).toBe(once);
		expect(await realpathOrResolveAsync(once)).toBe(once);
		// The spelling's own file: the fold + settle answers the identity of the
		// path the fold names, which is the file both spellings reach.
		expect(once).toBe(real(t.dirLink));
		expect(
			await realpathOrResolveAsync(
				path.join(t.repo, "src", "linked", "util.ts"),
			),
		).toBe(once);
		// The queue enters the key the seam returns; it does not re-derive another.
		const { keys } = await queuedKeys([
			spelled,
			path.join(t.repo, "src", "linked", "util.ts"),
		]);
		expect(keys).toEqual([once]);
	});

	it("the settled identity stays unconfirmed when the fold promotes an unreadable directory", async (ctx) => {
		// RECURRENCE GUARDED (verify round 3, mutation V3 survived): the settle
		// walk's answer was reported with the FIRST walk's flag, so a fold that
		// promoted a `..` into a component the settle walk then refused (`EACCES`)
		// came back `kernelConfirmed: true` — a containment decision would prove
		// the edit lands under a name the kernel refused to give.
		const t = tree("settle-confirm");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const planted = plantUnreadableSettle(t);
		if (planted.skipReason) return ctx.skip(planted.skipReason);
		const identity = await kernelPathIdentityAsync(planted.spelling);
		expect(identity?.kernelConfirmed).toBe(false);
		// The folded name, not the first walk's answer: the promotion is real.
		expect(identity?.identity).toBe(
			path.join(real(t.base), "real", "locked", "x.ts"),
		);
		// The no-drop direction: a tail of pure absence stays confirmed, so the
		// conjunct cannot turn a legitimate missing path into a refusal.
		expect(
			(
				await kernelPathIdentityAsync(
					path.join(t.base, "real", "not-there", "y.ts"),
				)
			)?.kernelConfirmed,
		).toBe(true);
	});

	it("a workspace edit refuses a cwd the kernel will not traverse", async (ctx) => {
		// RECURRENCE GUARDED (verify round 3, mutation V8 survived): the confiner's
		// ROOT went through `realpathOrResolveAsync`, whose fallback answers a
		// spelling when a component refuses for a reason other than absence. A cwd
		// spelled through a self-looping link folded to `<base>/repo`, so the edit
		// was confined against the very root it escapes — the per-URI half was
		// mutant-red and this half was not.
		const t = tree("confine-root");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const loop = path.join(t.base, "self-loop");
		try {
			fs.symlinkSync("self-loop", loop, "file");
		} catch (error) {
			return ctx.skip(
				`cannot create a looping symlink here: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let code = "answered";
		try {
			fs.realpathSync.native(`${loop}/../repo`);
		} catch (error) {
			code = (error as NodeJS.ErrnoException).code ?? "unknown";
		}
		if (code !== "ELOOP")
			return ctx.skip(
				`this host does not refuse this traversal (measured ${code})`,
			);
		await expect(
			validateWorkspaceEdit(
				createEdit(path.join(t.repo, "new.ts")),
				`${loop}/../repo`,
			),
		).rejects.toThrow(/identity is unresolvable/);
	});

	it("a workspace edit refuses a target whose identity the kernel never named", async (ctx) => {
		// RECURRENCE GUARDED (F-CR2): the confiner replaced its own
		// `resolveExistingAncestor` — which rethrew every errno that is not
		// `ENOENT`/`ENOTDIR` — with the seam's fallback, so it proved containment
		// for a path whose real name the kernel never gave: a trust boundary
		// accepting an edit it cannot place.
		const t = tree("confine-unresolved");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const planted = plantUnresolvable(t);
		if (planted.skipReason) return ctx.skip(planted.skipReason);
		for (const target of planted.paths) {
			await expect(
				validateWorkspaceEdit(createEdit(target), t.repo),
			).rejects.toThrow(/identity is unresolvable/);
		}
		// The whole edit is refused before the write loop: nothing lands, not even
		// the op that precedes the unresolvable one.
		const before = fs.readFileSync(t.realFile, "utf8");
		await expect(
			applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "edit",
							textDocument: {
								uri: pathToFileURL(t.realFile).href,
								version: null,
							},
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "// written before the refusal\n",
								},
							],
						},
						...createEdit(planted.paths[0]).documentChanges,
					],
				},
				t.repo,
			),
		).rejects.toThrow(/identity is unresolvable/);
		expect(fs.readFileSync(t.realFile, "utf8")).toBe(before);
	});

	it("a workspace edit refuses a create through a dangling symlink (#4877)", async (ctx) => {
		const t = tree("dangling-link");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const target = path.join(t.base, "outside", "written.ts");
		const link = path.join(t.repo, "escape.ts");
		fs.symlinkSync(target, link, "file");
		await expect(
			validateWorkspaceEdit(createEdit(link), t.repo),
		).rejects.toThrow(/identity is unresolvable/);
		await expect(applyWorkspaceEdit(createEdit(link), t.repo)).rejects.toThrow(
			/identity is unresolvable/,
		);
		expect(fs.existsSync(target)).toBe(false);
		// The refusal is observable, as the ELOOP arm is (review R2-1): a
		// server-initiated applyEdit gets only a failureReason, which no
		// pi-lens monitor reads.
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "path-identity-fallback",
				latestReasons: [
					expect.objectContaining({ subject: "ENOENT-DANGLING" }),
				],
			}),
		]);
	});

	it("a workspace edit refuses a rename onto a dangling symlink (#4877)", async (ctx) => {
		// The acceptance names the rename destination too: a `newUri` through a
		// dangling link would move the file to the link's target outside the root.
		const t = tree("dangling-rename");
		if (t.skipReason) return ctx.skip(t.skipReason);
		const target = path.join(t.base, "outside", "moved.ts");
		const link = path.join(t.repo, "escape.ts");
		const source = path.join(t.repo, "source.ts");
		fs.writeFileSync(source, "export {};\n");
		fs.symlinkSync(target, link, "file");
		const edit = {
			documentChanges: [
				{
					kind: "rename",
					oldUri: pathToFileURL(source).href,
					newUri: pathToFileURL(link).href,
					options: { overwrite: true },
				},
			],
		};
		await expect(validateWorkspaceEdit(edit, t.repo)).rejects.toThrow(
			/identity is unresolvable/,
		);
		await expect(applyWorkspaceEdit(edit, t.repo)).rejects.toThrow(
			/identity is unresolvable/,
		);
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(source)).toBe(true);
	});
});
