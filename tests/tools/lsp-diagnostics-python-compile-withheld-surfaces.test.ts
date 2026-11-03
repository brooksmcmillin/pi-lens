/**
 * #4638 r3 (N2): every model-facing surface that can deliver jedi's `compile`
 * row names a row the declaration withheld. Recurrence: the F6 disclosure rode
 * only the single-file, clean-batch and directory-with-findings renders, so a
 * withheld-only file beside a failed or unconfirmed one (batch and directory),
 * and the whole `mode=full` report, read as if the row had never existed and
 * the ledger was the only trace (AGENTS.md shape 10). The cells drive the
 * production tools over the shared `LSPService` double; the batch and directory
 * cases are the two the verify probed, with a missing file and an inconclusive
 * touch standing in for "another file the run could not confirm".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const DISCLOSURE =
	"1 python-jedi compile finding withheld: the project declares Python 3.14 (requires-python)";

function jediCompile() {
	return {
		severity: 1,
		message: "SyntaxError: multiple exception types must be parenthesized",
		source: "compile",
		code: "syntax",
		serverId: "python-jedi",
		range: {
			start: { line: 2, character: 8 },
			end: { line: 2, character: 20 },
		},
	};
}

let tmp: string;
let withheldFile: string;
let previousDataDir: string | undefined;

function declareRequiresPython(specifier: string): void {
	fs.writeFileSync(
		path.join(tmp, "pyproject.toml"),
		`[project]\nname = "demo"\nrequires-python = "${specifier}"\n`,
	);
}

beforeEach(() => {
	clearWidgetState();
	tmp = fs.realpathSync(setupTestEnvironment("pi-lens-4638-r3-n2-").tmpDir);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, ".data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	withheldFile = path.join(tmp, "app.py");
	fs.writeFileSync(withheldFile, "def run() -> None:\n\tpass\n");
	declareRequiresPython(">=3.14");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
	removeTempDirSync(tmp);
});

type ToolResult = {
	content: Array<{ text: string }>;
	details?: Record<string, unknown>;
};

/** `touchFile` answers the jedi row for app.py and "could not confirm" elsewhere. */
function lspTool(): ReturnType<typeof createLspDiagnosticsTool> {
	const service = makeLspServiceDouble({
		supportsLSP: vi.fn(() => true),
		touchFile: vi.fn(async (file: string) =>
			path.basename(file) === "app.py"
				? { diags: [jediCompile()] }
				: { diags: [], inconclusive: true },
		),
	});
	let writeIndex = 0;
	return createLspDiagnosticsTool(
		() => (writeIndex += 1),
		undefined,
		() => service as never,
	);
}

async function callLsp(params: Record<string, unknown>): Promise<ToolResult> {
	return (await lspTool().execute(
		"r3-n2",
		params,
		new AbortController().signal,
		null as never,
		{ cwd: tmp } as never,
	)) as ToolResult;
}

describe("a withheld-only file beside a file the run could not confirm (#4638 r3 N2)", () => {
	it("a mixed batch names the withheld row", async () => {
		const missing = path.join(tmp, "gone.py");

		const result = await callLsp({ paths: [withheldFile, missing] });
		const text = result.content.map((entry) => entry.text).join("\n");

		// The batch is not clean (one path failed), so the clean-only sentence the
		// F6 fold rode never printed.
		expect(text).toContain("File errors:");
		expect(text).not.toContain("No diagnostics found.");
		expect(text).toContain(DISCLOSURE);
		expect(text).toContain(path.join(tmp, "pyproject.toml"));
		expect(result.details?.withheldCompile).toMatchObject({ count: 1 });
	});

	it("a directory scan with an unconfirmed file names the withheld row", async () => {
		fs.writeFileSync(path.join(tmp, "other.py"), "x = 1\n");

		const result = await callLsp({ path: tmp });
		const text = result.content.map((entry) => entry.text).join("\n");

		expect(result.details?.mode).toBe("directory");
		expect(text).toContain("NOT the same as 0 diagnostics");
		expect(text).toContain(DISCLOSURE);
		expect(result.details?.withheldCompile).toMatchObject({ count: 1 });
	});

	it("a control at a declared 3.13 delivers the row and discloses nothing", async () => {
		declareRequiresPython(">=3.13");

		const result = await callLsp({
			paths: [withheldFile, path.join(tmp, "gone.py")],
		});
		const text = result.content.map((entry) => entry.text).join("\n");

		expect(text).toContain("multiple exception types");
		expect(text).not.toContain("withheld");
		expect(result.details?.withheldCompile).toBeUndefined();
	});
});

async function runFull(): Promise<ToolResult> {
	return runFullOver([withheldFile]);
}

async function runFullOver(files: string[]): Promise<ToolResult> {
	const service = makeLspServiceDouble({
		runWorkspaceDiagnostics: vi.fn(async () =>
			files.map((filePath) => ({
				filePath,
				diagnostics: [jediCompile()],
				count: 1,
			})),
		),
	});
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as never,
		() => tmp,
		() => service as never,
	);
	return (await tool.execute(
		"r3-n2-full",
		{ mode: "full" },
		new AbortController().signal,
		null as never,
		{ cwd: tmp } as never,
	)) as ToolResult;
}

describe("mode=full names a withheld row (#4638 r3 N2)", () => {
	it("says what the declaration removed when the only row is withheld", async () => {
		const result = await runFull();
		const text = result.content.map((entry) => entry.text).join("\n");

		expect(text).not.toContain("multiple exception types");
		expect(text).toContain(DISCLOSURE);
		expect(result.details?.withheldCompile).toMatchObject({ count: 1 });
	});

	it("discloses nothing at a declared 3.13, where the row is delivered", async () => {
		declareRequiresPython(">=3.13");

		const result = await runFull();
		const text = result.content.map((entry) => entry.text).join("\n");

		expect(text).toContain("multiple exception types");
		expect(text).not.toContain("withheld");
		expect(result.details?.withheldCompile).toBeUndefined();
	});
});

describe("one details shape and each project's own declaration (#4638 r4)", () => {
	const SHAPE = {
		count: 1,
		declared: expect.objectContaining({
			major: 3,
			minor: 14,
			source: "requires-python",
		}),
	};

	/** Two projects, each with its own declaration and its own `app.py`. */
	function twoProjects(): { a: string; b: string } {
		fs.rmSync(path.join(tmp, "pyproject.toml"), { force: true });
		fs.rmSync(withheldFile, { force: true });
		const dirs = { a: path.join(tmp, "a"), b: path.join(tmp, "b") };
		for (const [dir, level] of [
			[dirs.a, ">=3.14"],
			[dirs.b, ">=3.15"],
		] as const) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "pyproject.toml"),
				`[project]\nname = "demo"\nrequires-python = "${level}"\n`,
			);
			fs.writeFileSync(
				path.join(dir, "app.py"),
				"def run() -> None:\n\tpass\n",
			);
		}
		return dirs;
	}

	function expectTwoDeclarations(
		text: string,
		details: Record<string, unknown> | undefined,
		dirs: { a: string; b: string },
	): void {
		expect(text).toContain(
			"2 python-jedi compile findings withheld across 2 declarations",
		);
		expect(text).toContain(
			`1 under Python 3.14 (requires-python) in ${path.join(dirs.a, "pyproject.toml")}`,
		);
		expect(text).toContain(
			`1 under Python 3.15 (requires-python) in ${path.join(dirs.b, "pyproject.toml")}`,
		);
		// The total stays one number and the groups sum to it.
		expect(details?.withheldCompile).toMatchObject({
			count: 2,
			declarations: [
				{ count: 1, declared: { minor: 14 } },
				{ count: 1, declared: { minor: 15 } },
			],
		});
	}

	it("lsp_diagnostics carries the shared shape on a single file", async () => {
		const result = await callLsp({ path: withheldFile });

		expect(result.details?.withheldCompile).toEqual({
			...SHAPE,
			declared: expect.objectContaining({
				file: path.join(tmp, "pyproject.toml"),
			}),
		});
	});

	it("mode=full carries the same shape as lsp_diagnostics", async () => {
		const result = await runFull();

		expect(result.details?.withheldCompile).toEqual({
			...SHAPE,
			declared: expect.objectContaining({
				file: path.join(tmp, "pyproject.toml"),
			}),
		});
	});

	it("mode=full cites each project's declaration, not the first one's", async () => {
		const dirs = twoProjects();
		const result = await runFullOver([
			path.join(dirs.a, "app.py"),
			path.join(dirs.b, "app.py"),
		]);

		expectTwoDeclarations(
			result.content.map((entry) => entry.text).join("\n"),
			result.details,
			dirs,
		);
	});

	it("a directory scan cites each project's declaration", async () => {
		const dirs = twoProjects();

		const result = await callLsp({ path: tmp });

		expectTwoDeclarations(
			result.content.map((entry) => entry.text).join("\n"),
			result.details,
			dirs,
		);
	});

	it("a batch cites each project's declaration", async () => {
		const dirs = twoProjects();

		const result = await callLsp({
			paths: [path.join(dirs.a, "app.py"), path.join(dirs.b, "app.py")],
		});

		expectTwoDeclarations(
			result.content.map((entry) => entry.text).join("\n"),
			result.details,
			dirs,
		);
	});
});
