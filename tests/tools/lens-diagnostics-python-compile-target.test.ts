/**
 * #4638 outcome: a project that declares Python 3.14 no longer receives jedi's
 * spurious `compile` verdict, on a fresh probe and on the workspace-cache
 * replay, while every other server's verdict and the file itself stay visible.
 *
 * The cases drive the PRODUCTION probe tool (`createLensDiagnosticsTool`,
 * `source: "lsp"`) against hand-built server answers, so the seam under test is
 * the real `applyProbeFindingPolicy` with the real degradation ledger, the real
 * workspace-diagnostics cache, and the real widget store. No helper re-implements
 * the drop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const COMPILE_MESSAGE =
	"SyntaxError: multiple exception types must be parenthesized";
const COMPILE_MESSAGE_2 =
	"SyntaxError: expected an indented block after exception handler";
const PYRIGHT_MESSAGE = 'Cannot access attribute "value" for class "object"';

let cwd: string;
let filePath: string;

function jediCompile(overrides: Record<string, unknown> = {}) {
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
		...overrides,
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

/**
 * Seed from the shared `LSPService` double (#2582) and override only the answer
 * under test: the probe's own server selection sees the shape a real service
 * has, so the route under test is the production one. `supportsLSP`/`hasLSP`
 * stay absent, the older-host shape the probe treats as "route through
 * `touchFile`".
 */
function makeService(diags: Array<Record<string, unknown>>) {
	return makeLspServiceDouble(
		{ touchFile: vi.fn(async () => ({ diags })) },
		{ omit: ["supportsLSP", "hasLSP"] },
	);
}

type ServiceDouble = ReturnType<typeof makeService>;

async function probe(service: ServiceDouble, target: string = filePath) {
	const tool = createLensDiagnosticsTool(
		{ readCache: vi.fn(() => undefined) } as never,
		() => cwd,
		() => service as never,
	);
	return (await tool.execute(
		"diag-4638",
		{ source: "lsp", scope: "paths", paths: [target] },
		new AbortController().signal,
		null,
		{ cwd },
	)) as {
		isError?: boolean;
		content: Array<{ text: string }>;
		details?: {
			totalDiagnostics?: number;
			dispositionSuppressed?: number;
		};
	};
}

function declareRequiresPython(specifier: string): string {
	const pyproject = path.join(cwd, "pyproject.toml");
	fs.writeFileSync(
		pyproject,
		`[project]\nname = "demo"\nrequires-python = "${specifier}"\n`,
	);
	return pyproject;
}

function compileDrops() {
	return getDegradationSummary().filter(
		(entry) => entry.kind === "python-compile-target-mismatch",
	);
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-probe-"));
	filePath = path.join(cwd, "app.py");
	fs.writeFileSync(
		filePath,
		[
			"def run() -> None:",
			"\ttry:",
			"\t\tpass",
			"\texcept ValueError, TypeError:",
			"\t\tpass",
			"",
		].join("\n"),
	);
	resetDegradationLedger();
	clearWidgetState();
});

afterEach(() => {
	resetDegradationLedger();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("source=lsp drops jedi's compile verdict under a declared 3.14 (#4638)", () => {
	it("drops it while the real pyright finding stays delivered", async () => {
		const declarationFile = declareRequiresPython(">=3.14");
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.isError).toBe(false);
		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(result.content[0].text).toContain(PYRIGHT_MESSAGE);
		// Counts, text, and the widget come from one filtered set.
		expect(result.details?.totalDiagnostics).toBe(1);
		expect(result.details?.dispositionSuppressed).toBeUndefined();
		expect(getFileDiagnostics(filePath)?.map((entry) => entry.message)).toEqual(
			[PYRIGHT_MESSAGE],
		);
		// #4638 review (F6): a withheld row is disclosed on the model-facing text
		// even when another finding survives.
		expect(result.content[0].text).toContain(
			"1 python-jedi compile finding withheld: the project declares Python 3.14",
		);

		const drops = compileDrops();
		expect(drops).toHaveLength(1);
		expect(drops[0]?.count).toBe(1);
		const reason = drops[0]?.latestReasons[0]?.reason ?? "";
		expect(reason).toContain("declared Python 3.14 (requires-python)");
		expect(reason).toContain(declarationFile);
		expect(reason).toContain("1 jedi compile finding dropped");
	});

	it("drops it again on a cache replay, and re-decides once the declaration changes", async () => {
		declareRequiresPython(">=3.14");
		const service = makeService([jediCompile(), pyrightFinding()]);

		await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);

		const replay = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(1);
		expect(replay.content[0].text).not.toContain("multiple exception types");
		expect(compileDrops()).toHaveLength(1);

		// The cached inline set still holds the row, so the drop re-decides at
		// every read. Lowering the declaration is a change to a file the CACHE
		// never keys on, but it IS a server config file the answer route's
		// pre-answer look publishes (#4532 gap 12: pyright reads
		// `pyproject.toml` once at start), so the next call is a fresh touch and
		// the row comes back through it (#5005 F1).
		declareRequiresPython(">=3.12");
		const lowered = await probe(service);
		expect(service.touchFile).toHaveBeenCalledTimes(2);
		expect(lowered.content[0].text).toContain("multiple exception types");
	});

	it("discloses a withheld row when nothing else is delivered", async () => {
		declareRequiresPython(">=3.14");
		const service = makeService([jediCompile()]);

		const result = await probe(service);

		// The only row was withheld, so the render is not a bare clean line: the
		// agent reads what the declaration removed and why (#4638 review F6).
		expect(result.content[0].text).toContain("No diagnostics found.");
		expect(result.content[0].text).toContain(
			"1 python-jedi compile finding withheld: the project declares Python 3.14 (requires-python)",
		);
		expect(result.content[0].text).toContain(path.join(cwd, "pyproject.toml"));
	});

	it("drops only jedi's compile rows, not every compile row", async () => {
		declareRequiresPython(">=3.14");
		const service = makeService([
			jediCompile(),
			jediCompile({ message: COMPILE_MESSAGE_2 }),
			pyrightFinding(),
		]);

		const result = await probe(service);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(result.content[0].text).not.toContain("expected an indented block");
		expect(compileDrops()[0]?.latestReasons[0]?.reason).toContain(
			"2 jedi compile findings dropped",
		);
	});
});

describe("source=lsp keys the drop on the publishing server (#4638 r3 N3)", () => {
	it("delivers another server's source=compile row at a declared 3.14", async () => {
		// Recurrence: the discriminator read `source === "compile"` alone in every
		// delivery suite, so collapsing the `serverId` arm to a constant dropped a
		// second server's genuine verdict and no delivery cell noticed (the
		// survivor the second review quoted).
		declareRequiresPython(">=3.14");
		const service = makeService([
			jediCompile(),
			jediCompile({
				serverId: "python-pyright-aux",
				message: "SyntaxError: another server's own compile verdict",
			}),
		]);

		const result = await probe(service);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(result.content[0].text).toContain(
			"another server's own compile verdict",
		);
		expect(result.details?.totalDiagnostics).toBe(1);
	});
});

describe("source=lsp keeps every verdict below a declared 3.14 (#4638)", () => {
	it("delivers jedi's compile verdict at a declared 3.13", async () => {
		declareRequiresPython(">=3.13");
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(result.details?.totalDiagnostics).toBe(2);
		expect(compileDrops()).toHaveLength(0);
	});

	it("delivers jedi's compile verdict when the project declares nothing", async () => {
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(result.details?.totalDiagnostics).toBe(2);
		expect(compileDrops()).toHaveLength(0);
	});

	it("delivers jedi's compile verdict when the declaration is unusable", async () => {
		declareRequiresPython("<4");
		const service = makeService([jediCompile()]);

		const result = await probe(service);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(compileDrops()).toHaveLength(0);
	});
});

describe("the declaration that governs the drop (#4638 review)", () => {
	it("takes the strongest lower bound in either clause order", async () => {
		for (const specifier of [">=3.12,>=3.14", ">=3.14,>=3.12"]) {
			resetDegradationLedger();
			declareRequiresPython(specifier);
			const service = makeService([jediCompile(), pyrightFinding()]);

			const result = await probe(service);

			expect(result.content[0].text, `declaration ${specifier}`).not.toContain(
				"multiple exception types",
			);
			expect(compileDrops()).toHaveLength(1);
		}
	});

	it("reads a commented pyrightconfig.json the way pyright does", async () => {
		fs.writeFileSync(
			path.join(cwd, "pyrightconfig.json"),
			[
				"{",
				"\t// pyright's own config accepts comments",
				'\t"pythonVersion": "3.14",',
				"\t/* and a trailing comma above */",
				"}",
				"",
			].join("\n"),
		);
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(compileDrops()[0]?.latestReasons[0]?.reason).toContain(
			"declared Python 3.14 (pyright-python-version)",
		);
	});

	it("stops a nested ruff config from inheriting the enclosing level (#4638 r3 N1)", async () => {
		// Ruff reads the nested `.ruff.toml` and applies its own default, so the
		// enclosing project's 3.14 is not the level for this file.
		fs.writeFileSync(
			path.join(cwd, "pyproject.toml"),
			'[tool.ruff]\ntarget-version = "py314"\n',
		);
		const nestedDir = path.join(cwd, "services", "api");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDir, ".ruff.toml"),
			"[lint]\nselect = ['E']\n",
		);
		const nestedFile = path.join(nestedDir, "app.py");
		fs.writeFileSync(nestedFile, fs.readFileSync(filePath));
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service, nestedFile);

		expect(result.content[0].text).toContain("multiple exception types");
		expect(compileDrops()).toHaveLength(0);
	});

	it("lets the enclosing level through a nested pyproject ruff ignores (#4638 r3 N1)", async () => {
		// A nested `pyproject.toml` without `[tool.ruff]` is not a ruff config, so
		// ruff keeps walking and the enclosing 3.14 governs this file too.
		fs.writeFileSync(
			path.join(cwd, "pyproject.toml"),
			'[tool.ruff]\ntarget-version = "py314"\n',
		);
		const nestedDir = path.join(cwd, "services", "api");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDir, "pyproject.toml"),
			'[project]\nname = "api"\n',
		);
		const nestedFile = path.join(nestedDir, "app.py");
		fs.writeFileSync(nestedFile, fs.readFileSync(filePath));
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service, nestedFile);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(compileDrops()[0]?.latestReasons[0]?.reason).toContain(
			"declared Python 3.14 (ruff-target-version)",
		);
	});

	it("reads ruff's own same-directory config the way ruff does", async () => {
		// Measured against ruff 0.16.8: `.ruff.toml` governs the directory, ahead
		// of `ruff.toml` and of `pyproject.toml`'s `[tool.ruff]`.
		fs.writeFileSync(
			path.join(cwd, ".ruff.toml"),
			'target-version = "py314"\n[lint]\nselect = ["UP006"]\n',
		);
		fs.writeFileSync(
			path.join(cwd, "ruff.toml"),
			'target-version = "py38"\n[lint]\nselect = ["UP006"]\n',
		);
		// pyproject also carries `[tool.ruff]`, so a reader that trusts it first
		// picks 3.8 here and delivers the spurious row.
		declareRequiresPython(">=3.8");
		fs.appendFileSync(
			path.join(cwd, "pyproject.toml"),
			'[tool.ruff]\ntarget-version = "py38"\n[lint]\nselect = ["UP006"]\n',
		);
		const service = makeService([jediCompile(), pyrightFinding()]);

		const result = await probe(service);

		expect(result.content[0].text).not.toContain("multiple exception types");
		expect(compileDrops()[0]?.latestReasons[0]?.reason).toContain(
			"declared Python 3.14 (ruff-target-version)",
		);
	});
});
