// flake-shape: ungoverned-wait-for — the session-start LSP warm is a fire-and-forget promise inside the loaded extension copy and exposes no awaitable, so vi.waitFor joins the record it writes.
/**
 * The session-start LSP warm reports its outcome once per session (#4316).
 *
 * `scripts/release-qa.mjs` (`lsp-warm-resolved`) passes a candidate only on an
 * `LSP warm resolved` record in the pinned extension log. The record is read
 * from the sink the LOADED copy's own writer queued, in a real pi
 * `AgentSession` (tier 2, `tests/support/pi-session.ts`).
 *
 * The expected literal is the release gate's own constant, so a rename on
 * either side reds this test instead of silently reddening a release (review
 * F8 of #4802).
 *
 * Recurrence this pins: 4.4.2 shipped with the warm dead (#4314) because its
 * only signal was a failure line; a success record emitted per call or per
 * turn would instead bury that signal and grow the log without bound.
 */
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { LSP_WARM_RESOLVED } from "../scripts/release-qa.mjs";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

async function warmMessages(): Promise<string[]> {
	await flushAllNdjsonWriters();
	const read = readNdjsonRows(path.join(fixture.root, "home", "extension.log"));
	expect(read.skipped).toBe(0);
	return read.rows
		.map((row) => row.message)
		.filter(
			(message): message is string =>
				typeof message === "string" && /LSP warm/.test(message),
		);
}

describe("session-start LSP warm record (#4316)", { timeout: 30_000 }, () => {
	it("logs one LSP warm resolved per session start, not per turn, and no failure", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "warm-record", "proj"),
			responses: [fauxText("one"), fauxText("two"), fauxText("three")],
		});
		// `processing`: the warm is a floating promise, so wait for its record.
		await vi.waitFor(async () => {
			expect(await warmMessages()).toContain(LSP_WARM_RESOLVED);
		});
		for (const turn of ["a", "b", "c"]) await handle.prompt(turn);
		expect(await warmMessages()).toEqual([LSP_WARM_RESOLVED]);
		expect(handle.errors).toEqual([]);
	});
});
