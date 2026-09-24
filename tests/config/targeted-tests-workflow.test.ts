import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

function readWorkflow() {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<
			string,
			{
				name?: string;
				if?: string;
				"continue-on-error"?: boolean;
				steps?: Array<{
					uses?: string;
					run?: string;
					with?: Record<string, unknown>;
				}>;
			}
		>;
	};
}

describe("targeted advisory workflow contract (#3215)", () => {
	it("runs the selector on every PR with a full checkout and no gating power", () => {
		const job = readWorkflow().jobs["targeted-tests-advisory"];
		expect(job?.name).toBe("Targeted tests (advisory)");
		expect(job?.if).toBe("github.event_name == 'pull_request'");
		expect(job?.["continue-on-error"]).toBe(true);
		const checkout = job?.steps?.find((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(checkout?.uses).toBe(
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		);
		expect(checkout?.with?.["fetch-depth"]).toBe(0);
		const setupNode = job?.steps?.find((step) =>
			step.uses?.startsWith("actions/setup-node@"),
		);
		expect(setupNode?.uses).toBe(
			"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
		);
	});

	it("keeps install/build parity and publishes the selector outcome", () => {
		const selector = readFileSync(
			resolve(ROOT, "scripts/pre-push-targeted-tests.mjs"),
			"utf8",
		);
		const job = readWorkflow().jobs["targeted-tests-advisory"];
		const runs = job?.steps?.map((step) => step.run).filter(Boolean) ?? [];
		// Lockfile-locked and script-free (SonarCloud githubactions:S8543 /
		// S6505 on the copied `npm install`); the grammar download is the one
		// `prepare` piece the targeted files need, so it is an explicit step.
		expect(runs).toContain("npm ci --no-audit --no-fund --ignore-scripts");
		expect(runs).toContain(
			"node scripts/download-grammars.js --core --dest grammars",
		);
		expect(
			runs.indexOf("node scripts/download-grammars.js --core --dest grammars"),
		).toBeLessThan(runs.indexOf("npm run build"));
		expect(runs).toContain("npm run build");
		expect(runs).toContain(
			"node scripts/pre-push-targeted-tests.mjs --skip-build",
		);
		expect(selector).toContain("GITHUB_STEP_SUMMARY");
		expect(selector).toContain("cap exceeded");
	});
});
