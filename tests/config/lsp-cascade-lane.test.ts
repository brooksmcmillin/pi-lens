// #1712: the nightly live cascade lane is a step of tool-smoke.yml, not a new
// workflow. These pins read the REAL workflow (yaml.load, never a restated copy)
// and the fixture table, because the lane's value is that it actually runs
// every night and that a server that never concludes reds it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	CASCADE_CONCLUSIVE_DEADLINE_MS,
	CASCADE_FIXTURES,
	CASCADE_RENAME_EXTRA_DEADLINES,
	CASCADE_WARM_DEADLINE_MS,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
type Step = {
	name?: string;
	id?: string;
	uses?: string;
	if?: unknown;
	run?: string;
	"continue-on-error"?: unknown;
	env?: Record<string, string>;
	"timeout-minutes"?: number;
	with?: Record<string, unknown>;
};
type Workflow = {
	jobs: Record<string, { "timeout-minutes"?: number; steps: Step[] }>;
};
const workflow = yaml.load(
	readFileSync(resolve(REPO_ROOT, ".github/workflows/tool-smoke.yml"), "utf8"),
) as Workflow;
const steps = workflow.jobs["tool-smoke"].steps;
const at = (id: string) => steps.findIndex((s) => s.id === id);
const cascade = steps[at("lsp_cascade")];

describe("tool-smoke.yml carries the live cascade lane (#1712)", () => {
	it("runs the cascade layer, installing servers, as a gating step", () => {
		// Recurrence: #4495 shipped the live cascade test behind
		// PI_LENS_INTEGRATION=1, which CI never sets, so nothing ran it.
		expect(cascade.run).toMatch(/smoke-tools\.mjs --lsp-cascade --install\b/);
		// A continue-on-error would let a server that never concludes pass the job.
		expect(cascade["continue-on-error"]).not.toBe(true);
	});

	it("runs after the best-effort layers, so a red cascade cannot hide them", () => {
		// Recurrence: #5021 review (CodeRabbit PRRT_kwDORt8rec6x8Fpo). The cascade
		// is gating and live; placed right after the gate, a red night skipped the
		// capability matrix, clean-signal, save-verdict, inventory, idle-eviction,
		// docs diff, census, Format, lens_full, Resolution and the tool-tree save.
		// It sits after the last of them and before the floor that reports every
		// layer.
		const bestEffort = [
			"lsp_matrix",
			"clean_signal",
			"save_verdict",
			"server_capabilities",
			"idle_measurement",
			"docs_diff",
			"lsp_census",
			"format_layer",
			"lens_full",
			"resolution_layer",
		];
		for (const id of bestEffort) {
			expect(at(id), `${id} is a step of the job`).toBeGreaterThan(-1);
			expect(at(id), `${id} before lsp_cascade`).toBeLessThan(
				at("lsp_cascade"),
			);
		}
		expect(at("java25")).toBeGreaterThan(at("resolution_layer"));
		expect(at("lsp_cascade")).toBeLessThan(at("evaluated_floor"));
		// #5021 verify r4 F11: the list above only covers the layers that existed
		// when this cell was written. A step added after the cascade without an
		// `if:` would be skipped by a red cascade, the x8Fpo shape again.
		for (const step of steps.slice(at("lsp_cascade") + 1)) {
			expect(
				step.if,
				`${step.name ?? step.uses} after lsp_cascade carries an if:`,
			).toBeTruthy();
		}
	});

	it("reads the handshake census it follows (same PI_LENS_HOME, later step)", () => {
		// The lane tells a server that never handshook (warning) from one that
		// handshook and then never concluded (red) through the census file the
		// handshake step leaves in the job's shared PI_LENS_HOME.
		expect(at("lsp_cascade")).toBeGreaterThan(at("lsp_handshake"));
	});

	it("hands each self-provisioned server's path to the cascade step alone", () => {
		// Recurrence: #3400, jdtls has no managed installer, so a lane that waited
		// for the handshake census skipped it every night. The path travels in the
		// cascade step's own env: through GITHUB_ENV/GITHUB_PATH it would reach the
		// capability, clean-signal and idle-eviction measurements that run after it
		// and change their server population.
		const provisioned = CASCADE_FIXTURES.filter((f) => f.provisionedBy);
		expect(provisioned.map((f) => f.lang)).toEqual(["java"]);
		for (const fixture of provisioned) {
			const install = steps.find((s) => s.id === "jdtls");
			expect(at("jdtls")).toBeLessThan(at("lsp_cascade"));
			expect(cascade.env?.[fixture.provisionedBy as string]).toBe(
				"${{ steps.jdtls.outputs.path }}",
			);
			expect(install?.run).not.toMatch(/GITHUB_ENV|GITHUB_PATH/);
			// Recurrence: run 41025058980, jdtls 1.63.0 exited 13 on the job's
			// JDK 21 (its bundles require JavaSE 25), so the java row never
			// answered. The JDK it needs is a second install that leaves the job
			// default alone, and its path reaches both jdtls steps and no other.
			// Recurrence: #5021 review (CodeRabbit), a failed eclipse.org download
			// failed the step and skipped every later gating layer. The install is
			// best-effort, and its output path is written only after the digest
			// check and the unpack, so a failure reads as "not provisioned".
			expect(install?.["continue-on-error"]).toBe(true);
			const run = install?.run ?? "";
			expect(run.indexOf("sha256sum --check")).toBeGreaterThan(-1);
			// Recurrence: #5021 verify F9. The step is best-effort, so a digest
			// mismatch must say what it saw (`--status` printed nothing, and a
			// corrupt archive read as "no network tonight").
			expect(run).not.toMatch(/sha256sum --check --status/);
			expect(run).toMatch(/::error::jdtls archive failed its pinned digest/);
			expect(run.indexOf('echo "path=')).toBeGreaterThan(
				run.indexOf("sha256sum --check"),
			);
			expect(run.indexOf('echo "path=')).toBeGreaterThan(run.indexOf("tar -x"));
			const jdk = steps.find((s) => s.id === "java25");
			expect(at("java25")).toBeLessThan(at("jdtls"));
			expect(jdk?.with?.["java-version"]).toBe("25");
			expect(jdk?.with?.["set-default"]).toBe(false);
			expect(install?.env?.JAVA_HOME).toBe("${{ steps.java25.outputs.path }}");
			expect(cascade.env?.JAVA_HOME).toBe("${{ steps.java25.outputs.path }}");
			// The archive is verified against a pinned digest before it is unpacked.
			expect(install?.run).toMatch(/sha256sum --check/);
			expect(install?.run).toMatch(/digest="[0-9a-f]{64}"/);
		}
	});

	it("keeps the exit status of node through the tee", () => {
		expect(cascade.run).toMatch(/^\s*set -o pipefail\s*$/m);
	});

	it("floors the pass count so an all-unavailable night cannot read green, below the population", () => {
		// Recurrence: #4514, a layer that evaluated nothing read green for days.
		// And #5021 review F2: a floor equal to the fixture population (4 of 4)
		// reds one unavailable server with "installs nothing", though the step
		// comment promises a warning for a server that never handshook.
		const floor = Number(/--min-pass=(\d+)\b/.exec(cascade.run ?? "")?.[1]);
		expect(floor).toBeGreaterThanOrEqual(1);
		expect(floor).toBeLessThan(CASCADE_FIXTURES.length);
	});

	it("uploads the file the lane writes as its time-to-conclusive telemetry", () => {
		const written = /--times-out="\$RUNNER_TEMP\/([^"]+)"/.exec(
			cascade.run ?? "",
		)?.[1];
		expect(written).toBeTruthy();
		const upload = steps[at("lsp_cascade") + 1];
		expect(upload.uses).toContain("actions/upload-artifact@");
		expect(upload.if).toBe("always()");
		expect(upload.with?.path).toBe(`\${{ runner.temp }}/${written}`);
	});

	it("bounds the lane below the job cap with the worst case of every fixture inside it", () => {
		// Recurrence: #3123, a hang costing the GitHub default. The worst case is
		// each fixture's warm-up plus its conclusive deadline, and for a fixture
		// with a rename phase two more conclusive deadlines (the restored
		// exporter's baseline, then the importers after the move); a 5-minute
		// margin covers installs the tool-tree cache did not restore.
		const stepCap = (cascade["timeout-minutes"] ?? Infinity) * 60_000;
		const jobCap =
			(workflow.jobs["tool-smoke"]["timeout-minutes"] ?? 0) * 60_000;
		const worst = CASCADE_FIXTURES.reduce(
			(sum, f) =>
				sum +
				(f.warmDeadlineMs ?? CASCADE_WARM_DEADLINE_MS) +
				(f.conclusiveDeadlineMs ?? CASCADE_CONCLUSIVE_DEADLINE_MS) *
					(1 + (f.rename ? CASCADE_RENAME_EXTRA_DEADLINES : 0)),
			0,
		);
		expect(stepCap).toBeLessThan(jobCap);
		expect(worst + 5 * 60_000).toBeLessThanOrEqual(stepCap);
	});
});
