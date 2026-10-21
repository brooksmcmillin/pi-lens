/**
 * #4596: a rejected root release is recorded, not swallowed.
 *
 * The defect the audit found in #4563. `index.ts`'s `session_shutdown` released
 * a concurrent secondary's own root with
 * `deregisterInstanceRoot(...).catch(() => {})`: a rejection left the root
 * listed in the process-wide instance registry with nothing to explain it, so
 * a later session's registry walk reads a root no live session owns. The
 * comment said "best-effort bookkeeping — never fail teardown", which is a
 * decision about THROWING, not about recording (AGENTS.md shape 31).
 *
 * The record lives at the registry's owner (`recordRootDeregistrationFailure`
 * in `clients/instance-registry.ts`) so every caller of the queued removal
 * inherits it; `index.ts`'s `.catch` calls it. That arm cannot be driven end to
 * end: `deregisterInstanceRootNow` catches every filesystem failure it can
 * classify, so only a defect can make the queued op reject. This file drives
 * the record seam directly, and `tests/config/silent-catch-sweep.test.ts` is
 * what keeps `index.ts`'s `.catch` calling it instead of `() => {}`.
 *
 * Cells, written before the fix:
 *
 * | Input | Row |
 * |---|---|
 * | a rejection naming a root | one `instance-registry-deregister-root-failed` row whose subject is the root and whose reason carries the root, the holder and the error |
 * | a second rejection, same root | the same group, count 2 (counted, not once-per-root) |
 * | a rejection for another root | a second subject |
 * | a non-Error rejection | recorded with its `String(...)` form, never dropped |
 * | the flushed durable row | its metadata carries `root`, `holder` AND the error (`err`), because `logDurableDegradation` persists metadata but not the reason (#4603 F6) |
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { recordRootDeregistrationFailure } from "../../clients/instance-registry.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";

const ROOT = "/work/lane-root";
const HOLDER = "secondary:11111111-1111-1111-1111-111111111111";

function group() {
	return getDegradationSummary().find(
		(candidate) =>
			candidate.kind === "instance-registry-deregister-root-failed",
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

describe("a rejected root release", () => {
	it("records the root and the error", () => {
		recordRootDeregistrationFailure(
			ROOT,
			HOLDER,
			new Error("EACCES: permission denied, instances.json"),
		);

		const recorded = group();
		expect(recorded?.count).toBe(1);
		expect(recorded?.latestReasons[0].subject).toBe(ROOT);
		expect(recorded?.latestReasons[0].reason).toContain(ROOT);
		expect(recorded?.latestReasons[0].reason).toContain(HOLDER);
		expect(recorded?.latestReasons[0].reason).toContain("EACCES");
	});

	it("counts a repeat rejection for the same root", () => {
		recordRootDeregistrationFailure(ROOT, HOLDER, new Error("first"));
		recordRootDeregistrationFailure(ROOT, HOLDER, new Error("second"));

		expect(group()?.count).toBe(2);
		expect(group()?.latestReasons).toHaveLength(1);
		expect(group()?.latestReasons[0].reason).toContain("second");
	});

	it("keeps one subject per root", () => {
		recordRootDeregistrationFailure(ROOT, HOLDER, new Error("one"));
		recordRootDeregistrationFailure(
			"/work/other-root",
			HOLDER,
			new Error("two"),
		);

		expect(
			group()
				?.latestReasons.map((entry) => entry.subject)
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		).toEqual(["/work/lane-root", "/work/other-root"]);
	});

	it("records a rejection that is not an Error", () => {
		recordRootDeregistrationFailure(ROOT, HOLDER, "registry tail aborted");

		expect(group()?.latestReasons[0].reason).toContain("registry tail aborted");
	});

	it("writes the root, the holder and the error into the durable row", async () => {
		// The in-process summary carries the reason; only the durable row carries
		// metadata, so a monitor reading `latency.log` sees the error here or not
		// at all. `PI_LENS_TEST_MODE=0` is the sanctioned opt-out that lets the
		// real sink write (the worker's own hermetic home), scoped to this case.
		const previousMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		await flushLatencyLog();
		try {
			recordRootDeregistrationFailure(
				ROOT,
				HOLDER,
				new Error("EACCES: permission denied, instances.json"),
			);
			await flushLatencyLog();
		} finally {
			if (previousMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousMode;
		}

		const rows = fs
			.readFileSync(getLatencyLogPath(), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter(
				(row) =>
					row.filePath === ROOT &&
					(row.metadata as Record<string, unknown> | undefined)?.kind ===
						"instance-registry-deregister-root-failed" &&
					String((row.metadata as Record<string, unknown>).err).includes(
						"EACCES",
					),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject({
			root: ROOT,
			holder: HOLDER,
			err: "EACCES: permission denied, instances.json",
		});
	});
});
