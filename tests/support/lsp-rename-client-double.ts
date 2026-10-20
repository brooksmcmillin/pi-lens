/**
 * Shared `willRenameFiles` client fixture for LSP rename tests.
 *
 * `LSPService.renameFile` asks every live client for its
 * `workspace/willRenameFiles` edit before it renames anything, so a test that
 * drives a real `LSPService` rename (and the importer rewrite that follows)
 * needs a client whose answer it controls and whose notifications it can
 * assert. `addRenameClient` registers such a client in the service's real
 * client map, keyed exactly as production keys it
 * (`<serverId>:<normalizeMapKey(root)>`), so the rename walks the same lookup
 * the real service does.
 *
 * Extracted from `tests/clients/lsp/service-rename-file.test.ts` (#4578) so the
 * tool-level rename-destination tests reuse one fixture instead of growing a
 * second copy that drifts the next time a client member is added. Lives in
 * `tests/support/` because that is the sanctioned home for shared fixtures: a
 * `vi.fn()` client is a service double, and this keeps the double in one
 * place rather than in every `.test.ts` that needs a rename answer.
 */

import { vi } from "vitest";
import { LSPService } from "../../clients/lsp/index.js";
import type { RenameTrackedSend } from "../../clients/lsp/edits.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

export type RenameClientDouble = {
	root: string;
	isAlive: ReturnType<typeof vi.fn>;
	isDocumentOpen: ReturnType<typeof vi.fn>;
	getDocumentUri: ReturnType<typeof vi.fn>;
	closeDocument: ReturnType<typeof vi.fn>;
	notify: {
		open: ReturnType<typeof vi.fn>;
		watchedFileChange: ReturnType<typeof vi.fn>;
	};
	willRenameFiles: ReturnType<typeof vi.fn>;
	getOperationSupport: ReturnType<typeof vi.fn>;
	getMalformedFileOperationRegistrations: ReturnType<typeof vi.fn>;
	didRenameFiles: ReturnType<typeof vi.fn>;
	/** The document's last send, as `LSPService.getTrackedContent` reads it; a
	 *  client built without one holds no record (#3601), so its files are
	 *  judged by the unopened rule. */
	getSentContent: ReturnType<typeof vi.fn>;
};

/**
 * A client that reports `willRenameFiles` support and answers every rename
 * request with `edit` (a `WorkspaceEdit`, or `null` for "no edits").
 *
 * `sent` is the send record this client holds for a path, if any. It is an
 * explicit argument rather than a disk read: a double that always reports the
 * current bytes would make every staleness check pass.
 */
export function makeRenameClient(
	root: string,
	edit: unknown,
	sent?: (filePath: string) => RenameTrackedSend | undefined,
): RenameClientDouble {
	return {
		root,
		isAlive: vi.fn(() => true),
		isDocumentOpen: vi.fn(() => false),
		getDocumentUri: vi.fn(() => undefined),
		closeDocument: vi.fn(async () => undefined),
		notify: { open: vi.fn(async () => undefined), watchedFileChange: vi.fn() },
		willRenameFiles: vi.fn(async () => edit),
		getOperationSupport: vi.fn(() => ({
			willRenameFiles: true,
			didRenameFiles: true,
		})),
		getMalformedFileOperationRegistrations: vi.fn(() => new Set()),
		didRenameFiles: vi.fn(async () => undefined),
		getSentContent: vi.fn((filePath: string) => sent?.(filePath)),
	};
}

/** Register `client` in `service`'s live client map under `serverId`/`root`. */
export function addRenameClient(
	service: LSPService,
	serverId: string,
	root: string,
	client: RenameClientDouble,
): void {
	const state = (
		service as unknown as { state: { clients: Map<string, unknown> } }
	).state;
	state.clients.set(`${serverId}:${normalizeMapKey(root)}`, client);
}
