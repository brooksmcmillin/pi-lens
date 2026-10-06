import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
function latestToolNames(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []).flatMap((tool) =>
		typeof (tool as { name?: unknown }).name === "string"
			? [(tool as { name: string }).name]
			: [],
	);
}

type PiResolution = { version?: string; skipReason?: string };

function resolvedPiPackage(): PiResolution {
	// The harness starts this same `pi` command. Some CI shims print the
	// version and still return non-zero, so the output—not the status—is the
	// evidence this witness needs.
	try {
		const resolved = spawnSync("pi", ["--version"], { encoding: "utf8" });
		if (resolved.error !== undefined)
			return {
				skipReason: `pi unavailable: --version could not spawn (${resolved.error.message})`,
			};
		if (typeof resolved.stdout !== "string" || resolved.stdout.trim() === "")
			return { skipReason: "pi unavailable: --version produced no stdout" };
		const version = resolved.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
		return version === undefined
			? { skipReason: "pi unavailable: --version had no parseable version" }
			: { version };
	} catch (error) {
		return {
			skipReason: `pi unavailable: --version probe threw (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

const installedPi = resolvedPiPackage();

async function runInstalledPi(installed: { version: string }): Promise<void> {
	expect(installed.version, "installed pi version").toMatch(/^\d+\.\d+\.\d+$/);

	await withRealPi(
		{ fixture: "scenario-1", script: "script.json", args: ["--no-lazy-tools"] },
		async (pi) => {
			await pi.prompt(
				`report the active tool roster from the installed pi${
					installed.version ? ` ${installed.version}` : ""
				}`,
			);
			await pi.awaitAssistantTurn();
			const names = latestToolNames(pi);
			expect(names.length, "installed pi active roster").toBeGreaterThan(0);
			expect(names).toContain("lens_diagnostics");
		},
	);

	await withRealPi(
		{
			fixture: "tools-disabled",
			script: "script.json",
			args: ["--no-lazy-tools"],
			env: { PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("report the project-disabled roster");
			await pi.awaitAssistantTurn();
			const names = latestToolNames(pi);
			expect(
				names.length,
				"installed pi project-disabled roster",
			).toBeGreaterThan(0);
			expect(names).not.toContain("ast_grep_replace");
		},
	);

	await withRealPi(
		{
			fixture: "cli-no-tool",
			script: "script.json",
			args: ["--no-lazy-tools", "--no-tool=lsp_navigation"],
			env: { PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("report the CLI-disabled roster");
			await pi.awaitAssistantTurn();
			const names = latestToolNames(pi);
			expect(names.length, "installed pi CLI-disabled roster").toBeGreaterThan(
				0,
			);
			expect(names).not.toContain("lsp_navigation");
		},
	);
}

async function observeProviderContext(
	contexts: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
	const root = mkdtempSync(
		path.join(repoRoot, ".probe-home", "provider-shape-"),
	);
	const script = path.join(root, "script.json");
	const observation = path.join(root, "provider.jsonl");
	writeFileSync(
		script,
		JSON.stringify(contexts.map(() => [{ type: "text", text: "ok" }])),
	);
	const previousScript = process.env.REAL_PI_HARNESS_SCRIPT;
	const previousObservation = process.env.REAL_PI_HARNESS_PROVIDER_LOG;
	process.env.REAL_PI_HARNESS_SCRIPT = script;
	process.env.REAL_PI_HARNESS_PROVIDER_LOG = observation;
	try {
		const providers: Array<Record<string, unknown>> = [];
		const providerModule =
			await import("../fixtures/real-harness/scripted-provider.mjs");
		providerModule.default({
			registerProvider: (_name: string, provider: Record<string, unknown>) =>
				providers.push(provider),
		});
		const streamSimple = providers[0].streamSimple as (
			model: Record<string, unknown>,
			context: Record<string, unknown>,
			options: Record<string, unknown>,
		) => unknown;
		const model = {
			api: "openai-completions",
			provider: "scripted",
			id: "harness",
		};
		for (const context of contexts) streamSimple(model, context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		return readFileSync(observation, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} finally {
		if (previousScript === undefined) delete process.env.REAL_PI_HARNESS_SCRIPT;
		else process.env.REAL_PI_HARNESS_SCRIPT = previousScript;
		if (previousObservation === undefined)
			delete process.env.REAL_PI_HARNESS_PROVIDER_LOG;
		else process.env.REAL_PI_HARNESS_PROVIDER_LOG = previousObservation;
		rmSync(root, { recursive: true, force: true });
	}
}

// flake-shape: real-process-spawn — the installed pi host must load the built extension and expose its provider roster across the process boundary
// #3636 regression: pi 0.86 moved provider tools from Context.tools into transcript system messages.
describe("real pi scripted-provider compatibility", () => {
	// SDK 1.0 removed the shrinkwrap layout; do not borrow another host's pi-ai.
	it.each(["hoisted", "nested", "override"])(
		"loads the scripted provider from the %s SDK dependency layout",
		async (layout) => {
			const root = mkdtempSync(
				path.join(repoRoot, ".probe-home", "provider-resolution-"),
			);
			const previous = process.env.REAL_PI_HARNESS_PI_AI_INDEX;
			try {
				const sdk = path.join(
					root,
					"node_modules/@earendil-works/pi-coding-agent",
				);
				const ai = path.join(
					layout === "nested" ? sdk : root,
					"node_modules/@earendil-works/pi-ai",
				);
				for (const dir of [sdk, ai]) {
					mkdirSync(path.join(dir, "dist"), { recursive: true });
					writeFileSync(
						path.join(dir, "package.json"),
						JSON.stringify({
							type: "module",
							exports: { ".": { import: "./dist/index.js" } },
						}),
					);
					writeFileSync(
						path.join(dir, "dist/index.js"),
						"export const createAssistantMessageEventStream = () => null;\n",
					);
				}
				if (layout === "nested") {
					const wrong = path.join(root, "node_modules/@earendil-works/pi-ai");
					mkdirSync(wrong, { recursive: true });
					writeFileSync(
						path.join(wrong, "package.json"),
						'{"type":"module","exports":"./index.js"}',
					);
					writeFileSync(
						path.join(wrong, "index.js"),
						'throw new Error("wrong SDK dependency");\n',
					);
				}
				if (layout === "override") {
					const explicit = path.join(root, "external-ai.mjs");
					writeFileSync(
						explicit,
						"export const createAssistantMessageEventStream = () => null;\n",
					);
					process.env.REAL_PI_HARNESS_PI_AI_INDEX = explicit;
					writeFileSync(
						path.join(ai, "dist/index.js"),
						'throw new Error("default SDK replaced explicit override");\n',
					);
				} else delete process.env.REAL_PI_HARNESS_PI_AI_INDEX;
				const provider = path.join(root, "provider.mjs");
				writeFileSync(
					provider,
					readFileSync(
						path.join(
							repoRoot,
							"tests/fixtures/real-harness/scripted-provider.mjs",
						),
						"utf8",
					),
				);
				expect((await import(pathToFileURL(provider).href)).default).toBeTypeOf(
					"function",
				);
			} finally {
				if (previous === undefined)
					delete process.env.REAL_PI_HARNESS_PI_AI_INDEX;
				else process.env.REAL_PI_HARNESS_PI_AI_INDEX = previous;
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("replays legacy and transcript tool contexts at the provider boundary", async () => {
		const transcriptContext = {
			messages: [
				{
					role: "system",
					toolsAdded: [{ name: "same", description: "new", parameters: {} }],
					toolsRemoved: [{ name: "same" }],
				},
				{
					role: "system",
					toolsAdded: [
						{ name: "removed_tool", description: "", parameters: {} },
						{ name: "current_tool", description: "", parameters: {} },
					],
				},
				{ role: "system", toolsRemoved: [{ name: "removed_tool" }] },
			],
		};
		const rows = await observeProviderContext([
			{ tools: [{ name: "legacy_tool", description: "", parameters: {} }] },
			transcriptContext,
			{},
			{},
		]);
		expect(
			(rows[0].tools as Array<{ name: string }>).map((tool) => tool.name),
		).toEqual(["legacy_tool"]);
		expect(
			(rows[1].tools as Array<{ name: string }>).map((tool) => tool.name),
		).toEqual(["same", "current_tool"]);
		expect(
			rows.filter(
				(row) => row.kind === "scripted-provider-context-shape-unavailable",
			),
		).toHaveLength(1);
		expect(rows.filter((row) => Array.isArray(row.tools))).toHaveLength(4);
	});

	it("preserves active and disabled rosters for the installed pi", async (ctx) => {
		ctx.skip(
			installedPi.skipReason !== undefined,
			installedPi.skipReason ?? "",
		);
		if (installedPi.version === undefined) return;
		await runInstalledPi({ version: installedPi.version });
	}, 180_000);
});
