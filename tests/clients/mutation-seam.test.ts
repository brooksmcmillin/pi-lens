/**
 * One mutation seam (#2000 phase 1): RuntimeCoordinator.recordProjectMutation
 * is the single bump + attributed-receipt + change-log entry point. These
 * tests pin the seam contract: receipt attribution, getMutationsSince
 * filtering, ring bounding with a dropped-count, session reset, and
 * append-failure isolation. Red-first property for the consolidation: any
 * producer that hand-rolls `bumpFileSeq` + `appendProjectChange` instead of
 * calling the seam records NO receipt, which these assertions detect.
 */
import { describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	releaseGeneration,
	tryAcquireGeneration,
} from "../../clients/generation-lock.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

/** Derive the receipt key exactly as the seam does - never hardcode it. */
const keyOf = (p: string) => normalizeMapKey(path.resolve(p));

function makeRuntime(): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = "/proj";
	return runtime;
}

describe("recordProjectMutations — the bulk form of the same seam (#4535)", () => {
	function makeCwd(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bulk-seam-"));
	}

	function readLines(cwd: string): Array<{
		seq: number;
		source: string;
		filePath: string;
		fileSeq: number;
		unlocked?: true;
	}> {
		const logPath = getProjectChangeLogPath(cwd);
		if (!fs.existsSync(logPath)) return [];
		return fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	}

	it("allocates one seq per path, in one append, on the existing sequence", () => {
		const cwd = makeCwd();
		try {
			const runtime = makeRuntime();
			const paths = ["src/a.ts", "src/b.ts", "src/c.ts"].map((rel) =>
				path.join(cwd, rel),
			);
			const { projectSeq, fileSeqs } = runtime.recordProjectMutations({
				paths,
				source: "external",
				cwd,
			});
			// The same sequence the single writer allocates: no second space.
			expect(projectSeq).toBe(3);
			expect(runtime.getFilesChangedSince(0)).toEqual(
				expect.arrayContaining(paths.map(keyOf)),
			);
			for (const filePath of paths) {
				expect(fileSeqs.get(keyOf(filePath))).toBe(1);
				expect(runtime.getFileSeq(filePath)).toBe(1);
			}
			const lines = readLines(cwd);
			expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
			expect(lines.map((line) => line.source)).toEqual([
				"external",
				"external",
				"external",
			]);
			expect(lines.every((line) => line.unlocked === undefined)).toBe(true);
			// One receipt per path, attributed to the bulk source, and the ring
			// reads them in allocation order.
			const receipts = runtime.getMutationsSince(0);
			expect(receipts.map((receipt) => receipt.seq)).toEqual([1, 2, 3]);
			expect(receipts.map((receipt) => receipt.source)).toEqual([
				"external",
				"external",
				"external",
			]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("continues the single writer's sequence and does not restart the fileSeq", () => {
		const cwd = makeCwd();
		try {
			const runtime = makeRuntime();
			const a = path.join(cwd, "a.ts");
			const b = path.join(cwd, "b.ts");
			runtime.recordProjectMutation({
				filePath: a,
				source: "agent-write",
				cwd,
			});
			const bulk = runtime.recordProjectMutations({
				paths: [a, b],
				source: "external",
				cwd,
			});
			runtime.recordProjectMutation({ filePath: b, source: "agent-edit", cwd });
			expect(bulk.projectSeq).toBe(3);
			// Same bump store: a's second bump is fileSeq 2, b's first is 1 and
			// its agent edit is 2.
			expect(bulk.fileSeqs.get(keyOf(a))).toBe(2);
			expect(bulk.fileSeqs.get(keyOf(b))).toBe(1);
			expect(runtime.getFileSeq(b)).toBe(2);
			expect(readLines(cwd).map((line) => line.seq)).toEqual([1, 2, 3, 4]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("an unavailable lock tags every line unlocked and records ONE degradation for the batch", () => {
		const cwd = makeCwd();
		try {
			const logPath = getProjectChangeLogPath(cwd);
			// Real filesystem fault, no mocks (same shape as the single writer's
			// case): the project data dir is a regular file, so the append's
			// recursive mkdir throws EEXIST for the whole batch.
			const projectDataDir = path.dirname(logPath);
			fs.mkdirSync(path.dirname(projectDataDir), { recursive: true });
			fs.writeFileSync(projectDataDir, "not a directory", "utf8");
			const runtime = makeRuntime();
			const onAppendError = vi.fn();
			const paths = [path.join(cwd, "x.ts"), path.join(cwd, "y.ts")];
			const result = runtime.recordProjectMutations({
				paths,
				source: "external",
				cwd,
				onAppendError,
			});
			// The failure is isolated exactly as the single writer's: receipts
			// survive, the batch still allocates, and the error routes once.
			expect(onAppendError).toHaveBeenCalledTimes(1);
			expect(onAppendError.mock.calls[0][0]).toBeInstanceOf(Error);
			expect(result.projectSeq).toBe(2);
			expect(runtime.getMutationsSince(0)).toHaveLength(2);
			expect(readLines(cwd)).toEqual([]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("the lock-unavailable path tags every appended line unlocked, once, not per line", () => {
		const cwd = makeCwd();
		try {
			const runtime = makeRuntime();
			const paths = [path.join(cwd, "a.ts"), path.join(cwd, "b.ts")];
			const logPath = getProjectChangeLogPath(cwd);
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			resetDegradationLedger();
			// A real hold on the real lock seam: the batch's lease wait runs out,
			// so the production fallback appends the whole batch unlocked.
			const hold = tryAcquireGeneration(`${logPath}.locks`, 5_000);
			expect(hold).toBeDefined();
			try {
				runtime.recordProjectMutations({ paths, source: "external", cwd });
			} finally {
				if (hold) releaseGeneration(hold);
			}
			const lines = readLines(cwd);
			expect(lines.map((line) => line.unlocked)).toEqual([true, true]);
			// ONE record for the batch: the single writer's semantics, not one
			// record per path.
			const failures = getDegradationSummary().filter(
				(group) => group.kind === "change-log-lock-unavailable",
			);
			expect(failures).toHaveLength(1);
			expect(failures[0].count).toBe(1);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("bounds the ring and counts drops for a bulk larger than the cap", () => {
		const runtime = makeRuntime();
		const paths = Array.from({ length: 600 }, (_, index) => `/p/f${index}.ts`);
		runtime.recordProjectMutations({ paths, source: "external" });
		expect(runtime.getMutationsSince(0).length).toBe(512);
		expect(runtime.droppedMutationReceiptCount).toBe(88);
	});

	it("an empty path list touches neither the log nor the sequence", () => {
		const cwd = makeCwd();
		try {
			const runtime = makeRuntime();
			const { projectSeq, fileSeqs } = runtime.recordProjectMutations({
				paths: [],
				source: "external",
				cwd,
			});
			expect(projectSeq).toBe(0);
			expect(fileSeqs.size).toBe(0);
			expect(fs.existsSync(getProjectChangeLogPath(cwd))).toBe(false);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("recordProjectMutation — the one mutation seam", () => {
	it("bumps seq and records an attributed receipt", () => {
		const runtime = makeRuntime();
		const { projectSeq } = runtime.recordProjectMutation({
			filePath: "/proj/src/a.ts",
			source: "agent-edit",
		});
		expect(projectSeq).toBe(1);
		const receipts = runtime.getMutationsSince(0);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].source).toBe("agent-edit");
		expect(receipts[0].seq).toBe(projectSeq);
		expect(receipts[0].turnIndex).toBe(runtime.turnIndex);
		expect(typeof receipts[0].ts).toBe("number");
	});

	it("normalizes receipt paths to the same form getFilesChangedSince uses", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({
			filePath: "/proj/src/./a.ts",
			source: "agent-write",
		});
		const changed = runtime.getFilesChangedSince(0);
		const receipts = runtime.getMutationsSince(0);
		// The receipt key must be derivable from the changed-set key — a
		// consumer joining the two views must not need a third normalizer.
		expect(changed).toContain(receipts[0].filePath);
	});

	it("getMutationsSince filters strictly after seq", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({ filePath: "/p/a.ts", source: "format" });
		const first = runtime.recordProjectMutation({
			filePath: "/p/b.ts",
			source: "autofix",
		}).projectSeq;
		runtime.recordProjectMutation({ filePath: "/p/c.ts", source: "format" });
		const since = runtime.getMutationsSince(first);
		expect(since.map((r) => r.filePath)).toEqual([keyOf("/p/c.ts")]);
	});

	it("ring cap evicts oldest and counts drops — never silently incomplete", () => {
		const runtime = makeRuntime();
		for (let i = 0; i < 600; i++) {
			runtime.recordProjectMutation({
				filePath: `/p/f${i}.ts`,
				source: "agent-write",
			});
		}
		expect(runtime.droppedMutationReceiptCount).toBeGreaterThan(0);
		const receipts = runtime.getMutationsSince(0);
		expect(receipts.length).toBeLessThanOrEqual(512);
		// The OLDEST receipts are what dropped (insertion-order eviction).
		expect(receipts.some((r) => r.filePath === keyOf("/p/f0.ts"))).toBe(false);
		expect(receipts.at(-1)?.filePath).toBe(keyOf("/p/f599.ts"));
	});

	it("clears receipts on resetForSession alongside the seq store", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({ filePath: "/p/a.ts", source: "format" });
		runtime.resetForSession();
		expect(runtime.getMutationsSince(0)).toEqual([]);
		expect(runtime.droppedMutationReceiptCount).toBe(0);
		expect(runtime.getFilesChangedSince(0)).toEqual([]);
	});

	it("change-log append failure is isolated: receipt survives, error routes to callback", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mutation-seam-fail-"),
		);
		try {
			const runtime = makeRuntime();
			const onAppendError = vi.fn();
			// REAL filesystem fault, no mocks: pre-create the project data dir
			// as a regular FILE so the append's recursive mkdir throws EEXIST.
			const logPath = getProjectChangeLogPath(cwd);
			// REAL filesystem fault, no mocks: pre-create the project DATA DIR
			// itself (the slug directory) as a regular FILE, so the append's
			// recursive mkdir throws EEXIST.
			const projectDataDir = path.dirname(logPath);
			fs.mkdirSync(path.dirname(projectDataDir), { recursive: true });
			fs.writeFileSync(projectDataDir, "not a directory", "utf8");
			runtime.recordProjectMutation({
				filePath: "/p/a.ts",
				source: "agent-write",
				cwd,
				onAppendError,
			});
			// The dispatch path must survive AND the failure must be observable.
			expect(runtime.getMutationsSince(0)).toHaveLength(1);
			expect(onAppendError).toHaveBeenCalledTimes(1);
			expect(onAppendError.mock.calls[0][0]).toBeInstanceOf(Error);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("no cwd means no change-log attempt but full receipt bookkeeping", () => {
		const runtime = makeRuntime();
		const { projectSeq, fileSeq } = runtime.recordProjectMutation({
			filePath: "/p/a.ts",
			source: "lsp-edit",
		});
		expect(projectSeq).toBe(1);
		expect(fileSeq).toBe(1);
		expect(runtime.getMutationsSince(0)).toHaveLength(1);
	});

	it("change-log happy path writes the real JSONL sink with matching attribution", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mutation-seam-"),
		);
		try {
			const runtime = makeRuntime();
			const { projectSeq } = runtime.recordProjectMutation({
				filePath: path.join(cwd, "src", "a.ts"),
				source: "agent-edit",
				cwd,
			});
			// Assert against the REAL durable sink (the same bytes a smell
			// analyzer reads), not a logger mock (#1742 direction).
			const logPath = getProjectChangeLogPath(cwd);
			expect(fs.existsSync(logPath)).toBe(true);
			const lines = fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter((l) => l.trim());
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0]) as {
				seq: number;
				source: string;
				filePath: string;
			};
			expect(entry.seq).toBe(projectSeq);
			expect(entry.source).toBe("agent-edit");
			expect(path.resolve(entry.filePath)).toBe(
				path.resolve(path.join(cwd, "src", "a.ts")),
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
