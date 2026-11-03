import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { expect, describe, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { type RealPi, withRealPi } from "../support/real-pi-harness.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import { recordScopeTransitions } from "../support/trace-recorder.js";

const realPiAvailable =
	spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

// #4634: every `expect.poll` below waits on progress made by a REAL pi child —
// a sidecar write, a provider observation, a shutdown row — and Vitest's poll
// default is 1 s, not this file's 60 s case budget. Under load average 68.83 a
// poll red `Matcher did not succeed in time` while the case still had ~50 s of
// its budget left. 10 s is 10x that default and one sixth of the case budget,
// so a genuinely stuck step still reports a poll timeout, not a case timeout.
const REAL_CHILD_POLL_TIMEOUT_MS = scaledTestTimeout(10_000);

const situationalTools: string[] = TOOL_REGISTRY.flatMap((tool) =>
	"situational" in tool && tool.situational && tool.piName ? [tool.piName] : [],
).sort();

function roster(pi: RealPi): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : [])
		.flatMap((tool) =>
			typeof (tool as { name?: unknown }).name === "string"
				? [(tool as { name: string }).name]
				: [],
		)
		.sort();
}

/** Tool names, in wire order, of the provider request at `index`. */
function wireTools(pi: RealPi, index: number): string[] {
	const tools = pi.providerObservations()[index]?.tools;
	return (Array.isArray(tools) ? tools : []).flatMap((tool) =>
		typeof (tool as { name?: unknown }).name === "string"
			? [(tool as { name: string }).name]
			: [],
	);
}

/** The session sidecars that carry a lazy-tool memory. */
function lazyMemorySidecars(pi: RealPi): string[] {
	return pi.lens.sessionSidecars().filter((file) => {
		try {
			return readFileSync(file, "utf8").includes('"lazy-tool-memory":["');
		} catch {
			return false;
		}
	});
}

/**
 * `[added, removed, reason]` of every active-tool-set rewrite pi-lens logged
 * after the first `skip` of them, activations by the model excluded: the rewrites
 * a restarted pi-lens made to the loadout the host handed it.
 */
function toolSetRewritesAfter(pi: RealPi, skip: number): unknown[] {
	return pi.lens
		.latencyRows()
		.filter((row) => row.phase === "tool_set_mutation")
		.slice(skip)
		.map((row) => row.metadata as Record<string, unknown>)
		.filter((metadata) => metadata.reason !== "lazy_activation")
		.map((metadata) => [
			metadata.addedCount,
			metadata.removedCount,
			metadata.reason,
		]);
}

/**
 * The version of the `pi` the harness spawns: the child's PATH puts the repo's
 * `node_modules/.bin` first (`withRepoBinOnPath`), so a global pi on the
 * caller's PATH is not the host under test (#4741: a round-1 probe read the
 * global one). Read from the package that bin resolves to, not a second spawn.
 */
function spawnedPiVersion(): string {
	const bin = realpathSync(
		fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url)),
	);
	for (let dir = path.dirname(bin); ; dir = path.dirname(dir)) {
		const manifest = path.join(dir, "package.json");
		if (existsSync(manifest))
			return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string })
				.version;
		if (path.dirname(dir) === dir)
			throw new Error(`no package.json above ${bin}`);
	}
}

/** pi 1.4 activates the extension tools a resumed branch never mentioned. */
function hostActivatesUnmentioned(version: string): boolean {
	const parsed = semver.coerce(version);
	if (parsed === null) throw new Error(`unreadable pi version ${version}`);
	return semver.gte(parsed, "1.4.0");
}

/**
 * Activate a lazy tool, then restart pi on the same session (`--continue`) and
 * return the roster before and on the first request after the restart. The
 * scripted provider restarts its script in the new process, so that first
 * request is sent before any tool ran: it shows the loadout pi and pi-lens
 * agreed on, not an activation the new process made itself.
 */
async function activateThenResume(forgetMemory: boolean): Promise<{
	activated: string[];
	resumed: string[];
	resumeRewrites: unknown[];
	hostVersion: string;
}> {
	return withRealPi(
		{
			fixture: "lifecycle",
			script: "script.json",
			persistedSession: true,
			env: { PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("startup");
			await pi.awaitAssistantTurn();
			await pi.awaitToolResult("pi_lens_activate_tools");
			await pi.awaitAssistantTurn();
			const activated = wireTools(pi, pi.providerObservations().length - 1);
			expect(activated).toContain("ast_grep_search");
			expect(
				activated.filter((name) => situationalTools.includes(name)),
			).toEqual(["ast_grep_search"]);
			// The sidecar is a fire-and-forget write at turn_end; restarting
			// before it lands would test that race, not the loadout.
			await expect
				.poll(() => lazyMemorySidecars(pi), {
					timeout: REAL_CHILD_POLL_TIMEOUT_MS,
				})
				.not.toHaveLength(0);
			// Orderly shutdown drains the child's log writers (AGENTS.md shape 67: a
			// child's `log` only enqueues), so the rows counted below are all of the
			// first child's, and a write of its own cannot land in the resumed
			// child's window. The sidecar is forgotten AFTER that shutdown, which
			// may itself write one.
			await pi.quit();
			if (forgetMemory)
				for (const file of lazyMemorySidecars(pi))
					rmSync(file, { force: true });

			const rewritesBeforeResume = pi.lens
				.latencyRows()
				.filter((row) => row.phase === "tool_set_mutation").length;
			await pi.resume();
			const before = pi.providerObservations().length;
			await pi.prompt("after resume");
			await expect
				.poll(() => pi.providerObservations().length, {
					timeout: REAL_CHILD_POLL_TIMEOUT_MS,
				})
				.toBeGreaterThan(before);
			// The resumed child's `session_start` record is enqueued before its first
			// request but may not be on disk yet; read only after it has shut down.
			const resumed = wireTools(pi, before);
			await pi.quit();
			return {
				activated,
				resumed,
				resumeRewrites: toolSetRewritesAfter(pi, rewritesBeforeResume),
				hostVersion: spawnedPiVersion(),
			};
		},
	);
}

function lifecycleRows(pi: RealPi) {
	return pi.lens
		.latencyRows()
		.filter((row) => row.phase === "session_scope_transition")
		.map((row) => {
			const metadata = row.metadata as
				| { transition?: string; reason?: string }
				| undefined;
			return `${metadata?.transition}:${metadata?.reason}`;
		});
}

function deadWeightRows(pi: RealPi) {
	return pi.lens
		.extensionLog()
		.filter((row) => row.message === "situational tool dead weight");
}

function deadWeightTools(pi: RealPi, index: number): string[] | undefined {
	const tools = (
		deadWeightRows(pi)[index]?.metadata as { tools?: string[] } | undefined
	)?.tools;
	return tools ? [...tools].sort() : undefined;
}

async function sessionFile(pi: RealPi): Promise<string> {
	await expect
		.poll(() => pi.sessionFiles().length, {
			timeout: REAL_CHILD_POLL_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	return pi.sessionFiles().at(-1) as string;
}

async function turn(pi: RealPi, text: string, expected: string[]) {
	await pi.prompt(text);
	await pi.awaitAssistantTurn();
	await expect
		.poll(() => roster(pi), { timeout: REAL_CHILD_POLL_TIMEOUT_MS })
		.toEqual(expected);
}

// flake-shape: real-process-spawn — this is the only lane that can observe a real pi factory re-run, persisted-session restart, and stdin-close shutdown in one process sequence.
// Recurrence prevented: an in-process mock preserves its extension closure and cannot prove pi's lifecycle ordering (#2891, #2858, #2866).
describe.skipIf(!realPiAvailable)("real pi lifecycle witness", () => {
	it("drives startup, reload, new, resume, fork, and quit in order", async () => {
		await withRealPi(
			{
				fixture: "lifecycle",
				script: "script.json",
				agentSettings: { defaultTools: ["+codemode"] },
				persistedSession: true,
				env: { PI_LENS_TEST_MODE: "0" },
				extensions: [
					fileURLToPath(
						new URL(
							"../fixtures/real-harness/reload-extension.mjs",
							import.meta.url,
						),
					),
				],
			},
			async (pi) => {
				await pi.prompt("startup");
				await pi.awaitAssistantTurn();
				await pi.awaitToolResult("pi_lens_activate_tools");
				await pi.awaitAssistantTurn();
				const activatedRoster = roster(pi);
				expect(activatedRoster).toContain("ast_grep_search");
				const freshRoster = activatedRoster.filter(
					(name) => name !== "ast_grep_search",
				);
				const initialSessionFile = await sessionFile(pi);

				await pi.prompt("/real-harness-reload");
				await turn(pi, "after reload", activatedRoster);
				await expect
					.poll(() => deadWeightRows(pi), {
						timeout: REAL_CHILD_POLL_TIMEOUT_MS,
					})
					.toHaveLength(0);

				await pi.newSession();
				await turn(pi, "after new", freshRoster);
				const freshSessionFile = await sessionFile(pi);
				expect(freshSessionFile).not.toBe(initialSessionFile);
				await expect
					.poll(() => deadWeightRows(pi), {
						timeout: REAL_CHILD_POLL_TIMEOUT_MS,
					})
					.toHaveLength(1);
				expect(deadWeightTools(pi, 0)).toEqual(
					situationalTools.filter((name) => name !== "ast_grep_search"),
				);

				const beforeResumeSessionFile = freshSessionFile;
				await pi.resume();
				await turn(pi, "after resume", freshRoster);
				const resumedSessionFile = await sessionFile(pi);
				expect(resumedSessionFile).toBe(beforeResumeSessionFile);
				await expect
					.poll(() => deadWeightRows(pi), {
						timeout: REAL_CHILD_POLL_TIMEOUT_MS,
					})
					.toHaveLength(2);
				expect(deadWeightTools(pi, 1)).toEqual(situationalTools);
				// The resumed process restarts the script, so its first turn
				// activates ast_grep_search again; the fork below adopts that.
				// Wait for the activation to run: a clone sent while the tool
				// call is still in its hooks drops it (#4493's HEAD look made
				// that window a git spawn wide).
				await pi.awaitToolResult("pi_lens_activate_tools");
				await pi.awaitAssistantTurn();

				await pi.clone();
				await turn(pi, "after fork", activatedRoster);
				await expect
					.poll(() => deadWeightRows(pi), {
						timeout: REAL_CHILD_POLL_TIMEOUT_MS,
					})
					.toHaveLength(3);
				expect(deadWeightTools(pi, 2)).toEqual(
					situationalTools.filter((name) => name !== "ast_grep_search"),
				);

				await pi.quit();
				await expect
					.poll(() => deadWeightRows(pi), {
						timeout: REAL_CHILD_POLL_TIMEOUT_MS,
					})
					.toHaveLength(4);
				expect(deadWeightTools(pi, 3)).toEqual(situationalTools);
				const rows = pi.lens
					.latencyRows()
					.filter((row) => row.phase === "session_scope_transition");
				const expectedTransitions = [
					"end:superseded",
					"start:startup",
					"shutdown:reload",
					"start:reload",
					"shutdown:new",
					"start:new",
					"shutdown:quit",
					"end:superseded",
					"start:startup",
					"shutdown:fork",
					"start:fork",
					"shutdown:quit",
				];
				expect(
					lifecycleRows(pi),
					JSON.stringify({
						rows,
					}),
				).toEqual(expectedTransitions);
				// #3533: feeds scripts/trace-validate-session-lifecycle.mjs when asked.
				recordScopeTransitions(pi, "lifecycle-drive");
			},
		);
	}, 60_000);

	// Recurrence prevented (#4513): pi 1.3 restores a resumed session's active
	// tools from the transcript while pi-lens re-plans the set at
	// `session_start`. A host that restores after that handler, or a plan that
	// disagrees with the restore, would change the advertised tool list (and the
	// prompt-cache prefix) on every resume.
	//
	// Recurrence prevented (#4741): pi 1.4 restores the recorded loadout PLUS every
	// extension tool the branch never mentioned, and a lazy tool the model never
	// activated is never mentioned. So pi 1.4 hands pi-lens every lazy tool
	// active and the plan removes the ones it does not remember, in the same
	// `session_start`, before the first request. The roster assertion proves the
	// removal landed in time; the rewrite assertion pins its size. pi <= 1.3
	// hands the plan the remembered set, so the plan rewrites nothing. A plan
	// that drops the remembered tool, or leaves a lazy tool active, changes the
	// size (and the roster) on either host.
	it("keeps the activated lazy tool, and only it, when pi-lens remembers the activation across a resume", async () => {
		const { activated, resumed, resumeRewrites, hostVersion } =
			await activateThenResume(false);
		expect(resumed).toEqual(activated);
		expect(resumeRewrites, `pi ${hostVersion}`).toEqual(
			hostActivatesUnmentioned(hostVersion)
				? [[0, situationalTools.length - 1, "fresh_session_lazy_deactivation"]]
				: [],
		);
	}, 60_000);

	// pi 1.3 restores the transcript's loadout (ast_grep_search stays active);
	// older hosts activate every registered tool. Either way pi-lens's plan
	// decides: with no remembered activation the lazy tools go back to inactive.
	it("deactivates the lazy tools the host restored or re-activated when pi-lens has no memory of them", async () => {
		const { activated, resumed, resumeRewrites, hostVersion } =
			await activateThenResume(true);
		expect(resumed).toEqual(
			activated.filter((name) => !situationalTools.includes(name)),
		);
		// One rewrite: the lazy tool the host restored from the transcript on
		// pi <= 1.3, every lazy tool the host activated on pi 1.4.
		expect(resumeRewrites, `pi ${hostVersion}`).toEqual([
			[
				0,
				hostActivatesUnmentioned(hostVersion) ? situationalTools.length : 1,
				"fresh_session_lazy_deactivation",
			],
		]);
	}, 60_000);
});
