import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadProjectDiagnosticsSnapshot } from "../../clients/project-diagnostics/cache.js";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import { removeTempDirSync } from "./test-utils.js";

let cwd: string;
let files: string[];
beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bulk-yields-"));
	fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"yield-fixture"}');
	files = Array.from({ length: 4 }, (_, i) => path.join(cwd, `source${i}.ts`));
	for (const [i, file] of files.entries()) {
		fs.writeFileSync(
			file,
			`export function value${i}() { console.log("probe"); return ${i}; }\n`,
		);
	}
});
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	// Drain observer callbacks even when a regression assertion fails.
	await new Promise<void>((resolve) => setImmediate(resolve));
	removeTempDirSync(cwd);
});

// Observe real filesystem work. Each file queues an independent host callback;
// the next file must not be read until that callback has had a chance to run.
function observeReads(onDelivered?: () => void) {
	const original = fs.readFileSync;
	const reads: Array<{ file: string; delivered: number }> = [];
	let delivered = 0;
	vi.spyOn(fs, "readFileSync").mockImplementation(
		(...args: Parameters<typeof original>) => {
			const file = String(args[0]);
			if (files.includes(file) && reads.at(-1)?.file !== file) {
				reads.push({ file, delivered });
				setImmediate(() => {
					delivered++;
					onDelivered?.();
				});
			}
			return original(...args);
		},
	);
	syncBuiltinESMExports();
	return reads;
}

it("warm project scan delivers pending host work between file reads", async () => {
	const options = { cwd, tier: "all" as const, files };
	const before = await scanProjectDiagnostics(options);
	expect(before.diagnostics.length).toBeGreaterThan(0);
	const reads = observeReads();
	const after = await scanProjectDiagnostics(options);
	expect(reads.map((r) => r.file)).toEqual(files);
	expect(reads.map((r) => r.delivered)).toEqual([0, 1, 2, 3]);
	expect(after.diagnostics).toEqual(before.diagnostics);
}, 30_000);

it.each([1, 4])(
	"scan observes a host abort after file %i without persisting partial results",
	async (abortAfter) => {
		await scanProjectDiagnostics({ cwd, tier: "all", files });
		const controller = new AbortController();
		let delivered = 0;
		const reads = observeReads(() => {
			if (++delivered === abortAfter) controller.abort();
		});
		const result = await scanProjectDiagnostics({
			cwd,
			tier: "all",
			signal: controller.signal,
		});
		expect(controller.signal.aborted).toBe(true);
		expect(reads.map((r) => r.file)).toEqual(files.slice(0, abortAfter));
		expect(result.runners).not.toContain("ast-grep-napi");
		expect(result.diagnostics.some((d) => d.runner === "ast-grep-napi")).toBe(
			false,
		);
		expect(loadProjectDiagnosticsSnapshot(cwd)).toBeUndefined();
	},
	30_000,
);
