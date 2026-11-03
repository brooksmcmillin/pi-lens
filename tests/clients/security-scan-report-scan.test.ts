/**
 * `SecurityScanClient.runReportScan` is the one report-file scan body behind
 * GitleaksClient and TrivyClient. Before it, each client carried its own copy
 * of the temp-dir / spawn-error / no-report / throw / cleanup sequence, so a
 * fix to one outcome could land in one scanner only.
 *
 * Recurrence prevented: a change to the shared outcomes (the unsuccessful
 * result on a spawn error, a throw or a non-zero exit with no report, the
 * successful empty result when a zero-exit CLI writes no report, the report
 * directory's removal on every path) that one
 * former caller no longer honours. Each case runs the real client's public
 * `scan()` through the real seam; only the CLI process (`safeSpawnAsync`) is
 * faked, as the host boundary, and it writes the report to the path the client
 * put in its own argv.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSpawn = {
	error?: Error;
	status: number | null;
	stdout: string;
	stderr: string;
};
const safeSpawnAsync = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]): Promise<FakeSpawn> => {
		throw new Error("safeSpawnAsync double not configured");
	}),
);
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { GitleaksClient } from "../../clients/gitleaks-client.js";
import type { SpawnResult } from "../../clients/safe-spawn.js";
import { SecurityScanClient } from "../../clients/security-scan-client.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { TrivyClient } from "../../clients/trivy-client.js";
import { setupTestEnvironment } from "./test-utils.js";

type ScanResult = {
	success: boolean;
	analyzed?: boolean;
	summary?: string;
	scannedAt: string;
	findings: unknown[];
};

type Scanner = {
	name: "gitleaks" | "trivy";
	/** argv flag that carries the report path. */
	reportFlag: string;
	/** A report the real parser turns into exactly one finding. */
	report: string;
	/** Builds a client that passes its gates and has a binary available. */
	scan: (root: string) => Promise<ScanResult>;
};

const GITLEAKS_REPORT = JSON.stringify([
	{
		Description: "AWS Access Key",
		StartLine: 3,
		EndLine: 3,
		File: "src/config.ts",
		RuleID: "aws-access-token",
		Fingerprint: "src/config.ts:aws-access-token:3",
		Tags: [],
	},
]);
const TRIVY_REPORT = JSON.stringify({
	Results: [
		{
			Target: "package-lock.json",
			Vulnerabilities: [
				{
					VulnerabilityID: "CVE-2026-11111",
					PkgName: "left-pad",
					InstalledVersion: "1.0.0",
					Severity: "CRITICAL",
				},
			],
		},
	],
});

const scanners: Scanner[] = [
	{
		name: "gitleaks",
		reportFlag: "--report-path",
		report: GITLEAKS_REPORT,
		scan: async (root) => {
			const client = new GitleaksClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root, { requireSignal: false });
		},
	},
	{
		name: "trivy",
		reportFlag: "--output",
		report: TRIVY_REPORT,
		scan: async (root) => {
			fs.writeFileSync(
				path.join(root, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true } }),
			);
			fs.writeFileSync(path.join(root, "package.json"), "{}");
			resetProjectLensConfigCache();
			const client = new TrivyClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			return client.scan(root);
		},
	},
];

/** The ledger row the seam counts for a failed scan, if any. */
function failedScanRecord() {
	return getDegradationSummary().find(
		({ kind }) => kind === "security-scan-report-failed",
	);
}

function reportPathOf(argv: unknown, flag: string): string {
	const args = argv as string[];
	return args[args.indexOf(flag) + 1]!;
}

describe.each(scanners)("runReportScan through $name", (scanner) => {
	/** Report directories the client handed its CLI, in call order. */
	let reportDirs: string[];

	/**
	 * The CLI double: records the report directory out of the client's own argv,
	 * then settles as `outcome` says. Other spawns (gitleaks's post-scan git
	 * classification goes through the same seam) get an empty success.
	 */
	function fakeCli(outcome: () => Promise<FakeSpawn>): void {
		safeSpawnAsync.mockImplementation(async (_bin, argv) => {
			if (!(argv as string[]).includes(scanner.reportFlag)) {
				return { status: 0, stdout: "", stderr: "" };
			}
			reportDirs.push(path.dirname(reportPathOf(argv, scanner.reportFlag)));
			return outcome();
		});
	}

	let env: ReturnType<typeof setupTestEnvironment>;
	let root: string;
	let reportParent: string;

	beforeEach(() => {
		env = setupTestEnvironment(`pi-lens-report-scan-${scanner.name}-`);
		root = path.join(env.tmpDir, "project");
		reportParent = path.join(env.tmpDir, "report-parent");
		fs.mkdirSync(root, { recursive: true });
		fs.mkdirSync(reportParent, { recursive: true });
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", reportParent);
		safeSpawnAsync.mockReset();
		reportDirs = [];
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		resetProjectLensConfigCache();
		env.cleanup();
	});

	/** The one report directory the scan created is gone. */
	const expectReportDirRemoved = () => {
		expect(reportDirs).toHaveLength(1);
		expect(fs.existsSync(reportDirs[0]!)).toBe(false);
	};

	it("parses the report the CLI wrote at the path it was handed, then removes the directory", async () => {
		safeSpawnAsync.mockImplementation(async (_bin, argv) => {
			if (!(argv as string[]).includes(scanner.reportFlag)) {
				return { status: 0, stdout: "", stderr: "" };
			}
			const reportPath = reportPathOf(argv, scanner.reportFlag);
			const dir = path.dirname(reportPath);
			reportDirs.push(dir);
			expect(path.basename(reportPath)).toBe(`${scanner.name}-report.json`);
			expect(path.basename(dir)).toMatch(
				new RegExp(`^pi-lens-${scanner.name}-`),
			);
			expect(path.dirname(dir)).toBe(reportParent);
			fs.writeFileSync(reportPath, scanner.report);
			return { status: 0, stdout: "", stderr: "" };
		});

		const result = await scanner.scan(root);

		expect(result.success).toBe(true);
		expect(result.analyzed).toBe(true);
		expect(result.findings).toHaveLength(1);
		expect(failedScanRecord()).toBeUndefined();
		expectReportDirRemoved();
	});

	it("reports an unsuccessful empty result for a spawn error and removes the directory", async () => {
		const message = `spawn exploded: ${"y".repeat(300)}`;
		fakeCli(async () => ({
			error: new Error(message),
			status: null,
			stdout: "",
			stderr: "",
		}));

		const result = await scanner.scan(root);

		expect(result.success).toBe(false);
		expect(result.analyzed).toBeUndefined();
		expect(result.summary).toBe(message.slice(0, 200));
		expect(result.findings).toEqual([]);
		expect(failedScanRecord()).toMatchObject({
			count: 1,
			latestReasons: [{ subject: scanner.name }],
		});
		expectReportDirRemoved();
	});

	it("reports a successful empty result with stderr's first line when the CLI wrote no report", async () => {
		fakeCli(async () => ({
			status: 0,
			stdout: "",
			stderr: "database download failed\nsecond line\n",
		}));

		const result = await scanner.scan(root);

		expect(result.success).toBe(true);
		expect(result.analyzed).toBeUndefined();
		expect(result.summary).toBe("database download failed");
		expect(result.findings).toEqual([]);
		// A CLI that wrote no report is a successful empty result, not a failure.
		expect(failedScanRecord()).toBeUndefined();
		expectReportDirRemoved();
	});

	// Recurrence prevented: a scanner that refused (exit 3, nothing written) read
	// as a successful empty scan, so fresh-fetch cached it as clean and no row
	// recorded it (shape 10, a scan that did not run is not clean). Both CLIs
	// are started so that a non-zero exit is a failure (gitleaks gets
	// `--exit-code 0`, trivy's default is 0).
	it("reports an unsuccessful empty result when the CLI exits non-zero without a report", async () => {
		fakeCli(async () => ({
			status: 3,
			stdout: "",
			stderr: "fatal: bad config\nsecond line\n",
		}));

		const result = await scanner.scan(root);

		expect(result.success).toBe(false);
		expect(result.analyzed).toBeUndefined();
		const reason = `${scanner.name} exited 3 with no report file: fatal: bad config`;
		expect(result.summary).toBe(reason);
		expect(result.findings).toEqual([]);
		expect(failedScanRecord()).toMatchObject({
			count: 1,
			latestReasons: [
				{ subject: scanner.name, reason: `${reason} (count: 1)` },
			],
		});
		expectReportDirRemoved();
	});

	it("names the exit status when a non-zero exit left no report and no stderr", async () => {
		fakeCli(async () => ({ status: 3, stdout: "", stderr: "" }));

		const result = await scanner.scan(root);

		expect(result.success).toBe(false);
		expect(result.summary).toBe(
			`${scanner.name} exited 3 with no report file: no stderr`,
		);
		expect(failedScanRecord()).toMatchObject({ count: 1 });
		expectReportDirRemoved();
	});

	// The status is read only when no report exists: a written report is the
	// scan's evidence, whatever the exit code (the pre-existing outcome).
	it("still parses a report the CLI wrote when it exits non-zero", async () => {
		safeSpawnAsync.mockImplementation(async (_bin, argv) => {
			if (!(argv as string[]).includes(scanner.reportFlag)) {
				return { status: 0, stdout: "", stderr: "" };
			}
			const reportPath = reportPathOf(argv, scanner.reportFlag);
			reportDirs.push(path.dirname(reportPath));
			fs.writeFileSync(reportPath, scanner.report);
			return { status: 5, stdout: "", stderr: "" };
		});

		const result = await scanner.scan(root);

		expect(result.success).toBe(true);
		expect(result.findings).toHaveLength(1);
		expect(failedScanRecord()).toBeUndefined();
		expectReportDirRemoved();
	});

	it("falls back to 'no report produced' when stderr is empty", async () => {
		fakeCli(async () => ({ status: 0, stdout: "", stderr: "" }));

		const result = await scanner.scan(root);

		expect(result.success).toBe(true);
		expect(result.summary).toBe("no report produced");
		expectReportDirRemoved();
	});

	it("reports an unsuccessful empty result when the spawn throws and removes the directory", async () => {
		fakeCli(async () => {
			throw new Error("x".repeat(300));
		});

		const result = await scanner.scan(root);

		expect(result.success).toBe(false);
		expect(result.summary).toBe("x".repeat(200));
		expect(failedScanRecord()).toMatchObject({
			count: 1,
			latestReasons: [{ subject: scanner.name }],
		});
		expectReportDirRemoved();
	});
});

// The seam's own contract for a `parse` that is asynchronous (gitleaks's is:
// it classifies findings against git). A rejection must land in the same
// unsuccessful result as a spawn throw, and the directory must outlive the
// parse only until it settles. Recurrence prevented: `return spec.parse(...)`
// without `await` lets the rejection escape the guard.
describe("runReportScan with an asynchronous parse", () => {
	type Probe = { ok: boolean; summary?: string; scannedAt: string };
	const reportDirs: string[] = [];
	class ProbeClient extends SecurityScanClient<Probe> {
		constructor(private readonly parse: (raw: string) => Promise<Probe>) {
			super("probe-report", false);
		}
		protected async doEnsureAvailable(): Promise<boolean> {
			return true;
		}
		run(): Promise<Probe> {
			return this.runReportScan({
				spawn: async ({ outDir, reportPath }) => {
					reportDirs.push(outDir);
					fs.writeFileSync(reportPath, "payload");
					return { status: 0, stdout: "", stderr: "" } as SpawnResult;
				},
				parse: (raw) => this.parse(raw),
				fail: (failure) => ({ ok: false, ...failure }),
			});
		}
	}

	let env: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		reportDirs.length = 0;
		resetDegradationLedger();
		env = setupTestEnvironment("pi-lens-report-scan-probe-");
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", env.tmpDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		env.cleanup();
	});

	it("returns what the parse resolves with, handing it the report bytes", async () => {
		const client = new ProbeClient(async (raw) => ({
			ok: raw === "payload",
			scannedAt: "t",
		}));
		await expect(client.run()).resolves.toMatchObject({ ok: true });
		expect(reportDirs).toHaveLength(1);
		expect(fs.existsSync(reportDirs[0]!)).toBe(false);
	});

	it("turns a rejecting parse into an unsuccessful empty result and removes the directory", async () => {
		const client = new ProbeClient(async () => {
			throw new Error("parse blew up");
		});
		await expect(client.run()).resolves.toMatchObject({
			ok: false,
			summary: "parse blew up",
		});
		expect(failedScanRecord()).toMatchObject({
			count: 1,
			latestReasons: [
				{ subject: "probe-report", reason: "parse blew up (count: 1)" },
			],
		});
		expect(reportDirs).toHaveLength(1);
		expect(fs.existsSync(reportDirs[0]!)).toBe(false);
	});
});
