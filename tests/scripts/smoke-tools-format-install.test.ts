// flake-shape: in-process-mock — tool installation and discovery are the network boundary: the stub hands the real formatter resolution a managed path, while FormatService, formatter selection and formatFile are real and only the formatter child process is doubled.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getFormatService,
	resetFormatService,
} from "../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import {
	FIXTURES,
	FORMAT_FIXTURES,
	runFormatSmoke,
} from "../../scripts/smoke-tools.mjs";

const MANAGED_FORMATTERS = [
	"black",
	"cmake-format",
	"stylua",
	"cljfmt",
	"php-cs-fixer",
	"google-java-format",
	"oxfmt",
];

/** Every formatter child the real service started: its command and file. */
const spawned = vi.hoisted(
	() => [] as Array<{ cmd: string; args: string[]; file: string }>,
);

// The formatter child process is the host boundary: it is doubled and rewrites
// the file the way a formatter would. The service, formatter selection and
// `formatFile` above it are the real in-process code (AGENTS.md shape 66).
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(async (cmd: string, args: string[]) => {
		const file = [...args]
			.reverse()
			.find((arg) => fs.existsSync(arg) && fs.statSync(arg).isFile());
		if (file) {
			spawned.push({ cmd, args, file });
			fs.appendFileSync(file, "\n");
		}
		return { status: 0, stdout: "", stderr: "" };
	}),
	isCommandAvailableAsync: async () => false,
}));

// The installer is the network boundary; the test supplies the same
// `ensureTool` to the formatter's lazy resolution and to the smoke's own deps.
const ensureTool = vi.hoisted(() => vi.fn());
const getToolPath = vi.hoisted(() => vi.fn());
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	ensureTool,
	getToolPath,
}));

describe("format smoke installer wiring", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		spawned.length = 0;
		ensureTool.mockReset();
		getToolPath.mockReset();
		getToolPath.mockImplementation(
			async (toolId: string) => `/managed/${toolId}`,
		);
		ensureTool.mockImplementation(
			async (toolId: string) => `/managed/${toolId}`,
		);
		clearFormatterRuntimeState();
		resetFormatService();
	});
	afterEach(() => {
		resetFormatService();
	});

	it("requests the managed tool for every selected managed formatter", async () => {
		const getInstallAttempt = vi.fn();
		const requests: string[] = [];
		const langs = [
			"python-black",
			"cmake",
			"js-oxfmt",
			"lua",
			"clojure",
			"php",
			"java-gjf",
		];

		const result = await runFormatSmoke({
			langs,
			install: true,
			verbose: false,
			deps: {
				ensureTool,
				getInstallAttempt,
				getFormatService: () => getFormatService("smoke-format-install"),
				onEnsure: (toolId: string) => requests.push(toolId),
			},
		});

		expect([...new Set(requests)].sort()).toEqual(
			[...MANAGED_FORMATTERS].sort(),
		);
		expect(
			[...new Set(ensureTool.mock.calls.map(([toolId]) => toolId))].sort(),
		).toEqual([...MANAGED_FORMATTERS].sort());
		expect(result).toBe(0);
		// The REAL service accepted each scratch workspace as the session: it
		// started one formatter child per fixture instead of refusing the file.
		// The oxfmt fixture is the one exception: it ships a package.json with no
		// lockfile, so the real agreement gate declines before any spawn (the
		// nightly shows the same skip row).
		expect(spawned.map((row) => path.basename(row.file)).sort()).toEqual(
			FORMAT_FIXTURES.filter(
				(fx) => langs.includes(fx.lang) && fx.formatter !== "oxfmt",
			)
				.map((fx) => path.basename(fx.file))
				.sort(),
		);
		const formatterTools = new Set(MANAGED_FORMATTERS);
		const misplaced = FIXTURES.flatMap((fixture) =>
			(fixture.tools ?? [])
				.filter((toolId) => formatterTools.has(toolId))
				.map((toolId) => `${fixture.lang}:${toolId}`),
		);
		expect(
			misplaced,
			"formatter installs belong only to FORMAT_FIXTURES",
		).toEqual([]);
	});
});
