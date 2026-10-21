/**
 * #4535: the two consumers the out-of-band look used to call by hand, now
 * subscribers of the disk-change publisher.
 *
 * Before the publisher, `clients/out-of-band-changes.ts` knew both of them by
 * name: it moved the diagnostics-cache clock, restarted the root's primary
 * clients, recorded the created/edited/deleted paths, and sent the exact-URI
 * watched-files events itself. That fan-out is the repeated part #4535 is
 * about, so the detector now publishes one record and these two subscribe.
 *
 * Order matters and is registration order: the diagnostics cache records the
 * change BEFORE the servers are told about it, so a cache read that a
 * notification triggers cannot miss the refusal it owes.
 *
 * Registration is idempotent per consumer id, so a caller may call
 * {@link ensureDiskChangeSubscribers} on every publish.
 */
import { type DiskChange, subscribeDiskChange } from "./disk-changes.js";
import { peekLSPService } from "./lsp/capabilities.js";
import {
	noteWorkspaceDependenciesChanged,
	noteWorkspaceFilesChangedOnDisk,
} from "./lsp/workspace-diagnostics-session.js";

/**
 * A path's typed change, in the detector's own spelling: the LSP watched-files
 * event is a URI and wants the path as the server's file was named, while
 * `DiskChange.paths` carries the normalized population the cache stores.
 */
export interface DiskPathChangeEvent {
	filePath: string;
	type: "created" | "changed" | "deleted";
}

/** `file.uri`-typed watched-files events: Created=1, Changed=2, Deleted=3. */
const WATCHED_FILE_TYPE: Record<DiskPathChangeEvent["type"], number> = {
	created: 1,
	changed: 2,
	deleted: 3,
};

/**
 * The diagnostics-cache consumer: a dependency install refuses every entry
 * scanned before it, and a changed path (created, edited or deleted on disk,
 * with no client involved) refuses the entries whose dependency scope holds
 * it. Both use the publish's one `at`, so the record's clock and the record's
 * sequence name the same event.
 *
 * A look can hold both, and an unknown population is never read as an empty
 * one: `"unknown"` is either a dependency install (which cannot be enumerated)
 * or a publish over the recorded cap, and in both cases refusing everything
 * scanned before `at` is the only direction that cannot serve a stale entry.
 * Naming the recorded 64 of 70 changed declarations would refuse strictly less
 * than the detector's full list did before #4535 (catalog shape 10).
 */
function diagnosticsCacheSubscriber(change: DiskChange): void {
	if (change.origin !== "out-of-band") return;
	if (change.sources.includes("install") || change.paths === "unknown")
		noteWorkspaceDependenciesChanged(change.at);
	if (change.paths === "unknown") return;
	if (change.paths.length === 0) return;
	noteWorkspaceFilesChangedOnDisk(change.root, change.paths, change.at);
}

/**
 * The LSP consumer: an install restarts the root's live primary clients (a
 * server that registered client watchers re-reads a closed file only on an
 * exact-URI event or a restart), and a declaration file changed outside
 * pi-lens goes out as that exact-URI watched-files event now, not after the
 * debounce window. A look can hold both, and both are delivered: the install
 * restarts the clients of that root, while a live client of the same server
 * outside the restarted root re-reads a closed declaration only on its event
 * (the pre-#4535 detector ran both halves for one look, and so does this).
 * Returns the restart count so the detector's own row keeps reporting it.
 */
async function lspSubscriber(
	change: DiskChange,
): Promise<{ restarted: number }> {
	if (change.origin !== "out-of-band") return { restarted: 0 };
	const service = peekLSPService();
	if (!service) return { restarted: 0 };
	let restarted = 0;
	if (change.sources.includes("install"))
		restarted = (await service.restartPrimaryClientsUnder(change.root)) ?? 0;
	const events = change.pathChanges ?? [];
	if (events.length === 0) return { restarted };
	service.notifyOutOfBandFileChanges(
		events.map((event) => ({
			filePath: event.filePath,
			type: WATCHED_FILE_TYPE[event.type],
		})),
	);
	return { restarted };
}

/** Consumer id of the diagnostics-cache subscriber (census + tests). */
export const DIAGNOSTICS_CACHE_CONSUMER = "diagnostics-cache";
/** Consumer id of the LSP subscriber (census + tests). */
export const LSP_CONSUMER = "lsp";

let registered = false;

/**
 * Register the out-of-band publisher's consumers. Idempotent (the registry
 * replaces one consumer id rather than duplicating it), so every publisher
 * entry point can call it, including the MCP route slices 2 and 3 add.
 */
export function ensureDiskChangeSubscribers(): void {
	if (registered) return;
	registered = true;
	subscribeDiskChange(DIAGNOSTICS_CACHE_CONSUMER, diagnosticsCacheSubscriber);
	subscribeDiskChange(LSP_CONSUMER, lspSubscriber);
}
