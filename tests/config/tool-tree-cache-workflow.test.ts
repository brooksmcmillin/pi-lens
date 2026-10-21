// #4358: the nightly smoke workflows restore the managed tool tree through the
// `tool-tree-cache` composite action, keyed on the installer registry's hash so
// a pin change installs cold. Each case names the recurrence it keeps out. The
// scan reads parsed YAML, never the text, so a comment cannot satisfy it.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowDocument } from "../../scripts/dispatch-safety.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const ACTION_DIR = ".github/actions/tool-tree-cache";
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

type Step = {
	id?: string;
	name?: string;
	if?: string;
	uses?: string;
	run?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
};
type Doc = {
	jobs?: Record<string, { steps?: Step[] }>;
	runs?: { steps?: Step[] };
};
const parse = (file: string) => workflowDocument(read(file)) as Doc;

const CONSUMERS: Array<{ file: string; job: string; prefix: string }> = [
	{
		file: ".github/workflows/tool-smoke.yml",
		job: "tool-smoke",
		prefix: "tool-smoke-tools",
	},
	{
		file: ".github/workflows/parser-smoke.yml",
		job: "parser-smoke",
		prefix: "parser-smoke-tools",
	},
];

const isAction = (step: Step) => step.uses === `./${ACTION_DIR}`;
const isInstall = (step: Step) =>
	typeof step.run === "string" && /--install\b/.test(step.run);

describe("tool-tree cache composite action (#4358)", () => {
	const action = parse(`${ACTION_DIR}/action.yml`);
	const steps = action.runs?.steps ?? [];

	// Recurrence: `hashFiles` of a path that does not exist returns the empty
	// string, so renaming or splitting the installer registry would leave the key
	// constant and a pin change would restore the stale tree forever, with no
	// error. The hashed file must exist and must still hold the TOOLS registry.
	it("keys on a file that exists and holds the installer registry", () => {
		const hashed = steps
			.flatMap((step) => Object.values(step.env ?? {}))
			.flatMap((value) =>
				[...String(value).matchAll(/hashFiles\('([^']+)'\)/g)].map(
					(match) => match[1],
				),
			);
		expect(hashed).toEqual(["clients/installer/index.ts"]);
		for (const file of hashed) {
			expect(existsSync(resolve(ROOT, file)), file).toBe(true);
			expect(read(file)).toMatch(/^export const TOOLS: ToolDefinition\[\]/m);
		}
	});

	// Recurrence: an empty hash passed the step above in CI once the file moved;
	// the step itself must refuse to build a key from nothing.
	it("fails the key step when the pins hash to nothing", () => {
		const key = steps.find((step) => step.id === "key");
		expect(key?.run).toMatch(/test -n "\$PINS"/);
	});

	// Recurrence: a restore keyed differently from its save never hits.
	it("restores and saves under the one key the key step resolved", () => {
		const restore = steps.find((step) => step.id === "restore");
		const save = steps.find((step) =>
			step.uses?.includes("actions/cache/save"),
		);
		expect(restore?.with?.key).toBe("${{ steps.key.outputs.key }}");
		expect(save?.with?.key).toBe("${{ steps.key.outputs.key }}");
		expect(restore?.with?.path).toBe(save?.with?.path);
	});

	// Recurrence: a stale install lock saved in the tree would make the next
	// job wait on a lock whose holder never existed.
	it("leaves the install locks out of the cached tree", () => {
		const restore = steps.find((step) => step.id === "restore");
		expect(restore?.with?.path).toContain(
			"!${{ env.PI_LENS_HOME }}/tools/.install.lock*",
		);
	});

	describe.each(CONSUMERS)("$file", ({ file, job, prefix }) => {
		const jobSteps = parse(file).jobs?.[job]?.steps ?? [];
		const restoreAt = jobSteps.findIndex(
			(step) => isAction(step) && step.with?.mode === "restore",
		);
		const saveAt = jobSteps.findIndex(
			(step) => isAction(step) && step.with?.mode === "save",
		);
		const firstInstall = jobSteps.findIndex(isInstall);
		const lastInstall = jobSteps.reduce(
			(last, step, index) => (isInstall(step) ? index : last),
			-1,
		);

		// Recurrence: a restore after the first `--install` step restores over a
		// tree the job already populated, and a save before the last one leaves
		// the later layers' tools out of the cache.
		it("restores before the first --install step and saves after the last", () => {
			expect(firstInstall).toBeGreaterThan(-1);
			expect(restoreAt).toBeGreaterThan(-1);
			expect(restoreAt).toBeLessThan(firstInstall);
			expect(saveAt).toBeGreaterThan(lastInstall);
		});

		// Recurrence: review r1 F2. The key is first-wins for the week. Run
		// 38586046285 went red at the LSP handshake layer, nine later layers were
		// skipped, and the save still ran: that partial tree was then restored all
		// week and re-downloaded the missing tools nightly. The save must wait for
		// the LAST install-bearing step to have run (red or green), and still skip a
		// cancel and an exact hit.
		it("saves only once the last install step ran, not after a cancel or an exact hit", () => {
			const save = jobSteps[saveAt];
			const restore = jobSteps[restoreAt];
			const last = jobSteps[lastInstall];
			expect(restore.id).toBeTruthy();
			expect(last.id).toBeTruthy();
			expect(save.if).toBe(
				`\${{ !cancelled() && steps.${restore.id}.outputs.cache-hit != 'true' && steps.${last.id}.outcome != 'skipped' }}`,
			);
		});

		// Recurrence: parser-smoke installs the tier-1 subset; a key shared with
		// tool-smoke's full tree would let whichever saved first shadow the other.
		it("uses its own key family for both modes", () => {
			expect(jobSteps[restoreAt].with?.prefix).toBe(prefix);
			expect(jobSteps[saveAt].with?.prefix).toBe(prefix);
		});

		it("exports the PI_LENS_HOME the action caches under", () => {
			const doc = workflowDocument(read(file)) as {
				jobs: Record<string, { env?: Record<string, string> }>;
			};
			expect(doc.jobs[job].env?.PI_LENS_HOME).toBe("/tmp/pi-lens-home");
		});
	});

	it("gives each consumer a different key family", () => {
		expect(new Set(CONSUMERS.map((consumer) => consumer.prefix)).size).toBe(
			CONSUMERS.length,
		);
	});
});
