import { expect } from "vitest";

type JobsWithSteps = Record<string, { steps?: Array<{ uses?: string }> }>;

// Recurrence #4418: every Dependabot bump of an action moves each workflow's
// pin together, and tests that hard-coded the old sha (setup-node 6.5.0 in the
// Windows lane and the targeted-advisory lane) redded Unit shard 3 on every
// such bump. A job that must match its sibling jobs derives the expected pin
// from them. Siblings that disagree among themselves (a bump that moved only
// some) leave no single pin and red here, as does an action no sibling uses.
export function siblingPin(
	jobs: JobsWithSteps,
	action: string,
	exceptJob: string,
): string {
	const pins = new Set(
		Object.entries(jobs)
			.filter(([id]) => id !== exceptJob)
			.flatMap(([, job]) => job.steps ?? [])
			.map((step) => step.uses)
			.filter((uses) => uses?.startsWith(`${action}@`)),
	);
	expect([...pins], `sibling ${action} pins besides ${exceptJob}`).toHaveLength(
		1,
	);
	return [...pins][0] as string;
}
