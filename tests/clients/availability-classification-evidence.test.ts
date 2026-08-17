/**
 * #1500 — a transient failure classified as durable INSIDE an already-governed
 * latch.
 *
 * Migrating a memo to the shared policy makes its storage correct and says
 * nothing about its classification. A call site can hand the latch
 * `("missing", "not-found")` for something that was really transient, and the
 * resulting row is a well-formed `missing` verdict: indistinguishable from a
 * genuine absence. The class is deliberately ungated, so the fix is auditability
 * — every decision record says HOW it was classified and carries the raw facts
 * it was derived from.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProbeFailure,
	describeProbeEvidence,
} from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatencySpy, ensureTool, getInstallAttempt } =
	vi.hoisted(() => ({
		safeSpawnAsync: vi.fn(),
		logLatencySpy: vi.fn(),
		ensureTool: vi.fn(),
		getInstallAttempt: vi.fn(),
	}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
}));
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	getInstallAttempt,
	isSpawnableCommand: async () => true,
	resetPathWalkMemo: () => {},
	getToolEnvironment: async () => ({ ...process.env }),
}));
vi.mock("../../clients/project-trust.js", () => ({
	assertInstallAllowed: () => true,
	projectTrustDenialReason: () => "",
}));
vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

import { SecurityScanClient } from "../../clients/security-scan-client.js";
import {
	createAvailabilityChecker,
	resetDispatchAvailabilityState,
} from "../../clients/dispatch/runners/utils/runner-helpers.js";

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const notFoundResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn faketool ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision")
		.map((entry) => entry.metadata);

class FakeScanClient extends SecurityScanClient<string[]> {
	constructor() {
		super("faketool");
	}
	protected doEnsureAvailable(): Promise<boolean> {
		return this.ensureViaInstaller(["--version"]);
	}
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	ensureTool.mockReset();
	getInstallAttempt.mockReset();
	resetDispatchAvailabilityState();
});

describe("probe evidence (#1500)", () => {
	it("reads the facts off a spawn result and omits what it does not carry", () => {
		expect(describeProbeEvidence(notFoundResult)).toEqual({
			status: null,
			failure: "spawn",
			spawnFailureKind: "tool-not-found",
			errno: "ENOENT",
		});
		// A plain nonzero exit carries a status and nothing else.
		expect(describeProbeEvidence({ status: 1 })).toEqual({ status: 1 });
	});

	it("comes back from classifyProbeFailure beside the verdict it produced", () => {
		const classified = classifyProbeFailure(timeoutResult);
		expect(classified.outcome).toBe("transient");
		expect(classified.evidence).toMatchObject({
			failure: "timeout",
			spawnFailureKind: "timeout",
		});
	});
});

describe("decision records say how they were classified (#1500)", () => {
	it("marks a derived verdict as probe-classified and shows the evidence", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-evidence-"));
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const checker = createAvailabilityChecker("faketool");

		expect(await checker.isAvailableAsync(cwd)).toBe(false);
		expect(decisions()[0]).toMatchObject({
			tool: "faketool",
			outcome: "transient",
			cause: "probe-timeout",
			classifiedBy: "probe",
			evidence: { failure: "timeout", spawnFailureKind: "timeout" },
		});
	});

	it("marks a stat-derived bad-cwd verdict as caller-asserted", async () => {
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		const checker = createAvailabilityChecker("faketool");

		expect(
			await checker.isAvailableAsync(
				path.join(os.tmpdir(), "pi-lens-does-not-exist-1500"),
			),
		).toBe(false);
		expect(decisions()[0]).toMatchObject({
			cause: "bad-cwd",
			classifiedBy: "caller",
		});
		// The workspace is gone; nothing here is evidence about the tool.
		expect(decisions()[0]?.evidence).toBeUndefined();
	});
});

describe("a failed install is a recorded assertion, not a silent latch (#1500)", () => {
	it("records the install failure beside the missing verdict", async () => {
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		ensureTool.mockResolvedValue(null);
		getInstallAttempt.mockReturnValue({
			outcome: "failed",
			reason: "download timed out",
			at: Date.now(),
		});
		const client = new FakeScanClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("faketool");

		// Two rows: the probe that found nothing, then the assertion that followed
		// the failed repair. Before #1500 the second one did not exist at all.
		expect(decisions()).toHaveLength(2);
		expect(decisions()[0]).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			classifiedBy: "probe",
			evidence: { errno: "ENOENT", spawnFailureKind: "tool-not-found" },
		});
		expect(decisions()[1]).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
			classifiedBy: "caller",
			evidence: { install: "failed" },
		});
	});

	it("does not claim an install failed when none was attempted", async () => {
		// `ensureTool` answers the same empty result whether it tried and failed or
		// declined to try. Writing `install: "failed"` for both fabricates an
		// attempt — the review found exactly that on the trust-denied path.
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		ensureTool.mockResolvedValue(null);
		getInstallAttempt.mockReturnValue({
			outcome: "declined",
			reason: "installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			at: Date.now(),
		});

		expect(await new FakeScanClient().ensureAvailable()).toBe(false);
		expect(decisions()[1]).toMatchObject({
			classifiedBy: "caller",
			evidence: { install: "not-attempted" },
		});
	});

	it("records the installer's reason when an attempt did fail", async () => {
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		ensureTool.mockResolvedValue(null);
		getInstallAttempt.mockReturnValue({
			outcome: "failed",
			reason: "release asset 404 for linux-arm64",
			at: Date.now(),
		});

		expect(await new FakeScanClient().ensureAvailable()).toBe(false);
		expect(decisions()[1]).toMatchObject({
			classifiedBy: "caller",
			evidence: {
				install: "failed",
				installReason: "release asset 404 for linux-arm64",
			},
		});
	});

	it("still refuses to install — or latch — on a timed-out probe", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const client = new FakeScanClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).not.toHaveBeenCalled();
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0]).toMatchObject({
			outcome: "transient",
			classifiedBy: "probe",
			latched: false,
		});
	});
});

/**
 * govulncheck writes its own durable-absence arms rather than going through
 * `ensureViaInstaller`, and the review found all three untested: reverting them
 * left 43 tests green. These cover each one, and each names the command its
 * evidence describes — `go` is not govulncheck, and a row that says otherwise is
 * the misreading the `command` field exists to prevent.
 */
describe("govulncheck's own durable-absence arms (#1500)", () => {
	async function govulncheck(): Promise<{
		ensureAvailable(): Promise<boolean>;
	}> {
		const { GovulncheckClient } = await import(
			"../../clients/govulncheck-client.js"
		);
		return new GovulncheckClient();
	}

	const goMissing = Object.assign(new Error("spawn go ENOENT"), {
		code: "ENOENT",
	});

	it("records the go preflight when go is not on PATH", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === "go"
				? {
						stdout: "",
						stderr: "",
						status: null,
						error: goMissing,
						failure: "spawn",
						spawnFailure: { kind: "tool-not-found" },
					}
				: notFoundResult,
		);

		expect(await (await govulncheck()).ensureAvailable()).toBe(false);
		const last = decisions()[decisions().length - 1];
		expect(last).toMatchObject({
			tool: "govulncheck",
			outcome: "missing",
			classifiedBy: "caller",
			evidence: {
				command: "go",
				errno: "ENOENT",
				install: "not-attempted",
			},
		});
	});

	it("records a durable `go install` failure as an attempt that failed", async () => {
		safeSpawnAsync.mockImplementation(
			async (cmd: string, args: string[]) => {
				if (cmd !== "go") return notFoundResult;
				if (args[0] === "version") return { stdout: "go1.22", stderr: "", status: 0 };
				// `go install` ran and refused: module not found, compile error.
				return { stdout: "", stderr: "no required module provides", status: 1 };
			},
		);

		expect(await (await govulncheck()).ensureAvailable()).toBe(false);
		const last = decisions()[decisions().length - 1];
		expect(last).toMatchObject({
			tool: "govulncheck",
			outcome: "missing",
			latched: true,
			classifiedBy: "caller",
			evidence: { command: "go install", status: 1, install: "failed" },
		});
	});

	it("records the install-succeeded-but-unlocatable arm instead of latching silently", async () => {
		// The third silent arm: `go install` succeeded, the binary is not on PATH
		// and not in $GOBIN/$GOPATH. Durable and actionable, and until now it went
		// quiet with no record — indistinguishable from a plain absence.
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "go" && args[0] === "version") {
				return { stdout: "go1.22", stderr: "", status: 0 };
			}
			if (cmd === "go" && args[0] === "install") {
				return { stdout: "", stderr: "", status: 0 };
			}
			// Both the first probe and the post-install re-probe miss.
			return notFoundResult;
		});

		expect(await (await govulncheck()).ensureAvailable()).toBe(false);
		const last = decisions()[decisions().length - 1];
		expect(last).toMatchObject({
			tool: "govulncheck",
			outcome: "missing",
			latched: true,
			classifiedBy: "caller",
			evidence: { command: "govulncheck", install: "succeeded" },
		});
		expect(last?.evidence).toMatchObject({
			installReason: expect.stringContaining("GOBIN"),
		});
	});
});
