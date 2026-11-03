// flake-shape: in-process-mock — the declaration owner is wrapped, not replaced:
// every other export stays the real one, and the wrapper exists only to count
// which files the edit path actually walks (#4638 review F10).
/**
 * #4638 review (F10): the edit path must not walk a file's declared syntax level
 * unless that file carries one of jedi's `compile` rows. The spy counts the
 * owner's calls per file through a real `mode=full` run, so a regression to
 * "resolve everything" reds here rather than costing invisible I/O.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const walked = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock("../../clients/python-environment.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/python-environment.js")
		>();
	return {
		...actual,
		detectPythonTargetVersion: vi.fn(async (filePath: string) => {
			walked.files.push(filePath);
			return actual.detectPythonTargetVersion(filePath);
		}),
	};
});

import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

const COMPILE_MESSAGE =
	"SyntaxError: multiple exception types must be parenthesized";
const PYRIGHT_MESSAGE = 'Cannot access attribute "value" for class "object"';

function row(serverId: string, source: string, message: string) {
	return {
		severity: 1,
		message,
		source,
		serverId,
		range: {
			start: { line: 1, character: 0 },
			end: { line: 1, character: 4 },
		},
	};
}

describe("the edit path walks a declaration only for jedi's own rows (#4638 F10)", () => {
	let tmp: string;
	let jediFile: string;
	let pyrightFile: string;

	beforeEach(() => {
		walked.files.length = 0;
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-4638-walk-").tmpDir);
		fs.writeFileSync(
			path.join(tmp, "pyproject.toml"),
			'[project]\nname = "demo"\nrequires-python = ">=3.14"\n',
		);
		jediFile = path.join(tmp, "jedi_only.py");
		pyrightFile = path.join(tmp, "typed.py");
		for (const file of [jediFile, pyrightFile]) {
			fs.writeFileSync(file, "def run() -> None:\n\tpass\n");
		}
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("resolves the jedi file and never the pyright-only one", async () => {
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{
					filePath: jediFile,
					diagnostics: [
						row("python-jedi", "compile", COMPILE_MESSAGE),
						row("pyright", "pyright", PYRIGHT_MESSAGE),
					],
					count: 2,
				},
				{
					filePath: pyrightFile,
					diagnostics: [row("pyright", "pyright", PYRIGHT_MESSAGE)],
					count: 1,
				},
			]),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);

		await tool.execute(
			"walk",
			{ mode: "full" },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		);

		expect(walked.files.filter((file) => file === pyrightFile)).toEqual([]);
		expect(walked.files).toContain(jediFile);
	});
});
