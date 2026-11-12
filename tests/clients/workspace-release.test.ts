import { createEventBus } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import {
	registerWorkspaceRelease,
	type WorkspaceReleaseRequest,
} from "../../clients/workspace-release.js";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	resetLSPService();
});

function owner() {
	const events = createEventBus();
	const shutdown = registerWorkspaceRelease({ events });
	disposers.push(shutdown);
	return { events, shutdown };
}

// Recurrence: a shell cleanup cannot await extension-owned LSP shutdown by itself.
it("acknowledges an in-process release and detaches when its runtime shuts down", async () => {
	const host = owner();
	const request: WorkspaceReleaseRequest = {
		root: path.join(process.cwd(), "worktree-fixture"),
		pending: [],
	};
	host.events.emit("pilens:workspace:release", request);
	expect(request.pending).toHaveLength(1);
	await expect(Promise.all(request.pending)).resolves.toEqual([[]]);
	expect(getLSPService().checkDestroyed()).toBe(false);
	host.shutdown();
	request.pending = [];
	host.events.emit("pilens:workspace:release", request);
	expect(request.pending).toEqual([]);
});

it("refuses the Pi cwd and relative paths without claiming release", async () => {
	const host = owner();
	for (const root of [process.cwd(), ".", "relative-worktree"]) {
		const request: WorkspaceReleaseRequest = { root, pending: [] };
		host.events.emit("pilens:workspace:release", request);
		await expect(Promise.all(request.pending)).rejects.toThrow(
			/cwd|absolute path/,
		);
	}
});
