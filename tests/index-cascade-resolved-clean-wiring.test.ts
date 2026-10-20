import { afterEach, describe, expect, it } from "vitest";
import { createPiMock } from "./support/pi-mock.js";
import type { Diagnostic } from "../clients/dispatch/types.js";
import { normalizeMapKey } from "../clients/path-utils.js";

/**
 * #4487 wiring guard at the index.ts seam: the late clean answer for a
 * neighbour must clear that neighbour's pending cascade errors.
 *
 * Recurrence: a neighbour the agent fixed between turns, whose clean publish
 * arrived only after the cascade stopped waiting, kept its old errors on
 * every later turn_end's unresolved line. turn_end's peek and the quiet
 * window's reconcile hand that clean answer to whatever `onResolvedClean`
 * index.ts registered; the record forgets the entry only if index.ts wires
 * `forgetCascadePendingNeighbor` there. The cascade-tier tests drive their
 * own callback, so only an activated extension shows the wiring.
 */

afterEach(async () => {
	const { resetCascadePendingNeighbors } =
		await import("../clients/cascade-format.js");
	const { _resetOutstandingCascadeTouchesForTests } =
		await import("../clients/lsp/cascade-tier.js");
	resetCascadePendingNeighbors();
	_resetOutstandingCascadeTouchesForTests();
});

describe(
	"index cascade resolved-clean wiring (#4487)",
	{ timeout: 30_000 },
	() => {
		it("a late clean answer clears the neighbour's pending cascade errors", async () => {
			const { default: registerExtension } = await import("../index.js");
			registerExtension(createPiMock({}).asExtensionAPI() as never);

			const { listCascadePendingNeighbors, recordDeliveredCascadeNeighbor } =
				await import("../clients/cascade-format.js");
			const { peekOutstandingCascadeTouches, recordOutstandingCascadeTouch } =
				await import("../clients/lsp/cascade-tier.js");

			const neighbor = "/repo/src/b.ts";
			const now = Date.now();
			const error = {
				id: "typescript:2322",
				message: "Type 'string' is not assignable to type 'number'.",
				filePath: neighbor,
				line: 2,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
			} as Diagnostic;
			recordDeliveredCascadeNeighbor(neighbor, [error], 1, now - 300);

			// The server the touch went to has since published the file clean.
			const client = {
				serverId: "typescript",
				getAllDiagnostics: () =>
					new Map([[normalizeMapKey(neighbor), { diags: [], ts: now - 100 }]]),
			};
			recordOutstandingCascadeTouch({
				filePath: neighbor,
				serverId: "typescript",
				client: new WeakRef(client),
				touchedAt: now - 200,
			});
			expect(listCascadePendingNeighbors().map((e) => e.filePath)).toEqual([
				neighbor,
			]);

			peekOutstandingCascadeTouches();

			expect(listCascadePendingNeighbors()).toEqual([]);
		});
	},
);
