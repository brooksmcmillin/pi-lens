/**
 * #4532 gap 5: the `tool_call` look walks at most once per
 * `PI_LENS_DECLARATION_LOOK_MS` (2 s), so a declaration file created inside
 * that window reaches no server before the next `lsp_diagnostics` answer — the
 * extension route's half of the gap-13 rule ("the first call after an outside
 * change must already read clean").
 *
 * Recurrence this file prevents: the tool body answered from the server's view
 * and left the walk to whatever look happened to be due. With the look's
 * interval not yet elapsed, the created `.d.ts` was never published, so the
 * importer kept `Cannot find name` on call 1 and cleared only after a later
 * bash result's walk.
 *
 * Production chain under test: the REAL tool body -> the REAL `LSPService` and
 * client -> a stdio JSON-RPC wire to the shared fake server, launched as a
 * project-configured custom server. The server is the fake's closed-file-cache
 * profile: an ambient declaration is seen at initialize or when a Created
 * watched-files event names it (measured on pyright 1.1.414 for the config-file
 * case, #4532 gap 12).
 *
 * The cells drive the same look the pi `tool_call` hook runs
 * (`lookForOutOfBandChanges(root, "tool_call")`) between the two answers, so
 * the second look is inside the interval and walks nothing.
 *
 * #5005 F4: the cell CONSTRUCTS that premise instead of assuming it. At the
 * shipped 2 s interval the fixture's own setup could exceed it on a slow host,
 * so the hook's look would walk, publish the created declaration, and the cell
 * would pass with the tool's forced-walk arm removed. The interval is pinned
 * wide for the hook's look, and the publisher is counted to prove that look
 * published nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4532-g5-";
const env = setupTestEnvironment(PREFIX);
const workspace = env.tmpDir;

/** The ambient each cell's outside writer declares (one per cell: the root's
 * record and the server's ambient set outlive a cell). */
const missingName = (declared: string) => `Cannot find name '${declared}'`;

async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

async function diagnose(
	file: string,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		`probe-4532-g5`,
		{ path: file, waitMs: 3000, serverScope: "primary", concurrency: 1 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

/** The look the pi `tool_call` hook runs, at the same root and trigger. */
async function hookLook(): Promise<void> {
	const { lookForOutOfBandChanges } =
		await import("../../clients/out-of-band-changes.js");
	await lookForOutOfBandChanges(workspace, "tool_call");
}

/**
 * Seed an importer that names an undeclared ambient, answer it once (the
 * server is ready and the finding is real), then run the hook's look so the
 * root's walk stamp is fresh.
 */
async function seedAndSettle(name: string, declared: string): Promise<string> {
	const importer = path.join(workspace, `${name}.ts`);
	fs.writeFileSync(importer, `console.log(${declared});\n`);
	const baseline = await diagnose(importer);
	expect(baseline.text).toContain(missingName(declared));
	await hookLook();
	return importer;
}

describe("a declaration file created inside the look's interval (#4532 gap 5)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: the fixture launches a project-configured server in a
		// project pi has trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		const shim = path.join(workspace, "closed-file-server.mjs");
		fs.writeFileSync(
			shim,
			[
				'process.env.FAKE_LSP_CLOSED_FILE_CACHE = "1";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					"fake-ts": {
						name: "closed file cache server",
						extensions: [".ts"],
						command: process.execPath,
						args: [shim],
						rootMarkers: ["package.json"],
					},
				},
				disabledServers: [
					"typescript",
					"deno",
					"ast-grep",
					"typos",
					"opengrep",
				],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		service = (await lspService()) as unknown as typeof service;
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
	});

	it("answers clean on the first call after the hook's look was inside the interval", async () => {
		const declared = "G_WINDOW";
		const importer = await seedAndSettle("window", declared);
		fs.mkdirSync(path.join(workspace, "types-window"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, "types-window", "ambient.d.ts"),
			`declare const ${declared}: string;\n`,
		);
		// The hook's own look for this call: inside the interval, so it walks
		// nothing and publishes nothing. The interval stays pinned wide until the
		// tool's own answer, so neither the hook's look nor the tool's
		// interval-eligible pass can walk on any host; only the tool's
		// `walk: "always"` arm may. The publish count proves the hook's look did
		// nothing rather than trusting the pin (#5005 F4).
		const hookPublishes: DiskChange[] = [];
		const unsubscribe = subscribeDiskChange(
			"probe-4532-g5-hook",
			(change) => {
				hookPublishes.push(change);
			},
			["out-of-band"],
		);
		const priorInterval = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "600000";
		let first: Awaited<ReturnType<typeof diagnose>>;
		try {
			await hookLook();
			unsubscribe();
			expect(hookPublishes).toEqual([]);
			first = await diagnose(importer);
		} finally {
			unsubscribe();
			if (priorInterval === undefined)
				delete process.env.PI_LENS_DECLARATION_LOOK_MS;
			else process.env.PI_LENS_DECLARATION_LOOK_MS = priorInterval;
		}

		expect(first.text).not.toContain(missingName(declared));
		expect(first.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// Control: the walk IS the mechanism. With the interval out of the way the
	// hook's own look publishes the created declaration and the same call reads
	// clean without the tool body doing anything extra — so the cell above pins
	// the missing walk, not some other path to the server.
	it("reads clean when the hook's look itself walks (control)", async () => {
		const declared = "G_CONTROL";
		const importer = await seedAndSettle("control", declared);
		fs.mkdirSync(path.join(workspace, "types-control"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, "types-control", "ambient.d.ts"),
			`declare const ${declared}: string;\n`,
		);
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		try {
			await hookLook();
		} finally {
			delete process.env.PI_LENS_DECLARATION_LOOK_MS;
		}

		const first = await diagnose(importer);

		expect(first.text).not.toContain(missingName(declared));
	}, 30_000);
});
