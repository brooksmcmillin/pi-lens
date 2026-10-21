/**
 * #1634 recurrence: `pilens_project_scan` (mcp/server.ts) rendered the cheap
 * project scan's raw rows. `lens-engine.ts`'s `projectScan` is the seam that
 * tool calls, and it applied no finding policy, so a finding the agent marked
 * false-positive through `lens_diagnostic_mark` still came back on the MCP
 * project scan while every other surface dropped it.
 *
 * Driven through the production scanner on a real file and a mark made by the
 * production mark tool; nothing is mocked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import { projectScan } from "../../clients/lens-engine.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { removeTempDirSync } from "./test-utils.js";

describe("projectScan honors finding dispositions (#1634)", () => {
	let cwd: string;
	let filePath: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1634-scan-"));
		filePath = path.join(cwd, "a.ts");
		fs.writeFileSync(
			filePath,
			"export function f(x: unknown) {\n\tconsole.log(x);\n\treturn x;\n}\n",
		);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(cwd, ".data");
		_resetDeferredForTests();
		_resetStateCacheForTests();
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetDeferredForTests();
		_resetStateCacheForTests();
		removeTempDirSync(cwd);
	});

	it("drops a finding marked false-positive and counts it", async () => {
		const first = await projectScan(cwd);
		const target = first.diagnostics.find((d) => d.filePath === filePath);
		expect(target, JSON.stringify(first.diagnostics)).toBeDefined();
		if (!target) return;
		const others = first.diagnostics.filter((d) => d !== target).length;

		const marked = await createLensDiagnosticMarkTool(() => cwd).execute(
			"mark-1634-scan",
			{
				filePath,
				line: target.line,
				message: target.message,
				rule: target.rule,
				tool: target.tool,
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd },
		);
		expect(marked.isError).toBeFalsy();

		const second = await projectScan(cwd);
		const same = (d: (typeof second.diagnostics)[number]) =>
			d.filePath === target.filePath &&
			d.line === target.line &&
			d.rule === target.rule &&
			d.message === target.message;
		expect(second.diagnostics.some(same)).toBe(false);
		expect(second.diagnostics).toHaveLength(others);
		expect(second.dispositionSuppressed).toBe(1);
	});
});
