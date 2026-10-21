/**
 * helm availability probe against helm 4's real CLI contract (#4453).
 *
 * helm 4.3.0 has no `--version` flag: `helm --version` prints
 * `Error: unknown flag: --version` and exits 1 (probed with the real binary,
 * as was `helm version --short` -> `v4.3.0+gbec5b06`, exit 0). The helm-lint
 * and helm-render availability checkers probed with the default `--version`,
 * read the rejection as `non-installable`, and the runners never ran against any
 * real helm 4. Their own tests mocked the checker whole, so none exercised the
 * probe argv.
 *
 * Only the process boundary is replaced: `safeSpawnAsync` answers like helm 4.3.0
 * does. The availability checker, the resolver, and both runners are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
);

/**
 * spotbugs 4.10.2's answers (probed with a real JRE 21): `--version` throws
 * `IllegalArgumentException: Unknown option: --version` and exits 1; `-version`
 * prints `4.10.2`.
 */
function spotbugs4(args: string[]) {
	return args.length === 1 && args[0] === "-version"
		? { error: null, status: 0, stdout: "4.10.2\n", stderr: "" }
		: {
				error: null,
				status: 1,
				stdout: "",
				stderr: `java.lang.IllegalArgumentException: Unknown option: ${args[0]}\n`,
			};
}

/** helm 4.3.0's answers, byte for byte, for the three invocations the runners make. */
function helm4(args: string[]) {
	if (args.length === 1 && args[0] === "--version")
		return {
			error: null,
			status: 1,
			stdout: "",
			stderr: "Error: unknown flag: --version\n",
		};
	if (args[0] === "version" && args[1] === "--short")
		return { error: null, status: 0, stdout: "v4.3.0+gbec5b06\n", stderr: "" };
	return { error: null, status: 0, stdout: "", stderr: "" };
}

let workspace: string;
let originalPath: string | undefined;

beforeEach(async () => {
	vi.resetModules();
	workspace = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-probe-")),
	);
	// The checker looks the command up on disk before it spawns anything; the
	// stand-in is never executed because the spawn is mocked.
	const bin = path.join(workspace, "bin");
	fs.mkdirSync(bin);
	const stub = path.join(
		bin,
		process.platform === "win32" ? "helm.exe" : "helm",
	);
	fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(stub, 0o755);
	originalPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
	safeSpawnAsync.mockReset();
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
		helm4(args),
	);
	const { resetProjectLensConfigCache } =
		await import("../../../../clients/project-lens-config.js");
	resetProjectLensConfigCache();
});

afterEach(() => {
	process.env.PATH = originalPath;
	fs.rmSync(workspace, { recursive: true, force: true });
});

describe("helm availability probe", () => {
	it("helm-lint runs against a helm that rejects --version", async () => {
		const chart = path.join(workspace, "chart");
		fs.cpSync(path.join(fixtures, "tool-smoke", "helm"), chart, {
			recursive: true,
		});
		const runner = (
			await import("../../../../clients/dispatch/runners/helm-lint.js")
		).default;

		const result = await runner.run(
			makeRunnerCtx(path.join(chart, "templates", "bad.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.failureKind).not.toBe("unavailable");
		const subcommands = safeSpawnAsync.mock.calls.map(
			(call) => (call[1] as string[])[0],
		);
		expect(subcommands).toContain("lint");
	});

	it("helm-render runs against a helm that rejects --version", async () => {
		const chart = path.join(workspace, "chart");
		fs.cpSync(path.join(fixtures, "helm-render", "valid-chart"), chart, {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(workspace, ".pi-lens.json"),
			JSON.stringify({ helm: { renderValidation: { enabled: true } } }),
		);
		const { resetProjectLensConfigCache } =
			await import("../../../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		const { setProjectTrustState } =
			await import("../../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		const runner = (
			await import("../../../../clients/dispatch/runners/helm-render.js")
		).default;

		const result = await runner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.failureKind).not.toBe("unavailable");
		const subcommands = safeSpawnAsync.mock.calls.map(
			(call) => (call[1] as string[])[0],
		);
		expect(subcommands).toContain("template");
	});

	// The installer verifies a managed binary by spawning the registry row's own
	// `checkArgs` (clients/installer/index.ts verifyToolBinary). A row whose probe
	// the tool rejects turns every good install into "installed but does not run".
	it("the installer's helm and spotbugs rows probe with an argv their tool accepts", async () => {
		const { TOOLS, verifyToolBinary } =
			await import("../../../../clients/installer/index.js");
		const binary = path.join(workspace, "bin", "helm");
		for (const [id, answer] of [
			["helm", helm4],
			["spotbugs", spotbugs4],
		] as const) {
			const row = TOOLS.find((tool) => tool.id === id);
			expect(row, id).toBeDefined();
			safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
				answer(args),
			);
			expect(
				await verifyToolBinary(
					binary,
					undefined,
					undefined,
					10000,
					row?.checkArgs,
				),
				`${id} checkArgs ${JSON.stringify(row?.checkArgs)}`,
			).toBe(true);
		}
	});
});
