import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const dirs: string[] = [];
const defaultGlobalDir = process.env.PI_LENS_HOME;

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	if (defaultGlobalDir === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = defaultGlobalDir;
});

describe("loadLSPConfig global configuration (#870)", () => {
	it("applies global configuration when the project has no config", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					global: {
						name: "Global",
						extensions: [".global"],
						command: "global-lsp",
					},
				},
				disabledServers: ["typescript"],
				warmFiles: ["src/global.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toMatchObject({
			servers: { global: { command: "global-lsp" } },
			disabledServers: ["typescript"],
			warmFiles: ["src/global.ts"],
		});
	});

	it("merges maps by id and replaces project-owned array fields", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Global", extensions: [".g"], command: "global" },
					globalOnly: {
						name: "Global only",
						extensions: [".go"],
						command: "global-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "check" } } },
					go: { initializationOptions: { gofumpt: true } },
				},
				disabledServers: ["global-disabled"],
				warmFiles: ["global.ts"],
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".pi-lens"));
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Project", extensions: [".p"], command: "project" },
					projectOnly: {
						name: "Project only",
						extensions: [".po"],
						command: "project-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
					nix: { initializationOptions: { nixpkgs: { expr: "global" } } },
				},
				disabledServers: [],
				warmFiles: ["project.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir);

		expect(Object.keys(config.servers ?? {}).sort()).toEqual([
			"globalOnly",
			"projectOnly",
			"shared",
		]);
		expect(config.servers?.shared.command).toBe("project");
		expect(Object.keys(config.serverOverrides ?? {}).sort()).toEqual([
			"go",
			"nix",
			"rust",
		]);
		expect(config.serverOverrides?.rust.initializationOptions).toEqual({
			check: { command: "clippy" },
		});
		expect(config.disabledServers).toEqual([]);
		expect(config.warmFiles).toEqual(["project.ts"]);
	});

	it("degrades a malformed global file to built-in defaults", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid LSP config"),
		);
	});

	it("treats a missing global file as a silent no-op", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).not.toHaveBeenCalled();
	});
});
