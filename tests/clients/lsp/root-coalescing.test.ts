import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";
import { enforceLspRootCeiling } from "../../../clients/lsp/server.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

type RootPolicyHarness = {
	state: {
		clients: Map<string, LSPClientInfo>;
		inFlight: Map<string, Promise<unknown>>;
	};
	resolveServerRoot(
		server: LSPServerInfo,
		filePath: string,
	): Promise<string | undefined>;
};

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	vi.restoreAllMocks();
});

function fakeClient(root: string): LSPClientInfo {
	return { root, isAlive: () => true } as unknown as LSPClientInfo;
}

function markerServer(id: string): LSPServerInfo {
	return {
		id,
		name: id,
		extensions: [".md"],
		root: async (file) => path.dirname(file),
		spawn: async () => undefined,
	};
}

describe("LSP per-server nested-root coalescing (#1373)", () => {
	it("attaches a nested marker directory to an existing ancestor client", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-coalesce-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, ".github", "workflows");
		fs.mkdirSync(nested, { recursive: true });

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("yaml");
		service.state.clients.set(
			`yaml:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "ci.yml")),
		).resolves.toBe(project);
		expect(service.state.clients.size).toBe(1);
		cwdSpy.mockRestore();
	});

	it("preserves a true nested project with its own manifest", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-boundary-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "packages", "docs");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("marksman");
		service.state.clients.set(
			`marksman:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "README.md")),
		).resolves.toBe(nested);
		cwdSpy.mockRestore();
	});

	it("coalesces a config-only TypeScript root with an already-hosted ancestor", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-config-coalesce-"));
		dirs.push(project);
		vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "packages", "configured");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "tsconfig.json"), "{}\n");

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("typescript");
		service.state.clients.set(
			`typescript:${normalizeMapKey(project)}`,
			fakeClient(project),
		);
		await expect(
			service.resolveServerRoot(server, path.join(nested, "app.ts")),
		).resolves.toBe(project);
	});

	it("parses Windows-shaped ceiling paths with win32 semantics on every host", () => {
		expect(
			enforceLspRootCeiling(
				"C:\\repo",
				"C:\\repo\\session",
				"C:\\repo\\session\\src\\app.ts",
			),
		).toBe("C:\\repo\\session");
	});

	it("coalesces drive-letter and path-case aliases to the hosted client", async () => {
		vi.spyOn(process, "cwd").mockReturnValue("C:\\Repo");
		const service = new LSPService() as unknown as RootPolicyHarness;
		const server: LSPServerInfo = {
			...markerServer("typescript"),
			root: async () => "c:\\REPO\\nested",
		};
		service.state.clients.set(
			`typescript:${normalizeMapKey("C:\\Repo")}`,
			fakeClient("C:\\Repo"),
		);
		await expect(
			service.resolveServerRoot(server, "c:\\repo\\nested\\app.ts"),
		).resolves.toBe("C:\\Repo");
	});

	it("preserves a nested Git project without a manifest", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-boundary-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const nested = path.join(project, "vendor", "child-repo");
		fs.mkdirSync(path.join(nested, ".git"), { recursive: true });

		const service = new LSPService() as unknown as RootPolicyHarness;
		const server = markerServer("marksman");
		service.state.clients.set(
			`marksman:${normalizeMapKey(project)}`,
			fakeClient(project),
		);

		await expect(
			service.resolveServerRoot(server, path.join(nested, "README.md")),
		).resolves.toBe(nested);
		cwdSpy.mockRestore();
	});

	it("collapses the observed nested-marker fixture below ceiling pressure", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pressure-"));
		dirs.push(project);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		const shapes = [
			...Array.from({ length: 5 }, (_, i) => `skills/pi-lens-${i}`),
			...Array.from({ length: 7 }, (_, i) => `rules/coderabbit/rules/lang-${i}/security`),
			".github",
			".github/workflows",
			...Array.from({ length: 5 }, (_, i) => `cases/${i}/workspace`),
		];
		for (const relative of shapes) {
			fs.mkdirSync(path.join(project, relative), { recursive: true });
		}

		const service = new LSPService() as unknown as RootPolicyHarness;
		const roots = new Set<string>();
		for (const id of ["yaml", "marksman"]) {
			const server = markerServer(id);
			const projectKey = `${id}:${normalizeMapKey(project)}`;
			service.state.clients.set(projectKey, fakeClient(project));
			roots.add(projectKey);
			for (const relative of shapes) {
				const root = await service.resolveServerRoot(
					server,
					path.join(project, relative, `fixture.${id === "yaml" ? "yml" : "md"}`),
				);
				roots.add(`${id}:${normalizeMapKey(root!)}`);
			}
		}

		expect(roots.size).toBe(2);
		expect(service.state.clients.size).toBe(2);
		cwdSpy.mockRestore();
	});
});
