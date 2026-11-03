/**
 * #5020 — a row of an inline-blocker record that names ANOTHER file retires on
 * the cited file's own state, and only on it.
 *
 * Recurrence: helm-lint reports `templates/other-b.yaml` while the agent wrote
 * `templates/deploy-a.yaml`, so the row sits in deploy-a's record. Fixing or
 * deleting other-b never re-dispatched deploy-a, so the record, and the commit
 * gate behind it, outlived the cause. These cases drive the coordinator seam
 * (`retireForeignRows`, `retireForeignRowsOfMissingFiles`) for the rules the
 * tool_result witness in `tests/index-3190-inline-blocker-deleted-path-witness.test.ts`
 * cannot reach: the ordering token, the own-row and no-structure refusals, the
 * rebuilt derived fields, and the project-root resolution of a relative cite.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import { verdictRunnerIds } from "../../clients/dispatch/types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import {
	evaluateGitGuard,
	syncGitGuardRecord,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { beginScope } from "../../clients/session-scope.js";
import { setupTestEnvironment } from "./test-utils.js";

function row(
	filePath: string,
	line: number,
	tool: string,
	runnerId = tool,
): Diagnostic {
	return {
		id: `${tool}:${line}`,
		message: `${tool} finding at ${line}`,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool,
		runnerId,
		rule: "error",
	};
}

function record(
	runtime: RuntimeCoordinator,
	filePath: string,
	diagnostics: Diagnostic[],
): void {
	runtime.recordInlineBlockers(
		filePath,
		formatDiagnostics(diagnostics, "blocking").trim(),
		runtime.nextWriteIndex(),
		[...new Set(diagnostics.map((d) => d.tool ?? "unknown"))],
		diagnostics
			.filter((d) => d.filePath === filePath)
			.map((d) => d.line)
			.filter((line): line is number => typeof line === "number"),
		undefined,
		diagnostics,
	);
}

describe("#5020 retireForeignRows", () => {
	it("drops the rows naming the cited file, keeps the record's own, and rebuilds the derived fields", () => {
		const env = setupTestEnvironment("pi-lens-5020-narrow-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(a, 1, "yamllint"), row(b, 2, "helm-lint")]);

			const changed = runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics?.map((d) => d.tool)).toEqual(["yamllint"]);
			// The retired row's source and line leave with it, so the next verdict
			// that covers the rest can retire the rest.
			expect(after?.sources).toEqual(["yamllint"]);
			expect(after?.lines).toEqual([1]);
			expect(after?.summary).not.toContain("helm-lint finding");
			// A narrowed record is not a resolved file.
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("never retires a row of the record's own file, whatever the verdict says", () => {
		const env = setupTestEnvironment("pi-lens-5020-own-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(a, 1, "yamllint")]);

			expect(runtime.retireForeignRows("cited-file-clean", () => true)).toEqual(
				[],
			);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a record can hold a blocking row with no cited file
	// (the `Diagnostic` type requires `filePath`, so such a row reaches the record
	// only from outside the type system, and this cell builds that shape with the
	// cast below). A retire must keep it and must not dereference the absent path:
	// with `isCrossFileBlocker`'s `!!d.filePath` clause removed this cell throws
	// `TypeError: Cannot read properties of undefined (reading 'includes')`, which
	// is what a turn-end hook would do instead of delivering its findings.
	it("keeps a row that cites no file and places its line, as the record's own", () => {
		const env = setupTestEnvironment("pi-lens-5020-nocite-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			// Three lines, so the row's line 3 is a real coordinate of `a`
			// (review N1: a past-EOF line would be demoted, not placed).
			fs.writeFileSync(a, "a: 1\nb: 2\nc: 3\n");
			const runtime = new RuntimeCoordinator();
			const noCite = {
				id: "helm-lint:3",
				message: "helm-lint finding at 3",
				line: 3,
				severity: "error",
				semantic: "blocking",
				tool: "helm-lint",
				runnerId: "helm-lint",
				rule: "error",
			} as unknown as Diagnostic;
			record(runtime, a, [noCite, row(b, 2, "helm-lint")]);

			const changed = runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics).toEqual([noCite]);
			// Read as the record's own, so its line is placed in this file — the
			// same reading `clients/pipeline.ts` gives such a row when it stamps a
			// line hash. The derived `lines` is rebuilt from the survivors.
			expect(after?.lines).toEqual([3]);
		} finally {
			env.cleanup();
		}
	});

	it("removes a record whose rows all name the cited file, and says it was resolved", () => {
		const env = setupTestEnvironment("pi-lens-5020-all-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(b, 2, "helm-lint")]);

			runtime.retireForeignRows(
				"cited-file-clean",
				() => true,
				runtime.nextWriteIndex(),
			);

			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a record the clean verdict is not strictly newer than", () => {
		const env = setupTestEnvironment("pi-lens-5020-order-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			const older = runtime.nextWriteIndex();
			record(runtime, a, [row(b, 2, "helm-lint")]);

			expect(
				runtime.retireForeignRows("cited-file-clean", () => true, older),
			).toEqual([]);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a record with no structured rows alone", () => {
		const env = setupTestEnvironment("pi-lens-5020-text-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				a,
				"🔴 STOP — 1 issue(s) must be fixed:",
				runtime.nextWriteIndex(),
				["helm-lint"],
			);

			expect(runtime.retireForeignRows("cited-file-clean", () => true)).toEqual(
				[],
			);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5020 retireForeignRowsOfMissingFiles", () => {
	it("retires a row whose absolute cite is gone and keeps one whose file exists", () => {
		const env = setupTestEnvironment("pi-lens-5020-missing-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const kept = path.join(env.tmpDir, "kept.yaml");
			const gone = path.join(env.tmpDir, "gone.yaml");
			fs.writeFileSync(a, "a: 1\n");
			fs.writeFileSync(kept, "k: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [
				row(kept, 1, "helm-lint"),
				row(gone, 2, "helm-lint"),
			]);

			const changed = runtime.retireForeignRowsOfMissingFiles({
				sessionId: undefined,
			});

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics?.map((d) => d.filePath)).toEqual([kept]);
			// A deletion is not a clean verdict: no "Resolved" claim.
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			expect(
				runtime.retireForeignRowsOfMissingFiles({ sessionId: undefined }),
			).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a row spelled relatively (`a.ts` for the record
	// `/tmp/x/a.ts`) reads as another file, and resolving it against a guessed
	// root found it "missing" and retired a live blocker of the record's own file
	// (tests/clients/turn-end-resolved-blockers.test.ts went red on exactly that).
	it("keeps a row with a relative cite it cannot place", () => {
		const env = setupTestEnvironment("pi-lens-5020-relative-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row("a.yaml", 1, "helm-lint")]);

			expect(
				runtime.retireForeignRowsOfMissingFiles({ sessionId: undefined }),
			).toEqual([]);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5020 verdictRunnerIds", () => {
	const runner = (
		runnerId: string,
		status: "succeeded" | "failed" | "skipped",
		failureKind?: string,
	) =>
		({
			runnerId,
			status,
			...(failureKind !== undefined && { failureKind }),
			startTime: 0,
			endTime: 0,
			durationMs: 0,
			diagnosticCount: 0,
			semantic: "none",
		}) as const;

	// Recurrence it prevents (PR #5033 round 3): the predicate admitted only
	// `succeeded`, so a runner that completed and failed on findings (mypy
	// reporting another module) never spoke for the file it answered. The other
	// direction is pinned too: a `failed` run that broke (a timeout) or names no
	// kind reached no verdict, and must still name nothing.
	it("names the runners that reached a verdict and were not inconclusive", () => {
		expect(
			verdictRunnerIds({
				latencyReport: {
					runners: [
						runner("helm-lint", "succeeded"),
						runner("mypy", "failed", "blocking_diagnostics"),
						runner("phpstan", "failed", "timeout"),
						runner("cue-vet", "failed"),
						runner("ruff-lint", "skipped"),
						runner("yamllint", "succeeded"),
					],
				} as never,
				inconclusiveSources: {
					runnerIds: ["yamllint"],
					serverIds: [],
					collectLaterRunnerIds: [],
				},
			}),
		).toEqual(["helm-lint", "mypy"]);
	});

	// Recurrence it prevents: `checkedWholeFile` in the same module refuses an
	// edit-scoped verdict, and this predicate admitted one, so an ast-grep run
	// that answered only for the edited ranges could retire another file's row
	// on evidence that never covered the rest of the file (PR #5033 review F3).
	it("refuses a runner whose verdict covers only the edited ranges", () => {
		expect(
			verdictRunnerIds({
				latencyReport: {
					runners: [
						runner("ast-grep", "succeeded"),
						runner("helm-lint", "succeeded"),
					],
				} as never,
				editScopedRunnerIds: ["ast-grep"],
				inconclusiveSources: {
					runnerIds: [],
					serverIds: [],
					collectLaterRunnerIds: [],
				},
			}),
		).toEqual(["helm-lint"]);
	});
});

/**
 * PR #5033 round 3 (F1, item 4): a sweep that persists acts only on its own
 * session's records. A session's records are persisted into that session's
 * cwd cache, so a sweep run by ANOTHER session at another cwd that retired the
 * row wrote the wrong project's cache, and the owner's record kept the row and
 * refused the owner's next commit with nothing left to fix.
 */
describe("#5020 a missing-file sweep acts on its own session's records", () => {
	const PRIMARY = "pi-lens-5020-primary";
	const SECONDARY = "pi-lens-5020-secondary";
	const COMMIT = { toolName: "bash", input: { command: 'git commit -m "x"' } };

	afterEach(() => {
		cancelLSPIdleReset();
	});

	/** The primary's record in project A, with a row citing A's `other.yaml`,
	 *  persisted into A's cache by the gate's own writer; then the cite goes. */
	function primaryRecordWithDeadCite(tmpDir: string) {
		const projA = path.join(tmpDir, "projA");
		const projB = path.join(tmpDir, "projB");
		fs.mkdirSync(projA, { recursive: true });
		fs.mkdirSync(projB, { recursive: true });
		const deploy = path.join(projA, "deploy.yaml");
		const other = path.join(projA, "other.yaml");
		fs.writeFileSync(deploy, "a: 1\n");
		fs.writeFileSync(other, "b: 1\nc: 2\n");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: PRIMARY });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);
		runtime.bumpFileSeq(deploy);
		record(runtime, deploy, [row(other, 2, "helm-lint")]);
		runtime.updateGitGuardStatus(true, "blocked", deploy);
		syncGitGuardRecord(runtime, cacheManager, projA, deploy);
		fs.rmSync(other);
		return { projA, projB, deploy, runtime, cacheManager };
	}

	function turnEndDeps(
		runtime: RuntimeCoordinator,
		cacheManager: CacheManager,
		ctxCwd: string,
		sessionId?: string,
	) {
		return {
			ctxCwd,
			...(sessionId !== undefined && {
				sessionId,
				sessionScope: beginScope({ role: "secondary" }),
			}),
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => ({
					success: true,
					issues: [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "skipped",
				}),
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: { getTestRunTarget: () => null },
			resetLSPService: () => {},
			resetFormatService: () => {},
		} as never;
	}

	// Recurrence it prevents (review F1, CodeRabbit PRRT_kwDORt8rec6yI3VK): a
	// concurrent secondary's turn end retired the primary's row and re-derived
	// only the latch, leaving the primary's persisted record to say otherwise.
	it("leaves another session's row to that session's own turn end", async () => {
		const env = setupTestEnvironment("pi-lens-5020-turnend-scope-");
		try {
			const { projA, projB, runtime, cacheManager } = primaryRecordWithDeadCite(
				env.tmpDir,
			);

			// Each turn changed a file of its own project, as a real turn does
			// (a turn that changed nothing returns before the sweep).
			const changed = (file: string, cwd: string, sessionId: string) => {
				fs.writeFileSync(file, "x: 1\n");
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 1 },
					false,
					cwd,
					sessionId,
				);
			};
			runtime.beginTurn(SECONDARY);
			changed(path.join(projB, "b.yaml"), projB, SECONDARY);
			await handleTurnEnd(turnEndDeps(runtime, cacheManager, projB, SECONDARY));
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);

			changed(path.join(projA, "a.yaml"), projA, PRIMARY);
			await handleTurnEnd(turnEndDeps(runtime, cacheManager, projA));
			expect(runtime.getInlineBlockersSnapshot()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (Greptile PRRT_kwDORt8rec6yJw4k): a commit in
	// project B retired the primary's row from memory and rewrote B's cache, so
	// A's record kept the row and refused the primary's commit in A.
	it("leaves another session's row and record to that session's own commit gate", () => {
		const env = setupTestEnvironment("pi-lens-5020-gate-scope-");
		try {
			const { projA, projB, runtime, cacheManager } = primaryRecordWithDeadCite(
				env.tmpDir,
			);

			evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);

			const owner = evaluateGitGuard(
				runtime,
				cacheManager,
				projA,
				"pi",
				undefined,
				COMMIT,
			);
			expect(owner).toEqual({ block: false });
			expect(runtime.getInlineBlockersSnapshot()).toEqual([]);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"missing",
			);
		} finally {
			env.cleanup();
		}
	});
});
