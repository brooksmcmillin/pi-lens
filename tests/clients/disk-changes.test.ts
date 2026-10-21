/**
 * #4535 slice 1: the disk-change publisher. One record, the EXISTING project
 * sequence, and a subscriber registry the consumers join instead of each
 * detector wiring them by name.
 *
 * These cases drive the real publisher against a real `RuntimeCoordinator`
 * (the real change-log sink) and read the real `latency.log` and degradation
 * ledger back; nothing here mocks a seam that decides state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	DISK_CHANGE_MAX_RECORDED_PATHS,
	type DiskChange,
	diskChangeSubscriberIds,
	publishDiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	flushLatencyLog,
	getRecentLoggedPhases,
} from "../../clients/latency-logger.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const cleanups: Array<() => void> = [];
let tmp: string;
let runtime: RuntimeCoordinator;

function subscribe(id: string, handler: (change: DiskChange) => unknown): void {
	cleanups.push(subscribeDiskChange(id, handler));
}

function changeLogLines(root: string = tmp): Array<{
	seq: number;
	source: string;
	filePath: string;
	fileSeq: number;
}> {
	const logPath = getProjectChangeLogPath(root);
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disk-change-"));
	fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmp;
	resetDegradationLedger();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the disk-change subscriber registry", () => {
	it("registers once per consumer id and unsubscribes without disturbing siblings", async () => {
		const first: DiskChange[] = [];
		const second: DiskChange[] = [];
		subscribe("registry-a", (change) => {
			first.push(change);
		});
		subscribe("registry-a", (change) => {
			second.push(change);
		});
		expect(
			diskChangeSubscriberIds().filter((id) => id === "registry-a"),
		).toHaveLength(1);
		await publishDiskChange({ root: tmp, origin: "out-of-band", paths: [] });
		// The second registration replaced the first: one delivery per publish.
		expect(first).toHaveLength(0);
		expect(second).toHaveLength(1);
	});
});

describe("publishDiskChange — the existing sequence, allocated before fan-out", () => {
	it("allocates one seq per recorded path on the existing writer, before any subscriber runs", async () => {
		const a = path.join(tmp, "src", "a.ts");
		const b = path.join(tmp, "src", "b.ts");
		const seen: Array<{ seq: number; lines: number; paths: unknown }> = [];
		subscribe("observes-order", (change) => {
			seen.push({
				seq: change.seq,
				lines: changeLogLines().length,
				paths: change.paths,
			});
		});
		const { change } = await publishDiskChange(
			{
				root: tmp,
				origin: "out-of-band",
				sources: ["declarations"],
				paths: [a, b],
			},
			runtime,
		);
		// I2: the sequence and the durable log are already written when the
		// first subscriber runs, and the record's seq is the batch's last.
		expect(seen).toEqual([
			{ seq: 2, lines: 2, paths: [normalizeMapKey(a), normalizeMapKey(b)] },
		]);
		expect(change.seq).toBe(2);
		expect(change.fileSeqs.get(normalizeMapKey(a))).toBe(1);
		expect(change.fileSeqs.get(normalizeMapKey(b))).toBe(1);
		// source: "external" — the change was not pi-lens-authored.
		expect(changeLogLines().map((line) => line.source)).toEqual([
			"external",
			"external",
		]);
		expect(change.sessionScopeId).toBe(runtime.sessionGeneration);
		expect(change.kind).toBe("inferred");
	});

	it("reports an unenumerable change with no sequence and no log entry", async () => {
		const seen: DiskChange[] = [];
		subscribe("observes-unknown", (change) => {
			seen.push(change);
		});
		const { change } = await publishDiskChange(
			{
				root: tmp,
				origin: "out-of-band",
				sources: ["install"],
				paths: "unknown",
			},
			runtime,
		);
		expect(change.paths).toBe("unknown");
		expect(change.seq).toBe(0);
		expect(change.fileSeqs.size).toBe(0);
		expect(changeLogLines()).toEqual([]);
		expect(seen).toHaveLength(1);
	});

	it("bounds the recorded population and says so, instead of reading the tail as unchanged", async () => {
		const paths = Array.from(
			{ length: DISK_CHANGE_MAX_RECORDED_PATHS + 36 },
			(_, index) => path.join(tmp, "src", `f${index}.ts`),
		);
		const seen: DiskChange[] = [];
		subscribe("observes-truncation", (change) => {
			seen.push(change);
		});
		await publishDiskChange({ root: tmp, origin: "head-move", paths }, runtime);
		expect(changeLogLines()).toHaveLength(DISK_CHANGE_MAX_RECORDED_PATHS);
		expect(seen[0].seq).toBe(DISK_CHANGE_MAX_RECORDED_PATHS);
		expect(seen[0].paths).toBe("unknown");
		const records = getDegradationSummary().filter(
			(group) => group.kind === "disk-change-paths-truncated",
		);
		expect(records).toHaveLength(1);
		expect(records[0].latestReasons[0].subject).toBe(normalizeMapKey(tmp));
	});

	it("caps the population in the detector's spelling, before normalizing it", async () => {
		// Two spellings of each of 33 files: 66 named paths, 33 normalized keys.
		// The cap counts what the detector named (that is the normalization work
		// the cap exists to bound), so the population is over it even though the
		// normalized set is not — the conservative direction.
		const paths: string[] = [];
		for (let index = 0; index < 33; index += 1) {
			const filePath = path.join(tmp, "src", `f${index}.ts`);
			fs.writeFileSync(filePath, "");
			paths.push(
				filePath,
				`${path.join(tmp, "src")}${path.sep}.${path.sep}f${index}.ts`,
			);
		}
		const seen: DiskChange[] = [];
		subscribe("observes-raw-cap", (change) => {
			seen.push(change);
		});
		await publishDiskChange({ root: tmp, origin: "head-move", paths }, runtime);
		// The first 64 spellings are 32 files, so 32 sequences are allocated.
		expect(changeLogLines()).toHaveLength(32);
		expect(seen[0].seq).toBe(32);
		expect(seen[0].paths).toBe("unknown");
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-paths-truncated",
			),
		).toHaveLength(1);
	});

	it("records one bounded append failure instead of publishing an unlogged sequence", async () => {
		const root = path.join(tmp, "broken-log");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const logPath = getProjectChangeLogPath(root);
		fs.mkdirSync(path.dirname(path.dirname(logPath)), { recursive: true });
		// The change log's own directory is a file: every append fails.
		fs.writeFileSync(path.dirname(logPath), "not a directory");
		const coordinator = new RuntimeCoordinator();
		coordinator.projectRoot = root;
		const seen: Array<{ seq: number; lines: number }> = [];
		subscribe("observes-append-failure", (change) => {
			seen.push({ seq: change.seq, lines: changeLogLines(root).length });
		});
		let callerCallbacks = 0;
		const recorded = () =>
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-append-failed",
			);
		await publishDiskChange(
			{
				root,
				origin: "out-of-band",
				paths: [path.join(root, "src", "a.ts")],
			},
			coordinator,
			() => {
				callerCallbacks += 1;
			},
		);
		// The subscriber still hears the publish; the log holds nothing, and the
		// publisher says so once rather than swallowing it.
		expect(seen).toEqual([{ seq: 1, lines: 0 }]);
		expect(callerCallbacks).toBe(1);
		expect(recorded()).toHaveLength(1);
		expect(recorded()[0].count).toBe(1);
		expect(recorded()[0].latestReasons[0].subject).toBe(normalizeMapKey(root));
		await publishDiskChange(
			{
				root,
				origin: "out-of-band",
				paths: [path.join(root, "src", "b.ts")],
			},
			coordinator,
		);
		// Bounded: one row per root per session, the count carries the repeat.
		expect(recorded()).toHaveLength(1);
		expect(recorded()[0].count).toBe(2);
	});
});

describe("publishDiskChange — bounded, isolated observability", () => {
	it("isolates a throwing subscriber, still reaches the next one, and records once per consumer per session", async () => {
		const delivered: DiskChange[] = [];
		subscribe("throws-sync", () => {
			throw new Error("sync boom");
		});
		subscribe("rejects-async", async () => {
			throw new Error("async boom");
		});
		subscribe("healthy", (change) => {
			delivered.push(change);
		});
		const first = await publishDiskChange({
			root: tmp,
			origin: "out-of-band",
			paths: [path.join(tmp, "src", "a.ts")],
		});
		// The publish answered and the healthy consumer was reached.
		expect(first.change.seq).toBe(0);
		expect(delivered).toHaveLength(1);
		await publishDiskChange({
			root: tmp,
			origin: "out-of-band",
			paths: [path.join(tmp, "src", "b.ts")],
		});
		const failures = getDegradationSummary().filter(
			(group) => group.kind === "disk-change-subscriber-failed",
		);
		// Once per consumer per root: two publishes, two broken consumers, two
		// rows — not four.
		expect(failures).toHaveLength(1);
		expect(failures[0].count).toBe(2);
		expect(
			failures[0].latestReasons
				.map((entry) => entry.subject)
				.sort((a, b) => a.localeCompare(b)),
		).toEqual([
			`rejects-async:${normalizeMapKey(tmp)}`,
			`throws-sync:${normalizeMapKey(tmp)}`,
		]);
	});

	it("writes one bounded publish row to the latency sink's phase record", async () => {
		subscribe("noop", () => undefined);
		await publishDiskChange(
			{
				root: tmp,
				origin: "out-of-band",
				sources: ["declarations"],
				paths: [path.join(tmp, "src", "a.ts")],
			},
			runtime,
		);
		// A vitest process suppresses the `latency.log` write itself
		// (`logLatency` returns early under `PI_LENS_TEST_MODE`), so the row is
		// read back through the logger's own phase record — the same record the
		// field reads in production.
		await flushLatencyLog();
		const row = getRecentLoggedPhases().find(
			(entry) => entry.phase === "disk_change_published",
		)?.metadata;
		expect(row).toMatchObject({
			origin: "out-of-band",
			sources: "declarations",
			kind: "inferred",
			recorded: 1,
			unknown: 0,
			truncated: 0,
			seq: 1,
		});
		expect(String(row?.subscribers)).toContain("noop");
	});
});
