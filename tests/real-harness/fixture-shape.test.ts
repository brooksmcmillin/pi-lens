import { afterEach, describe, expect, it, vi } from "vitest";
import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	realHarnessFixtureRoot,
	validateScript,
	withRepoBinOnPath,
	withRealPi,
} from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the child environment is the subject of this boundary test
describe("real harness fixture shape", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("requires every scenario to provide a project directory and valid script fields", () => {
		for (const scenario of readdirSync(realHarnessFixtureRoot)) {
			const dir = path.join(realHarnessFixtureRoot, scenario);
			if (!statSync(dir).isDirectory() || scenario.startsWith(".")) continue;
			expect(statSync(path.join(dir, "project")).isDirectory()).toBe(true);
			// Every script in the scenario, not only `script.json` (#2154): a
			// scenario whose sessions need different turn sequences — two live
			// children each replay from their OWN turn 0, so one script cannot
			// drive both — ships one file per role, and an unvalidated sibling
			// script is exactly the malformed fixture this gate exists to catch.
			const scripts = readdirSync(dir).filter((entry) =>
				entry.endsWith(".json"),
			);
			expect(scripts).toContain("script.json");
			for (const name of scripts) {
				const script = JSON.parse(
					readFileSync(path.join(dir, name), "utf8"),
				) as unknown;
				expect(() =>
					validateScript(script, `${scenario}/${name}`),
				).not.toThrow();
			}
		}
	});
	it("names the malformed field", () => {
		expect(() =>
			validateScript([[{ type: "text" }]], "broken/script.json"),
		).toThrow(/text must be a string/);
	});
	it("puts the repo bin dir first on the child PATH under any key casing (#3742)", () => {
		const head = [
			path.resolve("node_modules", ".bin"),
			path.dirname(process.execPath),
		];
		const joined = (...parts: string[]) => parts.join(path.delimiter);
		expect(withRepoBinOnPath({ PATH: "/usr/bin" })).toEqual({
			PATH: joined(...head, "/usr/bin"),
		});
		expect(withRepoBinOnPath({ Path: "C:\\Windows" })).toEqual({
			Path: joined(...head, "C:\\Windows"),
		});
		expect(withRepoBinOnPath({ PATH: "" })).toEqual({ PATH: joined(...head) });
		expect(withRepoBinOnPath({})).toEqual({ PATH: joined(...head) });
	});
	it("gives real pi children a TMPDIR under their removable home (#4133)", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json" },
			async (pi) => {
				expect(pi.childEnvironment().TMPDIR).toBe(
					path.join(pi.homePath(), "tmp"),
				);
				expect(pi.childEnvironment().TMP).toBe(pi.childEnvironment().TMPDIR);
				expect(pi.childEnvironment().TEMP).toBe(pi.childEnvironment().TMPDIR);
				expect(statSync(pi.childTempDir()).isDirectory()).toBe(true);
			},
		);
	});
	// Recurrence prevented (#4513): pi 1.3 pins pi-ai exactly, and which layout npm
	// produces (pi-ai hoisted beside the host, or nested under it as 1.0.0's
	// shrinkwrap did, #4004) changes with the dependency tree. A fixture that
	// finds only one layout reds every real-harness test on the other.
	it.each([
		["hoisted beside the host", ["pi-ai"]],
		[
			"nested under the host",
			["pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"],
		],
	])("resolves the scripted provider's pi-ai %s", async (layout, segments) => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-4513-pi-ai-");
		try {
			const fixtureDir = path.join(tmpDir, "tests/fixtures/real-harness");
			mkdirSync(fixtureDir, { recursive: true });
			copyFileSync(
				path.join(realHarnessFixtureRoot, "scripted-provider.mjs"),
				path.join(fixtureDir, "scripted-provider.mjs"),
			);
			writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}\n');
			const piAiDist = path.join(
				tmpDir,
				"node_modules/@earendil-works",
				...segments,
				"dist",
			);
			mkdirSync(piAiDist, { recursive: true });
			writeFileSync(
				path.join(piAiDist, "index.js"),
				`export const createAssistantMessageEventStream = () => ({ layout: ${JSON.stringify(layout)}, push() {}, end() {} });\n`,
			);
			const scriptFile = path.join(tmpDir, "script.json");
			writeFileSync(scriptFile, '[[{"type":"text","text":"x"}]]\n');
			vi.stubEnv("REAL_PI_HARNESS_SCRIPT", scriptFile);
			vi.stubEnv("REAL_PI_HARNESS_PI_AI_INDEX", undefined);
			const { default: provider } = (await import(
				pathToFileURL(path.join(fixtureDir, "scripted-provider.mjs")).href
			)) as { default: (pi: unknown) => void };
			let stream: { layout?: string } | undefined;
			provider({
				registerProvider: (
					_name: string,
					config: { streamSimple: (...args: unknown[]) => unknown },
				) => {
					stream = config.streamSimple({}, {}, {}) as { layout?: string };
				},
			});
			expect(stream?.layout).toBe(layout);
		} finally {
			cleanup();
		}
	});
});
