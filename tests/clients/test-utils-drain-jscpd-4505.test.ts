/**
 * #4505: the default test drain (`drainBackgroundWritesForTests`, which every
 * `cleanupTestEnvironmentsDrained` caller runs) waits for a resident jscpd scan.
 *
 * Recurrence: `tests/clients/cascade-unanswered-primary-4403.test.ts` drives
 * `session_start`, which fires a jscpd scan nothing awaits. Its last case ended
 * while that scan was still running; Vitest SIGTERMed the fork before the scan's
 * `finally` removed its report directory, and the pre-push hook's
 * tmp-fixture-hygiene test blocked two pushes of #4491 on the stranded
 * `pi-lens-jscpd-*` entry. Only `tests/index-integration.test.ts` drained the
 * scan (#4133), by its own call. The drain every drained cleanup already runs
 * for the other background writers now includes it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { gatedPromise } from "../support/fault-injection.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./test-utils.js";

const PREFIX = "pi-lens-4505-drain-";
/** Enough event-loop turns for a warm drain to finish if nothing holds it. */
async function settleTurns(): Promise<void> {
	for (let turn = 0; turn < 200; turn++)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

interface JscpdInternals {
	ensureAvailable: () => Promise<boolean>;
	hasSourceFilesRecursive: (dir: string) => boolean;
	runScan: () => Promise<unknown>;
}

describe("the default test drain and a resident jscpd scan (#4505)", () => {
	afterAll(async () => {
		const { _resetAnalyzerBootstrapForTests } =
			await import("../../clients/bootstrap.js");
		_resetAnalyzerBootstrapForTests();
		await cleanupTestEnvironmentsDrained(PREFIX);
	});

	it("waits for a scan the resident bootstrap client started", async () => {
		const { loadBootstrapClients } = await import("../../clients/bootstrap.js");
		const { jscpdClient } = await loadBootstrapClients();
		const { tmpDir } = setupTestEnvironment(PREFIX);
		const gate = gatedPromise<unknown>();
		const internals = jscpdClient as unknown as JscpdInternals;
		vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(internals, "hasSourceFilesRecursive").mockReturnValue(true);
		vi.spyOn(internals, "runScan").mockReturnValue(gate.promise);

		// The first drain loads the writer modules; a warm one is what the
		// pending check below times.
		await drainBackgroundWritesForTests();
		void jscpdClient.scan(tmpDir, 5, 50, false);
		await settleTurns();
		let drained = false;
		const drain = drainBackgroundWritesForTests().then(() => {
			drained = true;
		});
		await settleTurns();
		expect(drained).toBe(false);

		gate.resolve({});
		await drain;
		expect(drained).toBe(true);
	});
});
