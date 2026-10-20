/**
 * #4484 round 3 (review probe P3): once the tree-sitter WASM runtime aborts,
 * the runner skips every file without reading it. That skip counted as a
 * verdict, so an edit elsewhere retired a recorded tree-sitter blocker and
 * the write said clean while the blocker was on disk.
 *
 * A file of its own: the abort is process-lifetime by design
 * (`markTreeSitterWasmAborted`), so it must not reach another test file's
 * module graph.
 */
import { afterEach, describe, expect, it } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import { reachedNoVerdict } from "../../../../clients/dispatch/types.js";
import { markTreeSitterWasmAborted } from "../../../../clients/tree-sitter-shared.js";
import { makeRealRunnerEnv } from "../../../support/real-runner-ctx.js";

describe("tree-sitter runner after a WASM abort (#4484 round 3)", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	// Recurrence: the abort skip read as a verdict and retired a recorded
	// blocker (review probe P3, TLC MutSkipVerdict).
	it("reports the skip after a WASM abort as reaching no verdict", async () => {
		markTreeSitterWasmAborted();
		const env = makeRealRunnerEnv();
		cleanup = env.cleanup;
		const result = await treeSitterRunner.run(
			env.addFile("aborted.ts", "function f() { debugger; }\n").ctx,
		);
		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
		expect(reachedNoVerdict(result)).toBe(true);
	});
});
