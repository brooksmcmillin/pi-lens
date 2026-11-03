import { describe, expect, it } from "vitest";
import { decideAudit } from "../../scripts/audit-prod-deps.mjs";

const clean = JSON.stringify({
	metadata: {
		vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
	},
	vulnerabilities: {},
});

describe("decideAudit (CI audit step verdicts)", () => {
	it("is clean only when npm exited 0 with zero high/critical", () => {
		expect(decideAudit({ code: 0, stdout: clean, timedOut: false })).toEqual({
			kind: "clean",
		});
	});

	it("fails on a high or critical finding, naming the package", () => {
		const out = JSON.stringify({
			metadata: { vulnerabilities: { high: 1, critical: 0 } },
			vulnerabilities: {
				lodash: { severity: "high" },
				ok: { severity: "low" },
			},
		});
		const v = decideAudit({ code: 1, stdout: out, timedOut: false });
		expect(v.kind).toBe("vulnerable");
		expect(v.kind === "vulnerable" && v.summary).toContain("lodash (high)");
	});

	// Recurrence prevented: the gate's `critical` half (a critical-only finding
	// read as clean) was pinned by no case, because the case above only ever
	// carries a `high` count. Dropping `critical` from the verdict passed.
	it("fails on a critical-only finding, naming the package", () => {
		const out = JSON.stringify({
			metadata: { vulnerabilities: { high: 0, critical: 1 } },
			vulnerabilities: {
				openssl: { severity: "critical" },
				ok: { severity: "low" },
			},
		});
		const v = decideAudit({ code: 1, stdout: out, timedOut: false });
		expect(v.kind).toBe("vulnerable");
		expect(v.kind === "vulnerable" && v.summary).toBe(
			"0 high, 1 critical: openssl (critical)",
		);
	});

	it("treats the registry's error object as transport, not as clean", () => {
		const out = JSON.stringify({
			error: { code: "E400", summary: "Invalid package tree, run npm install" },
		});
		const v = decideAudit({ code: 1, stdout: out, timedOut: false });
		expect(v.kind).toBe("transport");
		expect(v.kind === "transport" && v.reason).toContain("E400");
	});

	it("treats a timeout, non-JSON output, and missing metadata as transport", () => {
		expect(decideAudit({ code: null, stdout: "", timedOut: true }).kind).toBe(
			"transport",
		);
		expect(
			decideAudit({ code: 0, stdout: "npm warn ...", timedOut: false }).kind,
		).toBe("transport");
		expect(decideAudit({ code: 0, stdout: "{}", timedOut: false }).kind).toBe(
			"transport",
		);
	});

	it("never reads a non-zero exit with no findings as clean", () => {
		expect(decideAudit({ code: 1, stdout: clean, timedOut: false }).kind).toBe(
			"transport",
		);
	});
});
