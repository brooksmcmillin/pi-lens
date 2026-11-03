import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticLogger } from "../../../clients/diagnostic-logger.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { runAstGrepWarningScan } from "../../../clients/dispatch/integration.js";
import { getGlobalPiLensLogDir } from "../../../clients/probe-home-state.js";
import { setupTestEnvironment } from "../test-utils.js";

const pi = { getFlag: () => false };

describe("ast-grep warning scan runner identity (#4312)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-warning-scan-id-");
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
	});

	afterEach(async () => {
		await getDiagnosticLogger().flush();
		vi.unstubAllEnvs();
		env.cleanup();
	});

	async function scan(extension: string): Promise<Record<string, unknown>[]> {
		const filePath = path.join(env.tmpDir, `sample.${extension}`);
		// The real bundled enforce-node-protocol rule has warning severity.
		fs.writeFileSync(filePath, 'import fs from "fs";\nexport const x = fs;\n');
		const context = {
			model: "test",
			sessionId: path.basename(env.tmpDir),
			turnIndex: 0,
			writeIndex: 0,
		};
		await runAstGrepWarningScan(
			filePath,
			env.tmpDir,
			pi,
			context,
			new FactStore(),
		);

		const logFile = path.join(
			getGlobalPiLensLogDir(),
			"logs",
			`${new Date().toISOString().slice(0, 10)}.jsonl`,
		);
		await getDiagnosticLogger().flush();
		return (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.sessionId === context.sessionId);
	}

	it("writes a seeded warning to diagnostic history through real dispatch", async () => {
		// #4312: an unregistered runner id silently selected no runner.
		const entries = await scan("ts");
		expect(entries).toContainEqual(
			expect.objectContaining({
				tool: "ast-grep-napi",
				ruleId: "enforce-node-protocol",
				severity: "warning",
				shownInline: false,
				shownToAgent: false,
			}),
		);
	});

	it("leaves non-jsts files out of the warning scan", async () => {
		expect(await scan("txt")).toEqual([]);
	});
});
