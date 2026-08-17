/**
 * #1490 — psscriptanalyzer was the last unmigrated instance of the #1467 latch.
 *
 * Its hand-rolled `spawnPs` returned `status: null` for a timeout, a synchronous
 * `spawn UNKNOWN` and a missing binary alike, so the call site had no taxonomy
 * to classify and remembered every failure as "PowerShell analysis is not
 * available" for the session. Two changes, asserted here: the spawn goes
 * through `safeSpawnAsync`, and the verdict goes through the availability
 * policy.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatencySpy } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
}));
vi.mock("../../../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

/**
 * Fresh module state per test. The memoized verdicts live at module scope, and
 * reloading the module is the one reset that works against BOTH the pre-fix
 * code (which exposes no reset seam) and the migrated code — so the red-first
 * run fails on the latch, not on missing test scaffolding.
 */
async function loadRunner(): Promise<{
	run: (ctx: never) => Promise<{ status: string }>;
}> {
	vi.resetModules();
	const mod = await import(
		"../../../../clients/dispatch/runners/psscriptanalyzer.ts"
	);
	return mod.default;
}

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 30000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const notFoundResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn pwsh ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const ok = (stdout = "") => ({ stdout, stderr: "", status: 0 });
/** `Get-Module -ListAvailable` ran and found nothing: the module is absent. */
const moduleMissing = { stdout: "", stderr: "", status: 1 };

/** The child never started. Windows' `spawn UNKNOWN`, the #533 class. */
const spawnUnknownResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN" }),
	failure: "spawn",
	spawnFailure: { kind: "spawn-failed" },
};

/** PowerShell is present and refuses the probe: durable, but not missing. */
const rejectedResult = { stdout: "", stderr: "not authorized", status: 5 };

type Call = [string, string[], Record<string, unknown> | undefined];

const callsMatching = (needle: string): Call[] =>
	(safeSpawnAsync.mock.calls as Call[]).filter((call) =>
		call[1].some((arg) => arg.includes(needle)),
	);

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

function ctx(): never {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-psa-"));
	const filePath = path.join(cwd, "script.ps1");
	fs.writeFileSync(filePath, "Write-Output 'hi'\n");
	return { cwd, filePath } as never;
}

/** pwsh answers, the module is present, the analysis finds nothing. */
function healthyHost(): void {
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
		args.includes("-File") ? ok("[]") : ok(),
	);
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("psscriptanalyzer availability (#1490)", () => {
	it("probes through safeSpawnAsync with a budget and a resource label", async () => {
		const runner = await loadRunner();
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");

		const probe = callsMatching("exit 0")[0];
		expect(probe?.[0]).toBe("pwsh");
		expect(probe?.[2]).toMatchObject({
			timeout: 30000,
			resourceLabel: "psscriptanalyzer",
		});
	});

	it("re-probes the interpreter after a timeout once the cooldown expires", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);
		expect((await runner.run(ctx())).status).toBe("skipped");
		// Both candidates were tried; neither answered.
		expect(callsMatching("exit 0")).toHaveLength(2);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
		});

		// Inside the cooldown the verdict is reused rather than re-probed.
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("exit 0")).toHaveLength(2);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("latches a genuinely absent interpreter", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async () => notFoundResult);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "missing",
			cause: "not-found",
			latched: true,
		});

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("exit 0")).toHaveLength(2);
	});

	it("keeps the verdict transient when one candidate stalls and the other is absent", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === "pwsh" ? timeoutResult : notFoundResult,
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			outcome: "transient",
			latched: false,
		});
	});

	it("re-probes the module after a timeout once the cooldown expires", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module")) ? timeoutResult : ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "transient", latched: false });

		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("does not read a failed module spawn as a missing module", async () => {
		const runner = await loadRunner();
		// `spawn UNKNOWN` is the #533 Windows class: the child never started, so
		// nothing was learned about the module. Latching it as "not installed"
		// disabled PowerShell analysis for the session on hosts that had it.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module")) ? spawnUnknownResult : ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "transient", latched: false });

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("reports a present-but-rejecting interpreter as rejected, not missing", async () => {
		const runner = await loadRunner();
		// pwsh is absent, powershell answers and refuses. Collapsing both to
		// not-found tells the user to install PowerShell they already have, and
		// fabricates the cause in the telemetry.
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === "pwsh" ? notFoundResult : rejectedResult,
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "non-installable",
			cause: "probe-rejected",
			latched: true,
		});
	});

	it("latches a genuinely missing module", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module")) ? moduleMissing : ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "missing", cause: "not-found", latched: true });

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);
	});
});
