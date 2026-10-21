/**
 * Tests for the failure classifier in scripts/rpc-load-check.mjs (#4401).
 *
 * Recurrence these guard: #4314 (a failed LSP warm is an `extension.log` warn
 * line, so the old get_commands-only check passed on a broken tarball) and
 * #4400 (a failing snapshot worker killed pi at session start). Every
 * input below is a shape recorded from a real `pi --mode rpc` run (pi 1.1.0)
 * or from a real pi-lens log, not a hand-built stand-in.
 */
import { describe, expect, it } from "vitest";
import {
	logRecordFailure,
	rpcMessageFailure,
	tsServerOutcome,
} from "../../scripts/rpc-load-check.mjs";

// Recorded from `pi --mode rpc` with an extension that called ctx.ui.notify
// three times and then threw from its session_start handler.
const WARNING_NOTICE = JSON.parse(
	'{"type":"extension_ui_request","id":"3011d2ae","method":"notify","message":"planted warning notice","notifyType":"warning"}',
);
const ERROR_NOTICE = JSON.parse(
	'{"type":"extension_ui_request","id":"a3a36e30","method":"notify","message":"planted error notice","notifyType":"error"}',
);
const INFO_NOTICE = JSON.parse(
	'{"type":"extension_ui_request","id":"98efb061","method":"notify","message":"planted info notice"}',
);
const EXTENSION_ERROR = JSON.parse(
	'{"type":"extension_error","extensionPath":"/x/ext.mjs","event":"session_start","error":"planted session_start throw"}',
);
const STATUS_REQUEST = JSON.parse(
	'{"type":"extension_ui_request","id":"f4eb66b5","method":"setStatus","statusKey":"pi-lens-lsp","statusText":"LSP Inactive"}',
);

describe("rpcMessageFailure", () => {
	it("fails a warning notice, an error notice and an extension_error", () => {
		expect(rpcMessageFailure(WARNING_NOTICE)).toContain("planted warning");
		expect(rpcMessageFailure(ERROR_NOTICE)).toContain("planted error");
		expect(rpcMessageFailure(EXTENSION_ERROR)).toContain(
			"planted session_start throw",
		);
	});

	it("passes an info notice (notifyType defaults to info) and non-notice traffic", () => {
		expect(rpcMessageFailure(INFO_NOTICE)).toBeUndefined();
		expect(rpcMessageFailure(STATUS_REQUEST)).toBeUndefined();
		expect(
			rpcMessageFailure({ type: "response", command: "get_commands" }),
		).toBeUndefined();
		expect(rpcMessageFailure(null)).toBeUndefined();
	});

	it("fails the older event-wrapped extension_error shape", () => {
		expect(
			rpcMessageFailure({
				type: "event",
				event: "extension_error",
				error: "boom",
			}),
		).toContain("boom");
	});
});

// Recorded from extension.log / latency.log of real pi-lens runs.
const LSP_WARM_FAILED = {
	ts: "2026-10-14T14:15:29.348Z",
	pid: 1,
	level: "warn",
	subsystem: "lsp",
	message:
		"LSP warm failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/p/dist/lsp/capabilities.js'",
};
const UNTRUSTED_REFUSAL = {
	level: "warn",
	subsystem: "project-trust",
	message: "install/materialization blocked: lsp install: typescript",
	metadata: { context: "lsp install: typescript", trustState: "untrusted" },
};
const FORCED =
	"forced snapshot worker failure (PI_LENS_TEST_SNAPSHOT_WORKER_FAIL)";
const fallback = (reason: string, degraded: boolean) => ({
	type: "phase",
	phase: "project_snapshot_worker_fallback",
	metadata: { reason, seq: 0, degraded },
});

describe("logRecordFailure", () => {
	it("fails a warn or error line in extension.log (the #4314 shape)", () => {
		expect(logRecordFailure("extension.log", LSP_WARM_FAILED)).toContain(
			"LSP warm failed",
		);
		expect(
			logRecordFailure("extension.log", { level: "error", subsystem: "x" }),
		).toContain("error");
	});

	it("passes debug lines and fails every warn, including the old untrusted-project refusal", () => {
		expect(
			logRecordFailure("extension.log", { level: "debug", subsystem: "x" }),
		).toBeUndefined();
		// Round 2 of #4409: this refusal used to be allow-listed, which hid a
		// smoke project that was untrusted and so never ran the LSP spawn. The
		// smoke now trusts its project; a refusal there is a defect.
		expect(logRecordFailure("extension.log", UNTRUSTED_REFUSAL)).toContain(
			"install/materialization blocked",
		);
		expect(
			logRecordFailure("extension.log", {
				level: "warn",
				subsystem: "lsp-registry",
				message: "project-local LSP binary refused: mark the project trusted",
			}),
		).toContain("lsp-registry");
	});

	it("fails latency.log phases named *_failed and *_error", () => {
		expect(
			logRecordFailure("latency.log", {
				type: "phase",
				phase: "project_snapshot_persist_failed",
				metadata: { error: "EACCES" },
			}),
		).toContain("project_snapshot_persist_failed");
		expect(
			logRecordFailure("latency.log", {
				type: "phase",
				phase: "cascade_tier3_reconcile_error",
			}),
		).toContain("cascade_tier3_reconcile_error");
		expect(
			logRecordFailure("latency.log", { type: "phase", phase: "warmup_total" }),
		).toBeUndefined();
	});

	it("tolerates only the exact forced worker fallback in the failing-worker variant", () => {
		expect(
			logRecordFailure(
				"latency.log",
				fallback(FORCED, true),
				"forced snapshot worker failure",
			),
		).toBeUndefined();
		// The default run must treat the same degraded fallback as a failure.
		expect(logRecordFailure("latency.log", fallback(FORCED, true))).toContain(
			"degraded snapshot worker fallback",
		);
		// Any other degraded fallback reason is still a failure in the variant.
		expect(
			logRecordFailure(
				"latency.log",
				fallback("persist worker exited with code 1", true),
				"forced snapshot worker failure",
			),
		).toContain("exited with code 1");
		// The benign exit_hook flush is not degraded.
		expect(
			logRecordFailure("latency.log", fallback("exit_hook", false)),
		).toBeUndefined();
	});
});

// Recurrence: #4441 review F2, a refusal logged after a fixed read never
// reached the check. Shapes recorded from published 4.4.3 runs (a started
// server; a bare-PATH-tsc refusal).
describe("tsServerOutcome", () => {
	const SPAWNED = JSON.parse(
		'{"type":"phase","phase":"lsp_server_spawned","durationMs":1817,"metadata":{"serverId":"typescript","source":"managed","launchVariant":"classic"}}',
	);
	const OTHER_SERVER = JSON.parse(
		'{"type":"phase","phase":"lsp_server_spawned","durationMs":90,"metadata":{"serverId":"typos","source":"managed"}}',
	);
	const UNAVAILABLE =
		"[2026-10-14T17:55:30.738Z] lsp spawn typescript: unavailable (2288ms)";
	const START_ONLY =
		"[2026-10-14T17:55:28.450Z] lsp spawn typescript: start root=/p install=enabled file=/p/a.ts";

	it("reports started once the typescript server has spawned", () => {
		expect(tsServerOutcome([SPAWNED], START_ONLY)).toEqual({ started: true });
	});

	it("reports a terminal failure line, not a start line", () => {
		expect(tsServerOutcome([], `${START_ONLY}\n${UNAVAILABLE}\n`)).toEqual({
			started: false,
			line: UNAVAILABLE,
		});
	});

	it("is undecided while the server is still spawning, and ignores other servers", () => {
		expect(tsServerOutcome([], `${START_ONLY}\n`)).toBeUndefined();
		expect(tsServerOutcome([OTHER_SERVER], "")).toBeUndefined();
	});
});
