import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	MAX_OWED_ANCHORS,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

describe("RuntimeCoordinator", () => {
	it("resetForSession clears recorded tool-call path attributions (#1642 F5)", () => {
		// A per-session-numbered host (or a fresh session after a crash) must
		// never let a new session inherit a dead session's recorded skip
		// verdict for a reused tool-call id — every sibling correlation/state
		// map is cleared on resetForSession, and this one must be too.
		const runtime = new RuntimeCoordinator();
		runtime.recordToolCallAttribution("call-reused-id", {
			resolvedPath: path.resolve("src/dead-session-file.ts"),
			skipped: true,
			originCwd: path.resolve("."),
		});

		runtime.resetForSession();

		expect(runtime.takeToolCallAttribution("call-reused-id")).toBeUndefined();
	});

	it("resetForSession clears applied-edit retry records (#2402)", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/applied-session-file.ts");
		runtime.partialApplyRecords.record(filePath, "old text", "new text");

		expect(
			runtime.partialApplyRecords.find(filePath, "old text", "new text"),
		).toBeDefined();

		runtime.resetForSession();

		expect(
			runtime.partialApplyRecords.find(filePath, "old text", "new text"),
		).toBeUndefined();
	});

	/** #3613: one code-quality record, named by the session that recorded it. */
	const quality = (rule: string) => ({
		id: `cq:${rule}`,
		filePath: path.resolve("src/quality.ts"),
		displayPath: "src/quality.ts",
		line: 1,
		severity: "warning" as const,
		tool: "ast-grep",
		rule,
		message: rule,
		category: "maintainability" as const,
		origin: "dispatch" as const,
	});
	const rules = (records: { rule?: string }[]) => records.map((r) => r.rule);

	it("resetForSession drops the outgoing session's turn warnings and keeps a concurrent session's (#3613)", () => {
		// The recurrences: a reset that clears every partition drops a live
		// subagent's warnings at the primary's /new, and one that clears none
		// carries a /reload's (same session id) old warnings into its turn.
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		runtime.recordCodeQualityWarnings([quality("own")]);
		runtime.recordCodeQualityWarnings([quality("sub")], "subagent-session");

		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });

		expect({
			own: rules(runtime.peekCodeQualityWarnings()),
			sub: rules(runtime.peekCodeQualityWarnings("subagent-session")),
		}).toEqual({ own: [], sub: ["sub"] });
	});

	it("forgetTurnSession never drops this coordinator's own turn warnings (#3613)", () => {
		// The recurrence: a secondary shutdown with no session id of its own,
		// or the coordinator's id, cleared the primary's partition.
		const runtime = new RuntimeCoordinator();
		runtime.recordCodeQualityWarnings([quality("own")]);
		runtime.recordCodeQualityWarnings([quality("sub")], "subagent-session");

		runtime.forgetTurnSession(undefined);
		runtime.forgetTurnSession(runtime.telemetrySessionId);
		const kept = rules(runtime.peekCodeQualityWarnings());
		runtime.forgetTurnSession("subagent-session");

		expect({
			kept,
			sub: rules(runtime.peekCodeQualityWarnings("subagent-session")),
		}).toEqual({ kept: ["own"], sub: [] });
	});

	it("makes edit autofix deferral sticky after a write until beginTurn", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/sticky.ts");

		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("immediate");
		expect(
			runtime.recordMutationToolReceipt(filePath, "edit").autofixMode,
		).toBe("deferred");
		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("deferred");

		runtime.beginTurn();
		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("immediate");
	});

	it("coalesces autofix and format kinds on one owner-scoped path record", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/coalesced.ts");
		expect(
			runtime.deferMutation(
				filePath,
				process.cwd(),
				"edit",
				process.cwd(),
				"autofix",
				"owner",
			),
		).toBe(true);
		expect(
			runtime.deferMutation(
				filePath,
				process.cwd(),
				"edit",
				process.cwd(),
				"format",
				"owner",
			),
		).toBe(true);

		const [record] = runtime.consumeDeferredFormatFiles();
		expect(record.kinds).toEqual(new Set(["autofix", "format"]));
		expect(record.ownerSessionId).toBe("owner");
	});

	it("merges independently requeued kinds and tool names for one path", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/requeued.ts");
		runtime.deferMutation(
			filePath,
			process.cwd(),
			"write",
			process.cwd(),
			"autofix",
		);
		const [claimed] = runtime.consumeDeferredFormatFiles();
		runtime.requeueDeferredMutations([
			{
				...claimed,
				kinds: new Set(["autofix"]),
				toolNames: new Set(["write"]),
			},
		]);
		runtime.requeueDeferredMutations([
			{ ...claimed, kinds: new Set(["format"]), toolNames: new Set(["edit"]) },
		]);

		const [requeued] = runtime.consumeDeferredFormatFiles();
		expect(requeued.kinds).toEqual(new Set(["autofix", "format"]));
		expect(requeued.toolNames).toEqual(new Set(["write", "edit"]));
	});

	it("merges a requeued phase into a newer record queued during the drain", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/newer.ts");
		runtime.deferMutation(
			filePath,
			"old-cwd",
			"write",
			"old-root",
			"autofix",
			"old-owner",
		);
		const [claimed] = runtime.consumeDeferredFormatFiles();
		runtime.deferMutation(
			filePath,
			"new-cwd",
			"edit",
			"new-root",
			"format",
			"new-owner",
		);
		runtime.requeueDeferredMutations([claimed]);

		const [record] = runtime.consumeDeferredFormatFiles();
		expect(record.kinds).toEqual(new Set(["format", "autofix"]));
		expect(record.toolNames).toEqual(new Set(["edit", "write"]));
		expect(record.cwd).toBe("new-cwd");
		expect(record.ownerSessionId).toBe("new-owner");
	});
	it("resetForSession clears any existing read guard state", () => {
		const runtime = new RuntimeCoordinator();
		const runtimeState = runtime as any;

		runtimeState._readGuard = { sentinel: true };
		runtime.resetForSession();

		expect(runtimeState._readGuard).toBeNull();
	});

	it("accepts the hook-start boundary when resetting a session", () => {
		const runtime = new RuntimeCoordinator();
		const hookStartedAt = Date.now() - 250;

		runtime.resetForSession(hookStartedAt);

		expect(runtime.sessionStartedAt).toBe(hookStartedAt);
	});

	it("tracks first-read LSP warming and suppresses duplicate warmups", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = "/tmp/example.ts";

		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);

		runtime.markLspReadWarmStarted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.markLspReadWarmCompleted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.clearLspReadWarmState(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);
	});

	describe("telemetry model/provider identity (#1448)", () => {
		it("exposes the raw model id separately from the combined display string", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			});

			expect(runtime.telemetryModelId).toBe("claude-sonnet-4-5");
			expect(runtime.telemetryProviderId).toBe("anthropic");
			expect(runtime.telemetryModel).toBe("anthropic/claude-sonnet-4-5");
		});

		it("derives a blank provider before any identity is set", () => {
			const runtime = new RuntimeCoordinator();

			expect(runtime.telemetryModelId).toBe("");
			expect(runtime.telemetryProviderId).toBe("");
		});

		it("derives provider from a known model-id prefix when the host omits provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "claude-sonnet-4-5" });

			expect(runtime.telemetryProviderId).toBe("anthropic");
		});

		it("leaves provider blank when the model id is ambiguous", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "some-custom-finetune" });

			expect(runtime.telemetryProviderId).toBe("");
		});

		it("never lets a later ambiguous model overwrite an already-known provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "gpt-5", provider: "openai" });
			runtime.setTelemetryIdentity({ model: "some-custom-finetune" });

			expect(runtime.telemetryProviderId).toBe("openai");
		});

		it("re-derives a DERIVED provider across a mid-session model switch with no explicit provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "gpt-5-mini" });
			expect(runtime.telemetryProviderId).toBe("openai");

			// Switch models without an explicit provider — the stale "openai"
			// derivation must not survive; it has to re-derive for the new model.
			runtime.setTelemetryIdentity({ model: "claude-sonnet-4-5" });
			expect(runtime.telemetryProviderId).toBe("anthropic");
		});

		it("resetForSession clears the raw model/provider identity", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			});

			runtime.resetForSession();

			expect(runtime.telemetryModelId).toBe("");
			expect(runtime.telemetryProviderId).toBe("");
		});
	});

	describe("getFilesChangedSince (#451)", () => {
		it("returns only files bumped after the given projectSeq", () => {
			const runtime = new RuntimeCoordinator();
			const a = runtime.bumpFileSeq("/proj/a.ts"); // projectSeq 1
			runtime.bumpFileSeq("/proj/b.ts"); // projectSeq 2
			runtime.bumpFileSeq("/proj/c.ts"); // projectSeq 3

			// Since seq 1: b and c (a's last bump was at seq 1, not > 1).
			const changed = runtime.getFilesChangedSince(a.projectSeq);
			expect(changed).toHaveLength(2);
			expect(changed.some((f) => f.endsWith("/b.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/c.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/a.ts"))).toBe(false);

			// Since seq 0: all three.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(3);
		});

		it("keys are separator-normalized: bump one form, query returns the other", () => {
			const runtime = new RuntimeCoordinator();
			// Record with a backslash path form.
			runtime.bumpFileSeq("C:\\proj\\src\\Widget.ts");

			const changed = runtime.getFilesChangedSince(0);
			expect(changed).toHaveLength(1);
			// The returned key is normalized to forward slashes (never backslashes),
			// so a builder keyed on forward-slash fileSignatures matches it.
			expect(changed[0]).not.toContain("\\");
			expect(changed[0].replace(/\\/g, "/").toLowerCase()).toContain(
				"proj/src/widget.ts",
			);
		});

		it("is cleared on session reset", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.resetForSession();
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});

		it("is cleared when sequences are seeded", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.seedProjectSequence(5, new Map([["/proj/a.ts", 3]]));
			// Seeded per-file counters carry no seq provenance ⇒ empty changed map.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});
	});

	// #4137 round 3: an analysis without authorship withholds the blocker
	// channel (#3226), so its clean result says nothing about bytes an authored
	// analysis found blocking. Before this, an opaque recovery of the very bytes
	// an agent authored cleared the record whenever the already-analysed latch
	// was gone (a concurrent session's turn start, the session's own next turn).
	describe("an unauthored clean result on the recorded bytes (#4137 round 3)", () => {
		const recorded = { size: 12, sha256: "a".repeat(64) };
		let dir = "";
		let file = "";
		beforeEach(() => {
			// A live file: the snapshot drops records of deleted files (#1245).
			dir = mkdtempSync(path.join(tmpdir(), "pi-lens-same-bytes-"));
			file = path.join(dir, "same-bytes.ts");
			writeFileSync(file, "debugger;\n");
			resetDegradationLedger();
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("keeps the record, notes nothing resolved, and consumes no write order", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: false,
					sha256: recorded.sha256,
				}),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			// Other bytes are not the record's: a later clean write still clears.
			expect(
				runtime.clearInlineBlockers(file, 3, undefined, {
					authored: false,
					sha256: "b".repeat(64),
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});

		// The refusal's observability: one ledger entry per file key, counted, so
		// a script that keeps touching a blocked file does not write a row per run.
		it("counts repeated refusals on one ledger entry per file, not one per occurrence", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			for (const writeIndex of [2, 3, 4]) {
				expect(
					runtime.clearInlineBlockers(file, writeIndex, undefined, {
						authored: false,
						sha256: recorded.sha256,
					}),
				).toBe(false);
			}
			const group = getDegradationSummary().find(
				(candidate) => candidate.kind === "blocker-clear-refused",
			);
			expect(group?.count).toBe(3);
			expect(group?.latestReasons).toEqual([
				{
					subject: normalizeMapKey(file),
					reason: expect.stringContaining("(count: 3)"),
				},
			]);
			// Nothing is counted when the clear is not refused.
			runtime.clearInlineBlockers(file, 5, undefined, {
				authored: false,
				sha256: "b".repeat(64),
			});
			expect(
				getDegradationSummary().find((c) => c.kind === "blocker-clear-refused")
					?.count,
			).toBe(3);
		});

		it("clears a record that carries no content baseline, as before", () => {
			// #2982: a dispatch that could not fingerprint the file (unreadable, or
			// over the baseline cap) records no hash, so nothing can match it.
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(file, "🔴 STOP L2", 1, ["biome"], [2]);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: false,
					sha256: undefined,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		});

		it("lets an authored clean of the same bytes clear the record", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: true,
					sha256: recorded.sha256,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		});

		// #4484: a blocker is pending until a fresh observation no longer holds
		// it. A clearing run whose own observation still holds one (an opaque
		// recovery of new bytes, whose blocker channel is withheld) left the
		// record cleared and turn end reported a false "Resolved".
		it("refuses a clear while the clearing run still observes a blocker, whatever its authorship (#4484)", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			for (const [writeIndex, authored] of [
				[2, false],
				[3, true],
			] as const) {
				expect(
					runtime.clearInlineBlockers(file, writeIndex, undefined, {
						authored,
						sha256: "b".repeat(64),
						blocking: 1,
					}),
				).toBe(false);
			}
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			expect(
				getDegradationSummary().find((c) => c.kind === "blocker-clear-refused")
					?.latestReasons,
			).toEqual([
				{
					subject: normalizeMapKey(file),
					reason: expect.stringMatching(
						/still observed a blocker.*\(count: 2\)/,
					),
				},
			]);
			// An observation with nothing left clears and reports it resolved.
			expect(
				runtime.clearInlineBlockers(file, 4, undefined, {
					authored: false,
					sha256: "b".repeat(64),
					blocking: 0,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});
	});

	// #4484 round 2: a settled collect-later run is the only observation that
	// may retire what its runner left pending while it was in flight. Without
	// the guards it would retire another runner's blocker, a server's it never
	// heard from, or a verdict about bytes it did not read.
	describe("retireUnobservedRunnerBlockers (#4484 round 2)", () => {
		// A real file: the snapshot drops a record whose file is gone (#1245).
		let dir = "";
		let file = "";
		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "pi-lens-4484-retire-"));
			file = path.join(dir, "carry.ts");
			writeFileSync(file, "BAD_CALL();\n");
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));
		const sha256 = "c".repeat(64);
		const blocker = (
			runnerId: string,
			message: string,
			serverId?: string,
		): Diagnostic => ({
			id: `${runnerId}:${message}`,
			message,
			filePath: file,
			line: 2,
			severity: "error",
			semantic: "blocking",
			tool: runnerId === "lsp" ? "lsp" : runnerId,
			rule: `${runnerId}:rule`,
			runnerId,
			...(serverId !== undefined && { serverId }),
		});
		const record = (runtime: RuntimeCoordinator, diags: Diagnostic[]) =>
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP",
				1,
				undefined,
				[2],
				{ size: 10, sha256 },
				diags,
				undefined,
				1_000,
			);

		it("retires only its own runner's unobserved blockers and keeps an unconfirmed server's", () => {
			const runtime = new RuntimeCoordinator();
			const ts = blocker("lsp", "Cannot find name 'X'.", "typescript");
			const deno = blocker("lsp", "Deno says no.", "deno");
			const lint = blocker("eslint", "no-debugger");
			record(runtime, [ts, deno, lint]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [],
					markedAtMs: 2_000,
					sha256,
					unconfirmedServerIds: ["deno"],
				}),
			).toBe(1);
			expect(runtime.getInlineBlockerDiagnostics(file)).toEqual([deno, lint]);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
		});

		it("keeps a blocker the run still observes, as its observed copy", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			const observed = blocker("lsp", "Cannot  find name 'x'.");
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [observed],
					markedAtMs: 2_000,
					sha256,
				}),
			).toBe(0);
			expect(runtime.getInlineBlockerDiagnostics(file)).toHaveLength(1);
		});

		// #4484 round 3 (R3): the run is about the recorded bytes, so the
		// blocker is still observed only at its own line. Recurrence: another
		// occurrence of the same rule kept a fixed blocker (review F1).
		it("retires a blocker whose identity the run observes only at another line", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [{ ...blocker("lsp", "Cannot find name 'X'."), line: 7 }],
					markedAtMs: 2_000,
					sha256,
				}),
			).toBe(1);
		});

		it("refuses a run about other bytes, or marked before the record's read", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			for (const run of [
				{ markedAtMs: 2_000, sha256: "d".repeat(64) },
				{ markedAtMs: 2_000, sha256: undefined },
				{ markedAtMs: 999, sha256 },
			]) {
				expect(
					runtime.retireUnobservedRunnerBlockers(file, {
						runnerId: "lsp",
						observed: [],
						...run,
					}),
				).toBe(0);
			}
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		});

		it("deletes an emptied record and notes the file resolved", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [],
					markedAtMs: 1_000,
					sha256,
				}),
			).toBe(1);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});
	});

	// #4484 round 3: the anchor follows the record. Recurrence: a new
	// session's first write aligned its recorded lines (none) to a dead
	// session's bytes, or an owed range outlived the session that owed it.
	// Round 4 (G1, G3): the anchor lived in a 256-entry cache apart from the
	// record, so writes to other files evicted a live record's anchor and the
	// next edit retired its blocker with nothing to align (verify probe P18).
	describe("analysis anchor (#4484 rounds 3 to 5)", () => {
		const anchor = {
			lineHashes: Uint32Array.of(1, 2),
			owedRanges: new Map([["ast-grep-napi", [{ start: 2, end: 2 }]]]),
		};

		it("keeps the anchor on the file's record, under any spelling of its path", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/src/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/src/../src/a.ts", anchor);
			expect(runtime.getAnalysisAnchor("/p/src/a.ts")).toBe(anchor);
		});

		it("keeps a record's anchor however many other files take anchors", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			for (let i = 0; i < 300; i += 1)
				runtime.setAnalysisAnchor(`/p/other-${i}.ts`, {
					lineHashes: Uint32Array.of(i),
					owedRanges: new Map(),
				});
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBe(anchor);
		});

		// Round 5 (K2, verify probe P23): only the runner id stayed, so the
		// next write owed it the whole file. The owed lines' texts stay.
		it("drops the hashes with the record and keeps the owed line texts", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			runtime.clearInlineBlockers("/p/a.ts");
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toEqual({
				lineHashes: undefined,
				owedRanges: new Map(),
				owedContent: new Map([["ast-grep-napi", Uint32Array.of(2)]]),
			});
		});

		// Round 5 (K2, verify probe P23): a file with no record kept only the
		// owing runner's id. It keeps its whole anchor now, bounded; an evicted
		// file falls back to owed line texts, never the whole file.
		it("keeps a record-less file's whole anchor while a runner owes lines, then its owed texts", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBe(anchor);
			for (let i = 0; i < MAX_OWED_ANCHORS; i += 1)
				runtime.setAnalysisAnchor(`/p/other-${i}.ts`, anchor);
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toEqual({
				lineHashes: undefined,
				owedRanges: new Map(),
				owedContent: new Map([["ast-grep-napi", Uint32Array.of(2)]]),
			});
			runtime.setAnalysisAnchor("/p/a.ts", {
				lineHashes: Uint32Array.of(1),
				owedRanges: new Map(),
			});
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBeUndefined();
		});

		// Round 5 (K3, verify probe P25): a carry moved a blocker's line but kept
		// its line-bound id, so the settled copy at the same line joined the
		// record beside it and the turn end listed it twice.
		it("merges a settled copy of a carried blocker whose id names its old line", () => {
			const runtime = new RuntimeCoordinator();
			const carried = {
				id: "lsp:2304:2",
				message: "Cannot find name 'BAD_CALL'.",
				filePath: "/p/a.ts",
				line: 4,
				column: 1,
				severity: "error" as const,
				semantic: "blocking" as const,
				tool: "lsp",
				rule: "ts:2304",
			};
			expect(
				runtime.recordDeferredInlineBlockers("/p/a.ts", [carried], {
					recordedAtMs: 1,
				}),
			).toBe(1);
			expect(
				runtime.recordDeferredInlineBlockers(
					"/p/a.ts",
					[
						{ ...carried, id: "lsp:2304:4" },
						{ ...carried, line: 5, id: "lsp:2304:5" },
					],
					{ recordedAtMs: 2 },
				),
			).toBe(1);
			expect(runtime.getInlineBlockerDiagnostics("/p/a.ts")).toHaveLength(2);
		});

		it("drops every anchor and owing runner at a session reset", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			runtime.setAnalysisAnchor("/p/b.ts", anchor);
			runtime.resetForSession();
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBeUndefined();
			expect(runtime.getAnalysisAnchor("/p/b.ts")).toBeUndefined();
		});
	});

	describe("inline blockers reconcile against disk (#1245)", () => {
		it("drops a blocker whose file no longer exists from the snapshot", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-reconcile-"),
			);
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("drops a stale blocker for a mixed-case filename too (#1245 Windows key trap)", () => {
			// `normalizeMapKey` realpaths a live file (canonical case) but
			// lowercases the tail of a deleted one, so a delete-in-place
			// reconcile missed `MyCase.ts` on Windows — the reconcile must not
			// depend on delete-time key normalization matching set-time.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-case-"));
			const file = path.join(dir, "MyCase.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps a blocker whose file still exists", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-keep-"));
			const file = path.join(dir, "stays.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				expect(runtime.getInlineBlockersSnapshot()[0].summary).toBe(
					"blocker A",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps re-serving a blocker whose CAUSE was fixed in another file (#1561)", () => {
			// The live incident: 3 blockers land on a test file, the signature that
			// caused them is fixed in the provider it imports, and the provider —
			// not the test file — is what gets re-dispatched. Neither existing
			// invalidation path (re-dispatch of the SAME path, #1245's existence
			// check) covers that, so the verdict is never re-taken.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-crossfile-"),
			);
			const testFile = path.join(dir, "provider.test.ts");
			const provider = path.join(dir, "provider.ts");
			writeFileSync(testFile, "import './provider.ts';\n");
			writeFileSync(provider, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(testFile, "🔴 STOP L320", 1, ["lsp"]);
				// The fix: the PROVIDER re-dispatches clean. Its own entry clears…
				runtime.clearInlineBlockers(provider);
				// …and the test file's stale verdict is still there, by design.
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				// A fresh, confirmed-clean view of the test file must retire it.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(testFile, 2, ["lsp"]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("#1561 F1: refuses to retire a source the verdict did not cover", () => {
			// Inline blockers span every runner, not just the language server —
			// `dispatcher.ts` filters `semantic === "blocking"` across all of them.
			// An LSP-only clean must not clear an ast-grep security rule.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-source-"));
			const file = path.join(dir, "app.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "🔴 STOP cors-wildcard", 1, [
					"ast-grep",
				]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				// Partial coverage is not coverage.
				runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp", "eslint"]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, [
						"lsp",
						"ast-grep",
					]),
				).toBe(false);

				// Full coverage does retire.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, [
						"lsp",
						"eslint",
					]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("#1561 F1: a record with unknown provenance fails closed", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-unknown-"));
			const file = path.join(dir, "app.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				// No sources recorded — "we don't know what raised this" must not
				// resolve to "an LSP check can clear it".
				runtime.recordInlineBlockers(file, "🔴 STOP", 1);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not let an older confirmed clean erase a newer blocker (#1198 inv. 1-2)", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-order-"));
			const file = path.join(dir, "raced.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				// A clean check that STARTED at token 4 settles after a dispatch at
				// token 7 found real blockers. The slow old answer must lose.
				runtime.recordInlineBlockers(file, "🔴 STOP", 7, ["lsp"]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 4, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				// Equal tokens are the same observation, not a newer one.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 7, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				// Strictly newer retires.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 8, ["lsp"]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("reports no retire for a path that has no blocker", () => {
			const runtime = new RuntimeCoordinator();
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					path.resolve("never/recorded.ts"),
					9,
				),
			).toBe(false);
		});

		it("releases the git guard once the blocker is retired (#1561)", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-retire-guard-"),
			);
			const file = path.join(dir, "gated.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(true);

				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(true);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("no longer counts a deleted file's blocker toward the git guard", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-guard-"));
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(true);

				rmSync(file);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
