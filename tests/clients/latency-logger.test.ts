import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());

vi.mock("../../clients/env-utils.js", () => ({ isTestMode: () => false }));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import { getLastLoggedPhase, logLatency } from "../../clients/latency-logger.js";

describe("latency-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
	});

	it("owns process and timestamp attribution instead of trusting caller fields", () => {
		logLatency({
			type: "phase",
			phase: "test",
			filePath: "fixture.ts",
			durationMs: 10,
			pid: -1,
			ts: "2000-01-01T00:00:00.000Z",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "test",
				pid: process.pid,
				ts: expect.not.stringContaining("2000-01-01"),
			}),
		);
	});
});

describe("getLastLoggedPhase (loop_block attribution, #1122/#1123)", () => {
	it("tracks the most recent phase entry", () => {
		logLatency({ type: "phase", phase: "graph_build", filePath: "<x>", durationMs: 5 });
		const last = getLastLoggedPhase();
		expect(last?.phase).toBe("graph_build");
		expect(last?.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
	});

	it("does not record loop_block itself as the last phase (no self-attribution)", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({ type: "phase", phase: "loop_block", filePath: "<pi-lens>", durationMs: 9000 });
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	it("does not let an availability decision win block attribution (#1467)", () => {
		logLatency({ type: "phase", phase: "knip", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "availability_decision",
			filePath: "<pi-lens>",
			durationMs: 5528,
			metadata: { tool: "knip", cause: "host-stall" },
		});
		expect(getLastLoggedPhase()?.phase).toBe("knip");
	});

	it("ignores non-phase entries", () => {
		logLatency({ type: "phase", phase: "cascade", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "runner", filePath: "a.ts", durationMs: 1, runnerId: "biome" });
		expect(getLastLoggedPhase()?.phase).toBe("cascade");
	});

	// #1412 L3: the classic-TS first-open project-identity probe is a detached,
	// best-effort telemetry sample, not genuine work — it must not win
	// lastPhase and overwrite the real stall attribution for a loop_block that
	// happens to land right after a first open.
	it("does not record lsp_typescript_project_identity as the last phase (no probe self-attribution)", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "lsp_typescript_project_identity",
			filePath: "/repo/src/app.ts",
			durationMs: 12,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	// #1458 S5: lsp_aux_wait_outcome carries a REAL wait duration (unlike its
	// zero-duration LAST_PHASE_EXCLUDED siblings above) but is still a wait-
	// OUTCOME record, not the stall itself — pin its exclusion so a future edit
	// can't drop the entry and silently start misattributing loop_block stalls
	// to this summary row.
	it("does not record lsp_aux_wait_outcome as the last phase despite its real duration", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "lsp_aux_wait_outcome",
			filePath: "/repo/src/app.ts",
			durationMs: 1800,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});
});
