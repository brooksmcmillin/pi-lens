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
	type DiskChange,
	DISK_CHANGE_MAX_RECORDED_PATHS,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../clients/lsp/service-singleton.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceFileCreatedAtFor,
} from "../../clients/lsp/workspace-diagnostics-session.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

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

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disk-change-subs-"));
	fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmp;
	resetDegradationLedger();
	resetWorkspaceDiagnosticsCacheSession(0);
	calls = { restartRoots: [], notified: [] };
	// Drop the previous case's service, then install this case's recorder
	// through the same lifecycle seam the host uses.
	resetLSPService();
	const service = makeLspServiceDouble({
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
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
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
