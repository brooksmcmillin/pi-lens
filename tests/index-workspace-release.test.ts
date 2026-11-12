import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";

const fixture = piSessionFixture();

// Review recurrence: calling the disposer directly cannot prove index.ts wires it to real shutdown.
it("detaches workspace release when the actual Pi session shuts down", async () => {
	let events: ExtensionAPI["events"] | undefined;
	let pendingAtShutdown: number | undefined;
	const releasedRoot = path.join(fixture.root, "other-worktree");
	const handle = await startPiSession({
		root: fixture.root,
		cwd: path.join(fixture.root, "session", "project"),
		responses: [],
		inlineFactory: async () => {
			const extension = (await import("../index.js")).default;
			return (pi) => {
				events = pi.events;
				const activation = extension(pi);
				pi.on("session_shutdown", async () => {
					const after = {
						root: releasedRoot,
						pending: [] as Promise<string[]>[],
					};
					pi.events.emit("pilens:workspace:release", after);
					pendingAtShutdown = after.pending.length;
					await Promise.all(after.pending);
				});
				return activation;
			};
		},
	});
	const request = {
		root: releasedRoot,
		pending: [] as Promise<string[]>[],
	};
	events!.emit("pilens:workspace:release", request);
	expect(request.pending).toHaveLength(1);
	await Promise.all(request.pending);
	await handle.dispose();
	expect(pendingAtShutdown).toBe(0);
	expect(handle.errors).toEqual([]);
}, 45_000);
