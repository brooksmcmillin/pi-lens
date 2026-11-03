/**
 * #4941: the commit gate judges the repository being committed, not the
 * process.
 *
 * The defect: `--lens-guard`'s blocker latch lived once per process, so an
 * in-process subagent (#473) committing in repository B was refused for a
 * blocker its primary wrote in repository A, and the refusal named A's file.
 * The gate reads every session's records because the tree is shared (#4921,
 * `docs/invariants/git-guard-host.md`); the missing key was the tree, not the
 * session.
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary. The second session starts while the
 * first is live, so `session_start` classifies it a concurrent secondary
 * (#4704). The primary raises its blocker by its own write; nothing is seeded.
 * Each project is a git checkout by the marker the gate resolves (`.git/HEAD`).
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	type Received,
	commitAttempt,
	endTurn,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

/** A git checkout holding one clean source file. */
function repo(name: string): string {
	const dir = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "seed.ts"), CLEAN_FILE);
	// The marker `resolveGitCheckout` reads; the gate spawns no git.
	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return dir;
}

function lastBash(requests: readonly (readonly unknown[])[]): Received {
	const results = toolResults(
		(requests.at(-1) ?? []) as Parameters<typeof toolResults>[0],
		"bash",
	);
	return results.at(-1) ?? { text: "(no bash result)", isError: false };
}

/** The primary writes a blocker in `proj`; a secondary in `other` commits. */
async function commitFromSecondary(
	proj: string,
	other: string,
	blocker: string | undefined,
): Promise<Received> {
	const primary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: new Map(GUARDED_FLAGS),
		responses: [
			step(
				writeTarget(path.join(proj, "src", "bad.ts"), blocker ?? CLEAN_FILE),
				"writing",
			),
			endTurn("written"),
		],
	});
	const secondary = await startPiSession({
		root: fixture.root,
		cwd: other,
		flags: new Map(GUARDED_FLAGS),
		responses: [step(commitAttempt(), "committing"), endTurn("done")],
	});
	await primary.prompt("write the file");
	await secondary.prompt("commit it");
	const verdict = lastBash(secondary.requests);
	expect(primary.errors).toEqual([]);
	expect(secondary.errors).toEqual([]);
	await secondary.dispose();
	await primary.dispose();
	return verdict;
}

describe("#4941: a commit is gated by the blockers in its own repository", () => {
	it(
		"lets a secondary commit in repository B past the primary's blocker in repository A",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4941 (census C3): the secondary's `git commit`
			// in another repository came back `COMMIT BLOCKED` with the primary's
			// debugger blocker, and the marker never ran.
			const verdict = await commitFromSecondary(
				repo("a-other"),
				repo("b-other"),
				BLOCKING_FILE,
			);
			expect(verdict.text).not.toContain(GATE_BLOCK);
			expect(verdict.text).toContain(RAN_MARKER);
		},
	);

	it(
		"still refuses a secondary committing in the repository that holds the primary's blocker",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4941's other direction: the key is the tree, not
			// the session, so a subagent cannot commit over the primary's blocker
			// in the same repository (the gate reads every record, #4921).
			const proj = repo("same");
			const verdict = await commitFromSecondary(proj, proj, BLOCKING_FILE);
			expect(verdict.text).toContain(GATE_BLOCK);
			expect(verdict.text).toContain("Debugger statement");
			expect(verdict.text).not.toContain(RAN_MARKER);
		},
	);

	it(
		"commits in another repository when the primary is clean (the control)",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			const verdict = await commitFromSecondary(
				repo("a-clean"),
				repo("b-clean"),
				undefined,
			);
			expect(verdict.text).not.toContain(GATE_BLOCK);
			expect(verdict.text).toContain(RAN_MARKER);
		},
	);
});
