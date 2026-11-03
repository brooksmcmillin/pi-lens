/**
 * #4638 review (F1): the edit path is `source=session`, and `mode=full` merges a
 * fresh sweep. Both used to deliver jedi's `compile` row as a blocking finding
 * under a declared 3.14; both now ask the declaration's owner, like the probe
 * and the post-write runner. The cells read the model-facing rows: the 🔴 marker
 * IS the delivered `semantic`, so "not blocking" means the row is not there and
 * "still blocking" means it renders with the marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWidgetState } from "../../clients/widget-state.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";

const COMPILE_MESSAGE =
	"SyntaxError: multiple exception types must be parenthesized";
const PYRIGHT_MESSAGE = 'Cannot access attribute "value" for class "object"';

function jediCompile() {
	return {
		severity: 1,
		message: COMPILE_MESSAGE,
		source: "compile",
		code: "syntax",
		serverId: "python-jedi",
		range: {
			start: { line: 2, character: 8 },
			end: { line: 2, character: 20 },
		},
	};
}

function pyrightFinding() {
	return {
		severity: 1,
		message: PYRIGHT_MESSAGE,
		source: "pyright",
		code: "reportAttributeAccessIssue",
		serverId: "pyright",
		range: {
			start: { line: 5, character: 4 },
			end: { line: 5, character: 9 },
		},
	};
}

describe("mode=full and source=session apply the declaration rule (#4638 F1)", () => {
	let tmp: string;
	let file: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-4638-f1-").tmpDir);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, ".data");
		_resetDeferredForTests();
		_resetStateCacheForTests();
		file = path.join(tmp, "app.py");
		fs.writeFileSync(
			file,
			[
				"def run() -> None:",
				"\ttry:",
				"\t\tpass",
				"\texcept ValueError, TypeError:",
				"\t\tpass",
				"",
			].join("\n"),
		);
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetDeferredForTests();
		_resetStateCacheForTests();
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	function declareRequiresPython(specifier: string): void {
		fs.writeFileSync(
			path.join(tmp, "pyproject.toml"),
			`[project]\nname = "demo"\nrequires-python = "${specifier}"\n`,
		);
	}

	async function run(params: Record<string, unknown>): Promise<string> {
		const service = makeLspServiceDouble({
			runWorkspaceDiagnostics: vi.fn(async () => [
				{
					filePath: file,
					diagnostics: [jediCompile(), pyrightFinding()],
					count: 2,
				},
			]),
		});
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		const result = (await tool.execute(
			"f1",
			params,
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		)) as { content: Array<{ text: string }> };
		return result.content.map((entry) => entry.text).join("\n");
	}

	/** The finding rows a report lists, marker kept. */
	function rows(report: string): string[] {
		const found: string[] = [];
		for (const line of report.split("\n")) {
			if (/^\s+(?:🔴 )?L\d+: /.test(line)) found.push(line.trim());
		}
		return found;
	}

	it("mode=full drops the compile row at 3.14 and keeps it blocking at 3.13", async () => {
		declareRequiresPython(">=3.14");
		const dropped = await run({ mode: "full" });
		expect(rows(dropped).join("\n")).not.toContain("multiple exception types");
		expect(rows(dropped).join("\n")).toContain(PYRIGHT_MESSAGE);

		_resetStateCacheForTests();
		clearWidgetState();
		declareRequiresPython(">=3.13");
		const kept = await run({ mode: "full" });
		const keptRows = rows(kept);
		expect(keptRows.join("\n")).toContain("multiple exception types");
		expect(
			keptRows.some(
				(row) =>
					row.startsWith("🔴") && row.includes("multiple exception types"),
			),
		).toBe(true);
	});

	it("source=session (mode=all) drops the compile row at 3.14 and keeps it blocking at 3.13", async () => {
		declareRequiresPython(">=3.14");
		await run({ mode: "full" });
		const dropped = await run({ mode: "all" });
		expect(rows(dropped).join("\n")).not.toContain("multiple exception types");
		expect(rows(dropped).join("\n")).toContain(PYRIGHT_MESSAGE);

		_resetStateCacheForTests();
		clearWidgetState();
		declareRequiresPython(">=3.13");
		await run({ mode: "full" });
		const kept = await run({ mode: "all" });
		const keptRows = rows(kept);
		expect(keptRows.join("\n")).toContain("multiple exception types");
		expect(
			keptRows.some(
				(row) =>
					row.startsWith("🔴") && row.includes("multiple exception types"),
			),
		).toBe(true);
	});
});

describe("mode=file discloses a withheld row (#4638 F6)", () => {
	let tmp: string;
	let file: string;

	beforeEach(() => {
		clearWidgetState();
		tmp = fs.realpathSync(setupTestEnvironment("pi-lens-4638-f6-file-").tmpDir);
		file = path.join(tmp, "app.py");
		fs.writeFileSync(file, "def run() -> None:\n\tpass\n");
		fs.writeFileSync(
			path.join(tmp, "pyproject.toml"),
			'[project]\nname = "demo"\nrequires-python = ">=3.14"\n',
		);
		_resetDeferredForTests();
		_resetStateCacheForTests();
	});

	afterEach(() => {
		_resetDeferredForTests();
		_resetStateCacheForTests();
		clearWidgetState();
		removeTempDirSync(tmp);
	});

	it("renders the disclosure instead of a bare clean line", async () => {
		const service = makeLspServiceDouble({
			supportsLSP: vi.fn(() => true),
			touchFile: vi.fn(async () => ({ diags: [jediCompile()] })),
		});
		let writeIndex = 0;
		const tool = createLspDiagnosticsTool(
			() => (writeIndex += 1),
			undefined,
			() => service as never,
		);
		const result = (await tool.execute(
			"f6-file",
			{ path: file },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		)) as { content: Array<{ text: string }> };
		const text = result.content.map((entry) => entry.text).join("\n");

		// The route's own clean sentence, plus the disclosure that keeps it honest.
		expect(text).toContain("confirmed clean");
		expect(text).toContain(
			"1 python-jedi compile finding withheld: the project declares Python 3.14 (requires-python)",
		);
		expect(text).toContain(path.join(tmp, "pyproject.toml"));
	});
});
