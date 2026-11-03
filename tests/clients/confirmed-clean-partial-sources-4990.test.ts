/**
 * #4990 gap 1 — a confirmed-clean verdict that covers only SOME of a record's
 * sources must still retire the rows it spoke for.
 *
 * The reported incident: a record's sources were `["lsp", "oxlint"]`. The
 * typescript server came back clean for the file
 * (`confirmedDiagnosticCount: 0`), but
 * `retireInlineBlockerOnConfirmedClean` failed closed unless
 * `coveredSources ⊇ record.sources`. One language server cannot speak for the
 * oxlint row, so the whole record — including the server rows it HAD just
 * disproved — outlived the clean verdict and kept re-serving dead coordinates.
 *
 * The fix is per-source row retirement, inside the same seam: the record keeps
 * the rows whose source the verdict did not cover and narrows its derived
 * fields to those rows. These cases drive that seam directly (it owns the
 * ordering token and the fail-closed rules); the shipped `lens_diagnostics`
 * wiring is covered by `tests/tools/lsp-diagnostics-inline-blocker-retire.test.ts`
 * and the commit gate by `tests/clients/git-guard.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

function diagnostic(
	filePath: string,
	line: number,
	tool: string,
	message: string,
): Diagnostic {
	return {
		id: `${tool}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool,
		rule: tool === "lsp" ? "typescript:2304" : "no-eval",
	};
}

function record(
	runtime: RuntimeCoordinator,
	filePath: string,
	diagnostics: Diagnostic[],
	sources?: string[],
): void {
	runtime.recordInlineBlockers(
		filePath,
		formatDiagnostics(diagnostics, "blocking").trim(),
		runtime.nextWriteIndex(),
		sources ?? [...new Set(diagnostics.map((d) => d.tool ?? "unknown"))],
		diagnostics
			.map((d) => d.line)
			.filter((line): line is number => typeof line === "number"),
		undefined,
		diagnostics,
	);
}

describe("#4990 gap 1 — a clean verdict retires the source rows it covers", () => {
	it("drops the covered rows and keeps the uncovered source, rebuilding the derived fields", () => {
		const env = setupTestEnvironment("pi-lens-4990-partial-rows-");
		try {
			const filePath = path.join(env.tmpDir, "upstreams.ts");
			fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, filePath, [
				diagnostic(filePath, 1, "lsp", "Cannot find name 'setCached'."),
				diagnostic(filePath, 2, "oxlint", "no-eval is banned"),
			]);
			const before = runtime.getInlineBlockersSnapshot()[0];
			expect(before?.sources).toEqual(["lsp", "oxlint"]);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					filePath,
					runtime.nextWriteIndex(),
					["lsp"],
				),
			).toBe(true);

			const after = runtime.getInlineBlockersSnapshot();
			expect(after).toHaveLength(1);
			// The row the language server just disproved is gone…
			expect(after[0]?.summary).not.toContain("setCached");
			expect(after[0]?.diagnostics?.map((d) => d.tool)).toEqual(["oxlint"]);
			// …and the record's derived fields now describe only what is left, so
			// the next clean verdict that DOES cover oxlint can retire it.
			expect(after[0]?.sources).toEqual(["oxlint"]);
			expect(after[0]?.lines).toEqual([2]);
			// A narrowed record is not a resolved file: the oxlint finding still
			// gates, so turn end must not claim the file was cleared.
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("retires the whole record when the covered rows are all of it", () => {
		const env = setupTestEnvironment("pi-lens-4990-partial-all-");
		try {
			const filePath = path.join(env.tmpDir, "clean.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			// `sources` names a row no diagnostic backs: the covered rows are all
			// the structured rows, so nothing survives the split.
			record(
				runtime,
				filePath,
				[diagnostic(filePath, 1, "lsp", "Cannot find name 'x'.")],
				["lsp", "oxlint"],
			);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					filePath,
					runtime.nextWriteIndex(),
					["lsp"],
				),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a record whose partial coverage has no structured rows to split", () => {
		const env = setupTestEnvironment("pi-lens-4990-partial-unstructured-");
		try {
			const filePath = path.join(env.tmpDir, "legacy.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			// A legacy/hand-authored record: sources but no diagnostics, so there
			// is no honest per-source split. It must fail closed, as before.
			runtime.recordInlineBlockers(
				filePath,
				"🔴 STOP — 1 issue(s) must be fixed:",
				runtime.nextWriteIndex(),
				["lsp", "oxlint"],
			);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					filePath,
					runtime.nextWriteIndex(),
					["lsp"],
				),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a record when the verdict covers none of its sources", () => {
		const env = setupTestEnvironment("pi-lens-4990-partial-none-");
		try {
			const filePath = path.join(env.tmpDir, "security.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, filePath, [
				diagnostic(filePath, 1, "ast-grep", "cors-wildcard is unsafe"),
			]);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					filePath,
					runtime.nextWriteIndex(),
					["lsp"],
				),
			).toBe(false);
			const snapshot = runtime.getInlineBlockersSnapshot();
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.sources).toEqual(["ast-grep"]);
		} finally {
			env.cleanup();
		}
	});

	it("still refuses a clean verdict that is older than the record", () => {
		const env = setupTestEnvironment("pi-lens-4990-partial-order-");
		try {
			const filePath = path.join(env.tmpDir, "ordered.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			const token = runtime.nextWriteIndex();
			record(runtime, filePath, [
				diagnostic(filePath, 1, "lsp", "Cannot find name 'x'."),
				diagnostic(filePath, 2, "oxlint", "no-eval is banned"),
			]);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, token, ["lsp"]),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				2,
			);
		} finally {
			env.cleanup();
		}
	});
});
