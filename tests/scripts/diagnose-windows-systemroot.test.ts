import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatform } from "../support/platform-stub.js";
import {
	checkLiteralArgument,
	main,
	observe,
} from "../../scripts/diagnose-windows-systemroot.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn(),
}));
const originalPlatform = process.platform;

const clean = {
	pid: 0,
	status: 0,
	signal: null,
	stdout: '["safe & literal"]',
	stderr: "",
	output: [],
};

afterEach(() => {
	vi.restoreAllMocks();
	setPlatform(originalPlatform);
	vi.unstubAllEnvs();
	vi.mocked(spawnSync).mockReset();
});

describe("Windows SystemRoot diagnostic (process boundary double, not native proof)", () => {
	it("refuses a non-Windows host rather than claiming a skipped success", async () => {
		setPlatform("darwin");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await main()).toBe(2);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("no diagnostic executed"),
		);
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("refuses a missing control SystemRoot without spawning", async () => {
		setPlatform("win32");
		vi.stubEnv("SystemRoot", undefined);
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await main()).toBe(2);
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("bounds capture and retains failure details independently of literal checks", () => {
		vi.mocked(spawnSync).mockReturnValue({
			...clean,
			status: 134,
			stdout: "y".repeat(5000),
			stderr: "x".repeat(5000),
			error: Object.assign(new Error("failed"), { code: "ETIMEDOUT" }),
		});
		const result = observe("failure", "fixture.exe", ["literal"], {}, false);
		expect(result.status).toBe(134);
		expect(result.error).toEqual({ code: "ETIMEDOUT", message: "failed" });
		expect(result.stdout).toHaveLength(4096);
		expect(result.stdoutOmitted).toBe(904);
		expect(result.stderr).toHaveLength(4096);
		expect(result.stderrOmitted).toBe(904);
		expect(checkLiteralArgument(result).passed).toBe(false);
		expect(spawnSync).toHaveBeenCalledWith(
			"fixture.exe",
			["literal"],
			expect.objectContaining({
				shell: false,
				timeout: 5000,
				maxBuffer: 16384,
			}),
		);
	});

	it("rejects changed argv output even when the child exits successfully", () => {
		vi.mocked(spawnSync).mockReturnValue(clean);
		const result = observe("literal", "fixture.exe", [], {}, false);
		expect(checkLiteralArgument(result).passed).toBe(true);
		expect(
			checkLiteralArgument({ ...result, stdout: '["safe","&","literal"]' })
				.passed,
		).toBe(false);
	});

	it.each([
		{ status: 134 },
		{ signal: "SIGTERM" as const },
		{ error: { code: "EIO", message: "failed" } },
		{ stdoutOmitted: 1 },
		{ stderrOmitted: 1 },
	])(
		"does not let literal stdout hide an incomplete observation: %j",
		(override) => {
			vi.mocked(spawnSync).mockReturnValue(clean);
			const result = observe("literal", "fixture.exe", [], {}, false);
			expect(checkLiteralArgument({ ...result, ...override }).passed).toBe(
				false,
			);
		},
	);

	it("compares the same payload in both environments and emits all four arms before failing", async () => {
		await import("../../clients/safe-spawn.js");
		setPlatform("win32");
		vi.stubEnv("SystemRoot", "C:\\Windows");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.mocked(spawnSync).mockImplementation((_command, _args, options) => ({
			...clean,
			status: options?.env?.SystemRoot?.endsWith("missing & root") ? 134 : 0,
		}));
		expect(await main()).toBe(1);
		const calls = vi.mocked(spawnSync).mock.calls;
		expect(calls).toHaveLength(4);
		expect(calls[0][0]).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(calls[1][0]).toBe(calls[0][0]);
		expect(calls[0][1]).toEqual(calls[1][1]);
		expect(calls[0][1]?.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(calls[0][1]?.[3]).toContain('"safe & literal"');
		expect(calls[2][0]).toBe(process.execPath);
		expect(calls[3][1]).toEqual(calls[2][1]);
		expect(calls[2][1]?.[1]).toBe("safe & literal");
		expect(calls.map((call) => call[2]?.env?.SystemRoot)).toEqual([
			expect.stringContaining("missing & root"),
			"C:\\Windows",
			expect.stringContaining("missing & root"),
			"C:\\Windows",
		]);
		expect(process.env.SystemRoot).toBe("C:\\Windows");
		const report = JSON.parse(String(log.mock.calls[0][0]));
		expect(
			report.observations.map((row: { status: number }) => row.status),
		).toEqual([134, 0, 134, 0]);
		expect(report.checks.map((row: { passed: boolean }) => row.passed)).toEqual(
			[false, true, false, true],
		);
		expect(existsSync(String(calls[2][1]?.[0]))).toBe(false);
	});
});
