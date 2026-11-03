/**
 * The whole `notify` surface of a hand-built LSP client double.
 *
 * A double that names only the members its own test calls breaks the moment a
 * production route reaches another one: #4926 review F1, where the workspace
 * sweep's call to `announceCreatedFiles` reached `notify.watchedFileChange`
 * and two sweep tests failed with `watchedFileChange is not a function`. The
 * return type maps the client's own `notify` type, so a member added to the
 * client fails the type check here, once, instead of a test at run time. Each
 * member is a `Mock` of the client's signature, so a test can still assert on
 * or re-program it.
 */
import { type Mock, vi } from "vitest";
import type { LSPClientInfo } from "../../clients/lsp/client.js";

type ClientNotify = LSPClientInfo["notify"];

export type ClientNotifyDouble = {
	[K in keyof ClientNotify]-?: Mock<NonNullable<ClientNotify[K]>>;
};

export function makeClientNotifyDouble(
	overrides: Partial<ClientNotifyDouble> = {},
): ClientNotifyDouble {
	return {
		open: vi.fn<ClientNotify["open"]>(async () => undefined),
		change: vi.fn<ClientNotify["change"]>(async () => undefined),
		save: vi.fn<NonNullable<ClientNotify["save"]>>(async () => true),
		watchedFileChange: vi.fn<ClientNotify["watchedFileChange"]>(),
		flushWatched: vi.fn<NonNullable<ClientNotify["flushWatched"]>>(),
		announceCreated: vi.fn<NonNullable<ClientNotify["announceCreated"]>>(),
		...overrides,
	};
}
