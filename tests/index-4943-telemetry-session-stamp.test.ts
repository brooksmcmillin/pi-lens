// flake-shape: ungoverned-wait-for — a collect-later runner answer settles inside the loaded extension copy and exposes no awaitable, so vi.waitFor joins the latency row the dispatcher logs when it lands.
/**
 * #4943: a write is stamped with the session that made it.
 *
 * The defect: two sessions in one pi process (an in-process subagent, #473)
 * share the module-scope `RuntimeCoordinator`, and `handleToolResult` handed
 * the pipeline `runtime.telemetrySessionId` (the PRIMARY's id) for every
 * session's write. The subagent's edit was logged under the primary in
 * `change-log.jsonl`, in `logs/<date>.jsonl` and in `read-guard.log`, and the
 * same stamp keys a collect-later runner answer (`PendingRunnerFindings
 * .sessionId`), so a subagent's late findings were drained by the PRIMARY's
 * turn end.
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary. The second session starts while the
 * first is live, so `session_start` classifies it a concurrent secondary
 * (#4704). Both sessions work in one project, the shape a cwd filter passes.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GUARDED_FLAGS,
	endTurn,
	readTarget,
	step,
	textBlocks,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

// `read_pattern` rows are verbose-only; the extension's copy of the logger
// reads this at its own load, so it is set before the first session starts and
// put back in afterAll (the accepted shape of test-env-restore-sweep).
const savedVerbose = process.env.PI_LENS_READ_GUARD_VERBOSE;
process.env.PI_LENS_READ_GUARD_VERBOSE = "1";
afterAll(() => {
	if (savedVerbose === undefined) delete process.env.PI_LENS_READ_GUARD_VERBOSE;
	else process.env.PI_LENS_READ_GUARD_VERBOSE = savedVerbose;
});

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

function project(name: string): string {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
	return proj;
}

/** Every `user`-role text the model received, prompts and injections. */
function userTexts(handle: PiSession): string {
	return handle.requests
		.flatMap((request) =>
			request
				.filter((message) => message.role === "user")
				.flatMap((message) => textBlocks(message)),
		)
		.join("\n");
}

/**
 * A `shellcheck` on PATH whose FIRST lint takes longer than the collect-later
 * threshold (so the dispatcher moves the runner off the write path) and whose
 * later lints answer in a few hundred ms with one blocking and one advisory
 * finding. The real dispatcher, runner and pending store do the rest.
 */
function installSlowShellcheck(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const script = [
		"#!/bin/sh",
		'for a in "$@"; do',
		'  if [ "$a" = "--version" ]; then echo "version: 0.9.0"; exit 0; fi',
		"done",
		`count=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
		"count=$((count + 1))",
		`echo $count > "${dir}/count"`,
		"for last; do :; done",
		'if [ "$count" = 1 ]; then sleep 5.5; else sleep 0.3; fi',
		`printf '[{"file":"%s","line":2,"column":1,"level":"error","code":9001,"message":"fake blocking"},{"file":"%s","line":3,"column":1,"level":"warning","code":9002,"message":"fake advisory"}]' "$last" "$last"`,
		"exit 1",
		"",
	].join("\n");
	const bin = path.join(dir, "shellcheck");
	fs.writeFileSync(bin, script, { mode: 0o755 });
}

interface Row {
	readonly [key: string]: unknown;
	sessionId?: string;
	filePath?: string;
	event?: string;
}

/** Every row of one of the pinned home's sinks, flushed first. */
async function homeRows(handle: PiSession, ...rel: string[]): Promise<Row[]> {
	await handle.latencyRows();
	const read = readNdjsonRows<Row>(path.join(fixture.root, "home", ...rel));
	expect(read.skipped).toBe(0);
	return read.rows;
}

/** The session ids named by the rows about `file`. */
function idsFor(rows: readonly Row[], file: string): string[] {
	return [
		...new Set(
			rows.flatMap((row) =>
				row.filePath !== undefined &&
				path.resolve(row.filePath) === path.resolve(file) &&
				row.sessionId !== undefined
					? [row.sessionId]
					: [],
			),
		),
	];
}

describe("#4943: a concurrent session's write is stamped with its own session id", () => {
	it(
		"names the writing session in the change log, the diagnostics log and the read-guard log",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4943 (the census probe C6). The subagent's
			// `sbad.ts` write carried the PRIMARY's id in change-log.jsonl and in
			// logs/<date>.jsonl, so an investigation keyed on session id credited
			// the subagent's edits to the primary.
			const proj = project("rows");
			const mine = path.join(proj, "src", "mine.ts");
			const theirs = path.join(proj, "src", "theirs.ts");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(readTarget(path.join(proj, "src", "seed.ts")), "reading"),
					step(writeTarget(mine, BLOCKING_FILE), "writing"),
					endTurn("primary idle"),
				],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(readTarget(path.join(proj, "src", "seed.ts")), "reading"),
					step(writeTarget(theirs, BLOCKING_FILE), "writing"),
					endTurn("secondary idle"),
				],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const secondaryId = secondary.session.sessionManager.getSessionId();
			expect(secondaryId).not.toBe(primaryId);

			await primary.prompt("write mine");
			await secondary.prompt("write theirs");

			// change-log.jsonl: one row per write, under the writer.
			const changes = readNdjsonRows<Row>(
				path.join(getProjectDataDir(proj), "change-log.jsonl"),
			);
			expect(changes.skipped).toBe(0);
			expect(idsFor(changes.rows, mine)).toEqual([primaryId]);
			expect(idsFor(changes.rows, theirs)).toEqual([secondaryId]);

			// logs/<date>.jsonl: the diagnostics the pipeline caught for each write.
			const day = new Date().toISOString().split("T")[0];
			const diagnostics = await homeRows(primary, "logs", `${day}.jsonl`);
			expect(idsFor(diagnostics, mine)).toEqual([primaryId]);
			expect(idsFor(diagnostics, theirs)).toEqual([secondaryId]);

			// read-guard.log: a session's read of the seed (a row at tool_call and
			// one at tool_result) names its reader.
			const guard = await homeRows(primary, "read-guard.log");
			const readers = guard.filter((row) => row.event === "read_pattern");
			expect(idsFor(readers, path.join(proj, "src", "seed.ts")).sort()).toEqual(
				[primaryId, secondaryId].sort(),
			);
			expect(readers.map((row) => row.sessionId).sort()).toEqual(
				[primaryId, primaryId, secondaryId, secondaryId].sort(),
			);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"keeps a subagent's collect-later answer, blocker and advisory with the subagent",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4943 and its #4940 review probe P6. A runner
			// answer the dispatcher deferred for the SUBAGENT's write was stamped
			// with the primary's id, so the PRIMARY's turn end drained it, took
			// its blocker as its own record and told its model "Unresolved from
			// this turn" about the subagent's file; the subagent never heard.
			const proj = project("deferred");
			const bin = path.join(fixture.root, "fake-bin");
			installSlowShellcheck(bin);
			const savedPath = process.env.PATH;
			process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
			try {
				const script = "#!/bin/bash\necho $x\nls $y\n";
				const first = path.join(proj, "src", "first.sh");
				const theirs = path.join(proj, "src", "theirs.sh");
				const primary = await startPiSession({
					root: fixture.root,
					cwd: proj,
					flags: new Map(GUARDED_FLAGS),
					responses: [
						step(writeTarget(first, script), "writing"),
						endTurn("primary wrote"),
						endTurn("primary acknowledged"),
						endTurn("primary idle"),
						endTurn("primary idle again"),
						endTurn("primary last look"),
						endTurn("primary last look again"),
					],
				});
				const secondary = await startPiSession({
					root: fixture.root,
					cwd: proj,
					flags: new Map(GUARDED_FLAGS),
					responses: [
						step(writeTarget(theirs, script), "writing"),
						endTurn("secondary wrote"),
						endTurn("secondary idle"),
						endTurn("secondary idle again"),
						endTurn("secondary settled"),
					],
				});

				// The primary's write is the runner's slow observation: its next
				// dispatch in this project is collect-later.
				await primary.prompt("write first");
				// The primary's own blocker is staged for its next request; it takes
				// it here, so the subagent's first request finds nothing of the
				// primary's in the shared per-project delivery slot.
				await primary.prompt("acknowledge");
				await secondary.prompt("write theirs");
				// The deferred run settles in the store: the dispatcher logs the run's
				// answer (a status other than `pending`) when it lands.
				await vi.waitFor(
					async () => {
						const { rows } = await secondary.latencyRows();
						expect(
							rows.some(
								(row) =>
									row.type === "runner" &&
									row.runnerId === "shellcheck" &&
									String(row.filePath).endsWith("theirs.sh") &&
									row.status !== "pending",
							),
						).toBe(true);
					},
					{ timeout: 10_000 },
				);

				// The primary's turn end comes first: it must not take the subagent's
				// answer. A turn end's delivery is injected into the NEXT request, so
				// each session prompts once more to receive what its turn end staged.
				await primary.prompt("anything new?");
				await primary.prompt("and again?");
				expect(userTexts(primary)).not.toContain("theirs.sh");
				expect(userTexts(primary)).not.toContain("Late runner diagnostics");

				// The subagent's own turn end delivers both halves of its answer.
				await secondary.prompt("anything new?");
				await secondary.prompt("and again?");
				const secondaryTexts = userTexts(secondary);
				expect(secondaryTexts).toContain(
					`Unresolved from this turn — ${path.join("src", "theirs.sh")}`,
				);
				expect(secondaryTexts).toContain(
					"Late runner diagnostics (shellcheck completed",
				);
				// The subagent's turn end recorded its blocker. It is the subagent's
				// record, so the primary's next turn end (and the request after it)
				// still knows nothing of the subagent's file. The subagent's last
				// turn end staged that blocker in the project's one delivery slot,
				// and the primary asks first: the slot is the subagent's (#4943 R1,
				// the #4940 review F2 end to end), so the primary leaves it and the
				// subagent's next request takes it.
				await primary.prompt("last look");
				await primary.prompt("last look again");
				expect(userTexts(primary)).not.toContain("theirs.sh");
				const secondaryBefore = secondary.requests.length;
				await secondary.prompt("settled?");
				expect(
					secondary.requests
						.slice(secondaryBefore)
						.flatMap((request) =>
							request
								.filter((message) => message.role === "user")
								.flatMap((message) => textBlocks(message)),
						)
						.join("\n"),
				).toContain(
					`Unresolved from this turn — ${path.join("src", "theirs.sh")}`,
				);
				expect(primary.errors).toEqual([]);
				expect(secondary.errors).toEqual([]);
				await secondary.dispose();
				await primary.dispose();
			} finally {
				if (savedPath === undefined) delete process.env.PATH;
				else process.env.PATH = savedPath;
			}
		},
	);
});
