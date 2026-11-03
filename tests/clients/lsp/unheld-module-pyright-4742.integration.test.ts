// real-home: read-only path probe for the maintainer's managed pyright (`~/.pi-lens/tools/node_modules/.bin/pyright-langserver`); the pinned home has no managed tools tree, so without the real home this suite skips on the one host that has pyright.
// flake-shape: real-process-spawn — a clean-tree HEAD move needs a real git checkout, and a closed module's stale bytes live only in a real pyright-langserver child; only its own diagnostics show whether the move reached it.
/**
 * #4742 / #4535 slice 3b: a module no server holds, changed on disk, reaches
 * the server.
 *
 * Recurrence this prevents: the head-move and bash-recovery consumers resynced
 * only the documents a server held. `core/mod.py` is imported by the open
 * `tests/test_mod.py` but is not itself open, so a `git checkout` that filled
 * it reached no server: pyright kept the placeholder's bytes and flagged every
 * attribute of the module as `is not a known attribute of module` on each
 * later edit of the importer, for the server's whole life. Every payload-level
 * assertion passed; only a real pyright shows what it kept.
 *
 * Production chain: the real `resyncHeadMove` (the hook seam), a real git
 * repository, the publisher and its subscribers, the real `LSPService`, the
 * real client and stdio wire, and a real `pyright-langserver` found through the
 * project-local `node_modules/.bin` candidate, so the case needs no managed
 * home. Skipped, with a named reason, where no `pyright-langserver` exists:
 * `PI_LENS_TEST_PYRIGHT_BIN`, then PATH, then
 * `~/.pi-lens/tools/node_modules/.bin` through `REAL_HOME` (read-only).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLSPConfig } from "../../../clients/lsp/config.js";
import { getLSPService } from "../../../clients/lsp/capabilities.js";
import { resyncHeadMove } from "../../../clients/runtime-tool-result.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { resetOpaqueMutationState } from "../../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { execFileSync } from "../../support/git-fixture-env.js";
import { REAL_HOME } from "../../support/vitest-setup.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

const PREFIX = "pi-lens-4742-unheld-pyright-";
const env = setupTestEnvironment(PREFIX);

function executableOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

function findPyright(): string | undefined {
	const override = process.env.PI_LENS_TEST_PYRIGHT_BIN;
	if (override) return fs.existsSync(override) ? override : undefined;
	const managed = path.join(
		REAL_HOME,
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
		"pyright-langserver",
	);
	return (
		executableOnPath("pyright-langserver") ??
		(fs.existsSync(managed) ? managed : undefined)
	);
}

const PYRIGHT = findPyright();
const CAN_RUN = PYRIGHT !== undefined && process.platform !== "win32";

const PLACEHOLDER = '"""placeholder"""\n';
const FILLED =
	'ACCION_NADA = "nada"\nACCION_AVISAR = "avisar"\n\n\ndef accion(i: str) -> str:\n    return ACCION_AVISAR if i == "x" else ACCION_NADA\n';
const IMPORTER =
	"from core import mod\n\n\ndef test_nada():\n    assert mod.ACCION_NADA == 'nada'\n    assert mod.accion('x') == mod.ACCION_AVISAR\n";
const UNKNOWN_ATTRIBUTE = /is not a known attribute of module "core\.mod"/;
const UNKNOWN_IMPORT = /"mod" is unknown import symbol/;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t.local",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t.local",
		},
	}).trim();
}

beforeAll(() => {
	// Host-boundary stub: a project-local server binary needs pi's trust answer.
	setProjectTrustState("trusted");
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(PREFIX, {
		beforeDrain: async () => {
			await getLSPService().shutdown();
		},
	});
	resetProjectTrust();
});

/**
 * A repository on `main` holding `base`, with a `feature` branch that writes
 * `feature` over it, a project-local pyright, and the LSP config for `root`.
 */
async function makeRepo(
	root: string,
	base: Record<string, string>,
	feature: Record<string, string>,
): Promise<void> {
	if (PYRIGHT === undefined) throw new Error("pyright unavailable");
	for (const [name, content] of Object.entries({
		"pyproject.toml": '[project]\nname = "p4742"\nversion = "0.0.0"\n',
		"core/__init__.py": "",
		"tests/test_mod.py": IMPORTER,
		...base,
	})) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), content);
	}
	const bin = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.symlinkSync(PYRIGHT, path.join(bin, "pyright-langserver"));
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.pi-lens/\n");
	git(root, "init", "-q", "-b", "main");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	git(root, "checkout", "-q", "-b", "feature");
	for (const [name, content] of Object.entries(feature)) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), content);
	}
	git(root, "add", "-A");
	git(root, "commit", "-qm", "feature");
	git(root, "checkout", "-q", "main");
	await initLSPConfig(root);
}

/**
 * The importer's diagnostics before and after `git checkout feature`, each
 * read the way the per-edit run reads them: the importer's bytes change and
 * the live primary answers. `moduleOpen` is whether any server holds the
 * module before the move.
 */
async function checkoutAndRead(
	root: string,
	key: string,
): Promise<{ before: string[]; after: string[]; moduleOpen: boolean }> {
	const service = getLSPService();
	const importer = path.join(root, "tests/test_mod.py");
	const moduleKey = normalizeMapKey(path.join(root, "core/mod.py"));
	const look = () =>
		resyncHeadMove({ root, key, trigger: "tool_call", label: "4742" });
	let edits = 0;
	const editImporter = async (): Promise<string[]> => {
		const text = `${fs.readFileSync(importer, "utf8")}# edit ${++edits}\n`;
		fs.writeFileSync(importer, text);
		const touched = await service.touchFile(importer, text, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			maxClientWaitMs: 30_000,
			maxDiagnosticsWaitMs: 30_000,
			source: "4742-test",
		});
		return (touched?.diags ?? []).map((d) => d.message);
	};
	await look(); // records HEAD; nothing moved yet
	const before = await editImporter();
	const moduleOpen = service.getOpenDocumentPaths(root).includes(moduleKey);
	git(root, "checkout", "-q", "feature");
	await look();
	return { before, after: await editImporter(), moduleOpen };
}

describe.skipIf(!CAN_RUN)(
	"a closed module changed by a HEAD move reaches a live pyright (#4742)",
	() => {
		it("clears the unknown-attribute findings on the importer after git checkout fills the module", async () => {
			resetOpaqueMutationState();
			const root = path.join(env.tmpDir, "repo");
			await makeRepo(
				root,
				{ "core/mod.py": PLACEHOLDER },
				{ "core/mod.py": FILLED },
			);

			const { before, after, moduleOpen } = await checkoutAndRead(
				root,
				`4742:${root}`,
			);

			// Precondition: the module IS the placeholder, so pyright is right to
			// flag its attributes, and the module is open on no server.
			expect(before.filter((m) => UNKNOWN_ATTRIBUTE.test(m))).toHaveLength(3);
			expect(moduleOpen).toBe(false);
			expect(fs.readFileSync(path.join(root, "core/mod.py"), "utf8")).toBe(
				FILLED,
			);
			expect(after.filter((m) => UNKNOWN_ATTRIBUTE.test(m))).toEqual([]);
		}, 120_000);

		// Recurrence: review r1 F2 on #4819. A module BORN inside the move (absent
		// on the old commit, added by the new one) reached pyright as a Changed
		// event, and pyright kept its cached failed lookup of the import: the
		// importer stayed `"mod" is unknown import symbol` for the server's life.
		// Only a Created event clears it (#4320 measured the same for a cached
		// missing import).
		it("clears the unknown-import finding on the importer after git checkout adds the module", async () => {
			resetOpaqueMutationState();
			const root = path.join(env.tmpDir, "repo-born");
			await makeRepo(root, {}, { "core/mod.py": FILLED });

			const { before, after, moduleOpen } = await checkoutAndRead(
				root,
				`4742-born:${root}`,
			);

			// Precondition: the module is absent, so the import is rightly unknown.
			expect(before.filter((m) => UNKNOWN_IMPORT.test(m))).toHaveLength(1);
			expect(moduleOpen).toBe(false);
			expect(fs.existsSync(path.join(root, "core/mod.py"))).toBe(true);
			expect(after.filter((m) => UNKNOWN_IMPORT.test(m))).toEqual([]);
		}, 120_000);
	},
);
