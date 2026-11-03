/**
 * #4638: the declared Python syntax level, read from the project rather than
 * from whichever interpreter runs a checker. Every case drives the production
 * resolver (`detectPythonTargetVersion`) over a real fixture tree; nothing here
 * rebuilds the precedence table in the test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	detectPythonTargetVersion,
	isJediCompileVerdict,
	isJediCompileVerdictOutranked,
	PYTHON_COMPILE_VERDICT_SERVER_ID,
	type PythonTargetVersion,
} from "../../clients/python-environment.js";
import { removeTempDirSync } from "./test-utils.js";

let cwd: string;

function project(...segments: string[]): string {
	return path.join(cwd, "project", ...segments);
}

function write(relativePath: string, content: string): string {
	const target = project(relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

/** Resolve for a file in the fixture project, with `cwd` as the home ceiling. */
function resolveFor(relativePath = "app.py") {
	return detectPythonTargetVersion(project(relativePath), cwd);
}

function declared(
	minor: number,
	source: PythonTargetVersion["source"] = "requires-python",
): PythonTargetVersion {
	return { major: 3, minor, source, file: project("pyproject.toml") };
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-syntax-"));
	fs.mkdirSync(project(), { recursive: true });
	resetDegradationLedger();
});

afterEach(() => {
	resetDegradationLedger();
	removeTempDirSync(cwd);
});

describe("detectPythonTargetVersion sources", () => {
	it("reads ruff target-version from pyproject [tool.ruff]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.ruff]\ntarget-version = "py312"\n',
		);
		await expect(resolveFor()).resolves.toEqual({
			major: 3,
			minor: 12,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads ruff target-version from .ruff.toml", async () => {
		const file = write(".ruff.toml", 'target-version = "py311"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads ruff target-version from ruff.toml", async () => {
		const file = write("ruff.toml", 'target-version = "py314"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "ruff-target-version",
			file,
		});
	});

	it("reads pyright pythonVersion from pyrightconfig.json", async () => {
		const file = write("pyrightconfig.json", '{"pythonVersion": "3.13"}\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
			file,
		});
	});

	it("reads pyright pythonVersion from pyproject [tool.pyright]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.pyright]\npythonVersion = "3.13"\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
			file,
		});
	});

	it("reads requires-python from pyproject [project]", async () => {
		const file = write(
			"pyproject.toml",
			'[project]\nname = "demo"\nrequires-python = ">=3.12"\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
			file,
		});
	});

	it("reads the first line of .python-version", async () => {
		const file = write(".python-version", "3.14.2\n3.12.0\n");
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "python-version-file",
			file,
		});
	});

	it("prefers a redirection-free declaration in the nearest directory", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write("pkg/.python-version", "3.14\n");
		await expect(resolveFor("pkg/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "python-version-file",
		});
	});

	it("walks past a directory that declares nothing", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
		fs.mkdirSync(project("pkg", "nested"), { recursive: true });
		await expect(resolveFor("pkg/nested/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "requires-python",
		});
	});
});

describe("detectPythonTargetVersion precedence", () => {
	it("prefers ruff target-version over pyright and requires-python", async () => {
		write(
			"pyproject.toml",
			[
				'[project]\nrequires-python = ">=3.12"',
				'[tool.pyright]\npythonVersion = "3.13"',
				'[tool.ruff]\ntarget-version = "py310"',
				"",
			].join("\n"),
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 10,
			source: "ruff-target-version",
		});
	});

	it("prefers pyright pythonVersion over requires-python", async () => {
		write(
			"pyproject.toml",
			[
				'[project]\nrequires-python = ">=3.12"',
				'[tool.pyright]\npythonVersion = "3.13"',
				"",
			].join("\n"),
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 13,
			source: "pyright-python-version",
		});
	});

	it("prefers requires-python over .python-version", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write(".python-version", "3.14\n");
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
		});
	});

	it("prefers pyrightconfig.json over pyproject [tool.pyright]", async () => {
		write("pyproject.toml", '[tool.pyright]\npythonVersion = "3.13"\n');
		write("pyrightconfig.json", '{"pythonVersion": "3.14"}\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
		});
	});

	it("stops at the ruff config ruff itself would read", async () => {
		// `.ruff.toml` is the config ruff uses here; it declares no target, so
		// ruff runs at its default level and a sibling `ruff.toml` is dead text.
		write(".ruff.toml", "[lint]\nselect = ['E']\n");
		write("ruff.toml", 'target-version = "py312"\n');
		write("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 11,
			source: "requires-python",
		});
	});
});

/**
 * #4638 r3 (N1): each declaration source stops the upward walk where ITS OWN tool
 * stops, not at any `pyproject.toml`. Every expectation below was measured on
 * ruff 0.17.1 (`ruff check --show-settings`) and pyright 1.1.414 (`--verbose`);
 * `ruff-target-version-real.test.ts` re-asks the real ruff for the ruff rows.
 * Recurrence: one directory-wide boundary under-triggered at a nested
 * `pyproject.toml` ruff ignores and over-triggered past a nested config that
 * owns the level, so the drop applied an ancestor's level where the tool never
 * would, or withheld nothing where it should.
 */
describe("detectPythonTargetVersion walk boundary per source (#4638 r3 N1)", () => {
	it("ruff walks past a nested pyproject without [tool.ruff]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.ruff]\ntarget-version = "py314"\n',
		);
		write("services/api/pyproject.toml", '[project]\nname = "api"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toEqual({
			major: 3,
			minor: 14,
			source: "ruff-target-version",
			file,
		});
	});

	it("ruff stops at a nested .ruff.toml that sets no target-version", async () => {
		write("pyproject.toml", '[tool.ruff]\ntarget-version = "py314"\n');
		write("services/api/.ruff.toml", "[lint]\nselect = ['E']\n");
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});

	it("ruff stops at a nested [tool.ruff] that sets no target-version", async () => {
		write("pyproject.toml", '[tool.ruff]\ntarget-version = "py314"\n');
		write("services/api/pyproject.toml", "[tool.ruff]\nline-length = 100\n");
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});

	it("pyright walks past a nested pyproject without [tool.pyright]", async () => {
		const file = write(
			"pyproject.toml",
			'[tool.pyright]\npythonVersion = "3.14"\n',
		);
		write("services/api/pyproject.toml", '[project]\nname = "api"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toEqual({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
			file,
		});
	});

	it("pyright stops at a nested pyrightconfig.json that sets no pythonVersion", async () => {
		write("pyrightconfig.json", '{"pythonVersion": "3.14"}\n');
		write("services/api/pyrightconfig.json", "{}\n");
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});

	it("requires-python walks past a nested pyproject that has none (ruff infers the same way)", async () => {
		const file = write(
			"pyproject.toml",
			'[project]\nrequires-python = ">=3.14"\n',
		);
		write("services/api/pyproject.toml", '[project]\nname = "api"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toEqual({
			major: 3,
			minor: 14,
			source: "requires-python",
			file,
		});
	});

	it("requires-python stops at a nested pyproject that carries its own, usable or not", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.14"\n');
		write("services/api/pyproject.toml", '[project]\nrequires-python = "<4"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});

	it("a nested ruff config without a target still lets an ancestor's requires-python through", async () => {
		const file = write(
			"pyproject.toml",
			'[project]\nrequires-python = ">=3.14"\n',
		);
		write("services/api/.ruff.toml", "[lint]\nselect = ['E']\n");
		await expect(resolveFor("services/api/app.py")).resolves.toEqual({
			major: 3,
			minor: 14,
			source: "requires-python",
			file,
		});
	});

	it(".python-version walks past a nested pyproject and stops at a nested .python-version", async () => {
		const file = write(".python-version", "3.14\n");
		write("services/api/pyproject.toml", '[project]\nname = "api"\n');
		await expect(resolveFor("services/api/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "python-version-file",
			file,
		});
		write("services/api/.python-version", "main\n");
		await expect(resolveFor("services/api/app.py")).resolves.toBeUndefined();
	});
});

describe("detectPythonTargetVersion reductions", () => {
	const forms: Array<[string, number]> = [
		[">=3.12", 12],
		[">=3.12,<4", 12],
		["==3.14.*", 14],
		["~=3.11", 11],
		["3.14", 14],
	];

	for (const [specifier, minor] of forms) {
		it(`reduces requires-python "${specifier}" to 3.${minor}`, async () => {
			write("pyproject.toml", `[project]\nrequires-python = "${specifier}"\n`);
			await expect(resolveFor()).resolves.toMatchObject({
				major: 3,
				minor,
				source: "requires-python",
			});
		});
	}

	const unusable = ["pypy-3.10", "main", "", "<4", ">3.12", "!=3.12", "3"];
	for (const line of unusable) {
		it(`treats .python-version line ${JSON.stringify(line)} as no declaration`, async () => {
			write(".python-version", `${line}\n`);
			await expect(resolveFor()).resolves.toBeUndefined();
		});
	}

	it("reads a triple-quoted declaration in every source (#4638 r3 N7)", async () => {
		// Recurrence: `parseTomlScalarString` read `"""..."""` as an empty string, so
		// a legal TOML spelling declared nothing and the false positive survived.
		write("pyproject.toml", '[project]\nrequires-python = """>=3.14"""\n');
		await expect(resolveFor()).resolves.toMatchObject({
			minor: 14,
			source: "requires-python",
		});
		write(
			"pyproject.toml",
			"[project]\nrequires-python = \'\'\'>=3.14\'\'\'\n",
		);
		await expect(resolveFor()).resolves.toMatchObject({
			minor: 14,
			source: "requires-python",
		});
		write("pyproject.toml", '[tool.ruff]\ntarget-version = """py314"""\n');
		await expect(resolveFor()).resolves.toMatchObject({
			minor: 14,
			source: "ruff-target-version",
		});
		write(
			"pyproject.toml",
			"[tool.pyright]\npythonVersion = \'\'\'3.14\'\'\'\n",
		);
		await expect(resolveFor()).resolves.toMatchObject({
			minor: 14,
			source: "pyright-python-version",
		});
	});

	it("takes the strongest lower bound in either order (#4638 review)", async () => {
		for (const specifier of [">=3.12,>=3.14", ">=3.14,>=3.12"]) {
			write("pyproject.toml", `[project]\nrequires-python = "${specifier}"\n`);
			await expect(resolveFor()).resolves.toMatchObject({
				major: 3,
				minor: 14,
				source: "requires-python",
			});
		}
	});

	it("reads a commented pyrightconfig.json (#4638 review)", async () => {
		const file = write(
			"pyrightconfig.json",
			'{\n\t// comment\n\t"pythonVersion": "3.14",\n\t/* note */\n}\n',
		);
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
			file,
		});
	});

	it("still reads a declaration inside the nested project", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write(
			"services/api/pyproject.toml",
			'[tool.pyright]\npythonVersion = "3.14"\n',
		);
		await expect(resolveFor("services/api/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 14,
			source: "pyright-python-version",
		});
	});

	it("prefers .ruff.toml, then ruff.toml, then pyproject (#4638 review)", async () => {
		write("pyproject.toml", '[tool.ruff]\ntarget-version = "py39"\n');
		write("ruff.toml", 'target-version = "py310"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 10,
			source: "ruff-target-version",
		});
		write(".ruff.toml", 'target-version = "py312"\n');
		await expect(resolveFor()).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "ruff-target-version",
		});
	});

	it("treats requires-python with no lower bound as no declaration", async () => {
		write("pyproject.toml", '[project]\nrequires-python = "<4"\n');
		await expect(resolveFor()).resolves.toBeUndefined();
	});

	it("keeps walking when the nearest declaration is unusable", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		write("pkg/.python-version", "pypy-3.10\n");
		await expect(resolveFor("pkg/app.py")).resolves.toMatchObject({
			major: 3,
			minor: 12,
			source: "requires-python",
		});
	});

	it("returns undefined when the project declares nothing", async () => {
		write("README.md", "# demo\n");
		await expect(resolveFor()).resolves.toBeUndefined();
	});

	it("returns undefined for a file that is not Python", async () => {
		write("pyproject.toml", '[project]\nrequires-python = ">=3.14"\n');
		await expect(resolveFor("app.ts")).resolves.toBeUndefined();
	});

	it("records one degradation and stays absent when a manifest cannot be read", async () => {
		// A directory where the manifest belongs makes the real `readFile` throw
		// EISDIR on every platform, so the failure path is not a mock.
		fs.mkdirSync(project("pyproject.toml"), { recursive: true });
		await expect(resolveFor()).resolves.toBeUndefined();
		const rows = getDegradationSummary().filter(
			(entry) => entry.kind === "python-target-version-unreadable",
		);
		expect(rows).toHaveLength(1);
	});
});

describe("isJediCompileVerdictOutranked", () => {
	const jediCompile = {
		serverId: PYTHON_COMPILE_VERDICT_SERVER_ID,
		source: "compile",
	};

	it("drops jedi's compile verdict at a declared 3.14", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, declared(14))).toBe(true);
	});

	it("keeps jedi's compile verdict at a declared 3.13", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, declared(13))).toBe(
			false,
		);
	});

	it("keeps every verdict when nothing is declared", () => {
		expect(isJediCompileVerdictOutranked(jediCompile, undefined)).toBe(false);
	});

	it("keeps another server's compile verdict at 3.14", () => {
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: "pyright", source: "compile" },
				declared(14),
			),
		).toBe(false);
	});

	it("keeps jedi's non-compile verdict at 3.14", () => {
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: PYTHON_COMPILE_VERDICT_SERVER_ID, source: "jedi" },
				declared(14),
			),
		).toBe(false);
		expect(
			isJediCompileVerdictOutranked(
				{ serverId: PYTHON_COMPILE_VERDICT_SERVER_ID },
				declared(14),
			),
		).toBe(false);
	});

	it("recognises the verdict in both row spellings (#4638 review F1)", () => {
		expect(
			isJediCompileVerdict({ serverId: "python-jedi", source: "compile" }),
		).toBe(true);
		expect(
			isJediCompileVerdict({ tool: "python-jedi", rule: "compile:syntax" }),
		).toBe(true);
		expect(isJediCompileVerdict({ tool: "lsp", rule: "compile:syntax" })).toBe(
			false,
		);
		expect(
			isJediCompileVerdict({ serverId: "pyright", source: "compile" }),
		).toBe(false);
	});

	it("drops at any later major or minor", () => {
		expect(
			isJediCompileVerdictOutranked(jediCompile, {
				...declared(0),
				major: 4,
			}),
		).toBe(true);
	});
});
