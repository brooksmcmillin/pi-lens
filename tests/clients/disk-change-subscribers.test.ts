/**
 * #4535 slice 1, review round 2 (#4562): the two consumers of a published disk
 * change, driven through the real detector, the real publisher, the real
 * diagnostics-cache clock and the real `peekLSPService` seam.
 *
 * Two regressions this file pins, both at the one place slice 1 changed
 * behaviour without a witness — what a `DiskChange` means to its subscribers:
 *
 * 1. A publish over `DISK_CHANGE_MAX_RECORDED_PATHS` reports `paths:
 *    "unknown"`. Read as "nothing changed", that dropped the diagnostics
 *    cache's refusal entirely: 70 changed declarations recorded NOTHING, where
 *    the pre-#4535 detector recorded all 70 (catalog shape 10 — a bounded
 *    degradation is conservative for every consumer, never a false clean).
 * 2. One look can hold both an install and declaration changes. The pre-#4535
 *    detector restarted the root's clients AND sent the exact-URI events, so a
 *    subscriber that returns after the restart drops the only cue a live client
 *    of the same server outside the restarted root ever gets.
 *
 * The language server is the host boundary: a service double from the shared
 * factory records what the subscriber asked it to do. Everything else is real
 * (the declaration walk, the install stamp, the publisher, the change log, the
 * cache clock, the degradation ledger).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	BASH_RECOVERY_DRIFT_SOURCE,
	BASH_WRITE_SOURCE,
	ensureDiskChangeSubscribers,
	LSP_CONSUMER,
	type HeldDocumentsAnswer,
} from "../../clients/disk-change-subscribers.js";
import {
	type DiskChange,
	DISK_CHANGE_MAX_RECORDED_PATHS,
	DISK_CHANGE_ORIGINS,
	publishDiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceFileCreatedAtFor,
} from "../../clients/lsp/workspace-diagnostics-session.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

interface ServiceCalls {
	restartRoots: string[];
	notified: Array<{ filePath: string; type: number }>;
}

let tmp: string;
let calls: ServiceCalls;
let runtime: RuntimeCoordinator;
const cleanups: Array<() => void> = [];

/** The diagnostics cache's own read of the "a file changed on disk" record. */
function cacheRefusedAt(): number {
	return workspaceFileCreatedAtFor(
		() => true,
		() => true,
	);
}

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("r2-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disk-change-subs-"));
	fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmp;
	resetDegradationLedger();
	resetWorkspaceDiagnosticsCacheSession(0);
	calls = { restartRoots: [], notified: [] };
	// Drop the previous case's service, then install this case's recorder
	// through the same lifecycle seam the host uses.
	await installLspServiceDouble({
		restartPrimaryClientsUnder: async (root: string) => {
			calls.restartRoots.push(root);
			return [`primary:${root}`];
		},
		notifyOutOfBandFileChanges: (
			events: ReadonlyArray<{ filePath: string; type: number }>,
		) => {
			calls.notified.push(...events);
		},
	});
	// The look reads the LIVE service through `peekLSPService`, so the double has
	// to exist before it runs — the same eager call the hand-rolled install made.
	getLSPService();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	resetLSPService();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a publish over the recorded cap still refuses the diagnostics cache", () => {
	it("refuses every entry scanned before the publish when the population is unknown", async () => {
		const root = path.join(tmp, "declarations");
		const declarations = path.join(root, "types");
		fs.mkdirSync(declarations, { recursive: true });
		const files = Array.from(
			{ length: DISK_CHANGE_MAX_RECORDED_PATHS + 6 },
			(_, index) => path.join(declarations, `d${index}.d.ts`),
		);
		for (const filePath of files)
			fs.writeFileSync(filePath, "export declare const x: number;\n");
		const coordinator = new RuntimeCoordinator();
		coordinator.projectRoot = root;
		// The first look seeds the per-root record and changes nothing.
		await lookForOutOfBandChanges(root, "tool_result", coordinator);
		for (const filePath of files)
			fs.writeFileSync(filePath, "export declare const x: string;\n");
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result", coordinator);

		expect(seen).toHaveLength(1);
		// The recorded population really is over the cap ...
		expect(seen[0].paths).toBe("unknown");
		expect(seen[0].pathChanges).toHaveLength(files.length);
		// ... and the cache refuses at least as much as the full list did: the
		// pre-#4535 detector called `noteWorkspaceFilesChangedOnDisk` with all
		// 70. On the reviewed head this read 0.
		expect(cacheRefusedAt()).toBe(seen[0].at);
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-paths-truncated",
			),
		).toHaveLength(1);
	});
});

describe("one look that holds an install and declaration changes", () => {
	async function installAndDeclarationLook(): Promise<DiskChange> {
		fs.writeFileSync(path.join(tmp, "pnpm-lock.yaml"), "v: 1\n");
		const declaration = path.join(tmp, "types", "globals.d.ts");
		fs.mkdirSync(path.dirname(declaration), { recursive: true });
		fs.writeFileSync(declaration, "declare const G: number;\n");
		// Seed the record, then make both changes between two looks: an install
		// stamp and an edited declaration file, in ONE publish.
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(path.join(tmp, "pnpm-lock.yaml"), "v: 2\n");
		fs.writeFileSync(declaration, "declare const G: string;\n");
		const seen = recordPublishes();
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		expect(seen).toHaveLength(1);
		expect(seen[0].sources).toEqual(["install", "declarations"]);
		return seen[0];
	}

	it("restarts the root and still sends the exact-URI declaration events", async () => {
		const change = await installAndDeclarationLook();
		const declaration = path.join(tmp, "types", "globals.d.ts");
		expect(calls.restartRoots).toEqual([normalizeMapKey(tmp)]);
		// The pre-#4535 detector ran the notification half too; on the reviewed
		// head this array was empty.
		expect(calls.notified).toEqual([{ filePath: declaration, type: 2 }]);
		expect(cacheRefusedAt()).toBe(change.at);
	});

	it("restarts once and sends no event when the look saw only the install", async () => {
		fs.writeFileSync(path.join(tmp, "pnpm-lock.yaml"), "v: 1\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(path.join(tmp, "pnpm-lock.yaml"), "v: 2\n");
		const seen = recordPublishes();
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		expect(seen[0].sources).toEqual(["install"]);
		expect(calls.restartRoots).toHaveLength(1);
		expect(calls.notified).toEqual([]);
		expect(cacheRefusedAt()).toBe(seen[0].at);
	});

	it("sends the declaration events and restarts nothing when the look saw no install", async () => {
		const declaration = path.join(tmp, "types", "globals.d.ts");
		fs.mkdirSync(path.dirname(declaration), { recursive: true });
		fs.writeFileSync(declaration, "declare const G: number;\n");
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		fs.writeFileSync(declaration, "declare const G: string;\n");
		const seen = recordPublishes();
		await lookForOutOfBandChanges(tmp, "tool_result", runtime);
		expect(seen[0].sources).toEqual(["declarations"]);
		expect(calls.restartRoots).toEqual([]);
		expect(calls.notified).toEqual([{ filePath: declaration, type: 2 }]);
	});
});

/**
 * #4742 / #4535 slice 3b. Recurrence: the held-document phase resynced only
 * what a server held, so a module changed on disk that no server had open
 * (pyright had read it for an importer) kept its old bytes for the server's
 * life. The service is the host boundary here: a recorder of what the
 * subscriber asked it to do, in order. Everything above it is real (the
 * publisher, the subscriber, the disk, the degradation ledger).
 */
describe("the LSP consumer sends a publish's unheld paths as watched-files events (#4742)", () => {
	let order: string[];
	let held: string[];
	let notifyThrows: boolean;
	let resynced: string[][];
	let announced: string[];

	beforeEach(async () => {
		order = [];
		held = [];
		notifyThrows = false;
		resynced = [];
		announced = [];
		await installLspServiceDouble({
			getOpenDocumentPaths: () => held,
			getTrackedContent: () => undefined,
			notifyOutOfBandFileChanges: (
				events: ReadonlyArray<{ filePath: string; type: number }>,
			) => {
				order.push("notify");
				if (notifyThrows) throw new Error("service refused the events");
				calls.notified.push(...events);
			},
			announceCreatedFiles: (paths: readonly string[]) => {
				order.push("announce");
				announced.push(...paths);
			},
			resyncHeldPrimaries: async (paths: readonly string[]) => {
				order.push("primary");
				return { sent: paths.length, drained: true };
			},
			resyncGitChangedFiles: async (paths: readonly string[]) => {
				resynced.push([...paths]);
				return new Map();
			},
		});
		getLSPService();
		ensureDiskChangeSubscribers();
	});

	function write(name: string, content: string): string {
		const filePath = path.join(tmp, "src", name);
		fs.writeFileSync(filePath, content);
		return normalizeMapKey(filePath);
	}

	async function publish(
		origin: DiskChange["origin"],
		sources: string[],
		paths: readonly string[] | "unknown",
	): Promise<HeldDocumentsAnswer> {
		const { results } = await publishDiskChange(
			{ root: tmp, origin, sources, paths },
			undefined,
		);
		return results.get(LSP_CONSUMER) as HeldDocumentsAnswer;
	}

	it("sends a head-move's unheld path as Changed and a gone one as Deleted, before the held document's send", async () => {
		const unheld = write("unheld.py", "X = 1\n");
		const gone = normalizeMapKey(path.join(tmp, "src", "gone.py"));
		const heldPath = write("held.py", "Y = 1\n");
		held = [heldPath];

		const answer = await publish(
			"head-move",
			["head-move"],
			[unheld, gone, heldPath],
		);

		expect(calls.notified).toEqual([
			{ filePath: unheld, type: 2 },
			{ filePath: gone, type: 3 },
		]);
		expect(answer.unheld).toBe(2);
		// A path born inside the move needs Created, not Changed (review r1 F2):
		// the unheld paths are offered to the clients' Created decision, the
		// held one is not.
		expect(announced).toEqual([unheld, gone]);
		// The held path is a document, not an event; the events precede its
		// send so the primary phase's drain probe covers them.
		expect(answer.primary).toBe(1);
		expect(order).toEqual(["notify", "announce", "primary"]);
	});

	it("sends a bash write's unheld path, and sends none for the recovered-drift follow-up", async () => {
		const unheld = write("written.py", "X = 2\n");

		const write1 = await publish(
			"bash-recovery",
			[BASH_WRITE_SOURCE],
			[unheld],
		);
		const drift = await publish(
			"bash-recovery",
			[BASH_RECOVERY_DRIFT_SOURCE],
			[unheld],
		);

		expect(calls.notified).toEqual([{ filePath: unheld, type: 2 }]);
		expect(announced).toEqual([unheld]);
		expect(write1.unheld).toBe(1);
		// The follow-up carries the same population: a second event would be the
		// same bytes sent twice.
		expect(drift.unheld).toBe(0);
		expect(resynced).toEqual([[unheld]]);
	});

	it("sends a settled sweep's unheld path as Changed", async () => {
		const unheld = write("swept.py", "X = 4\n");

		const answer = await publish("settled-sweep", ["settled-sweep"], [unheld]);

		expect(calls.notified).toEqual([{ filePath: unheld, type: 2 }]);
		expect(announced).toEqual([unheld]);
		expect(answer.unheld).toBe(1);
	});

	it("names no path for an unenumerable publish, and still resyncs the held set", async () => {
		const heldPath = write("held.py", "Y = 2\n");
		held = [heldPath];

		const answer = await publish("head-move", ["head-move"], "unknown");

		expect(calls.notified).toEqual([]);
		expect(announced).toEqual([]);
		expect(answer.unheld).toBe(0);
		expect(answer.primary).toBe(1);
		// Nothing was attempted, so nothing failed: a guard that let "unknown"
		// through would be caught by the notify step and leave only this record.
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-unheld-notify-failed",
			),
		).toEqual([]);
	});

	it("records a refused send once per root and still runs the held-document phase", async () => {
		const unheld = write("unheld.py", "X = 3\n");
		const heldPath = write("held.py", "Y = 3\n");
		held = [heldPath];
		notifyThrows = true;

		const first = await publish("head-move", ["head-move"], [unheld, heldPath]);
		const second = await publish(
			"head-move",
			["head-move"],
			[unheld, heldPath],
		);

		expect(first.unheld).toBe(0);
		expect(first.primary).toBe(1);
		expect(first.failed).toBe(false);
		expect(second.primary).toBe(1);
		const rows = getDegradationSummary().filter(
			(group) => group.kind === "disk-change-unheld-notify-failed",
		);
		expect(rows).toHaveLength(1);
	});
});

describe("the diagnostics cache hears every detector", () => {
	// Recurrence: slice 2 filtered to `out-of-band` inside the handler, so a
	// HEAD move, a bash-recovered rewrite and a settled-sweep drift refused only
	// the entries whose own file moved, and the cached finding of an unchanged
	// importer kept serving.
	it.each(DISK_CHANGE_ORIGINS)(
		"refuses the entries that depend on a path a %s publish names",
		async (origin) => {
			ensureDiskChangeSubscribers();
			const changed = path.join(tmp, "src", "changed.ts");
			const key = normalizeMapKey(changed);
			const pathRefusedAt = () =>
				workspaceFileCreatedAtFor(
					() => false,
					() => true,
					(creation) => creation.path === key,
				);
			expect(pathRefusedAt()).toBe(0);

			const { change } = await publishDiskChange({
				root: tmp,
				origin,
				paths: [changed],
			});

			expect(change.paths).toEqual([key]);
			expect(pathRefusedAt()).toBe(change.at);
		},
	);

	it.each(DISK_CHANGE_ORIGINS)(
		"refuses every entry scanned before a %s publish it could not enumerate",
		async (origin) => {
			ensureDiskChangeSubscribers();
			const clock = () =>
				workspaceFileCreatedAtFor(
					() => false,
					() => false,
				);
			expect(clock()).toBe(0);

			const { change } = await publishDiskChange({
				root: tmp,
				origin,
				paths: "unknown",
			});

			expect(clock()).toBe(change.at);
		},
	);
});
