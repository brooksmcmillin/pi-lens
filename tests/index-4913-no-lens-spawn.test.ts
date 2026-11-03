/**
 * #4913 F1: `--no-lens` starts no language server at session start, and the
 * server still starts on the next use after `/lens-toggle` turns the lens on.
 *
 * RECURRENCE THIS FILE PREVENTS. The first #4913 round moved the `no-lens`
 * read to `session_start` but left the session-start warm-ups ahead of it and
 * the two LSP warm gates reading only `no-lsp`, so `pi --no-lens` still spawned
 * a language server before the first tool call (a reviewer's marker-writing
 * fake server printed `spawned=true`).
 *
 * The spawn is read from the REAL child process (`tests/support/
 * marker-lsp-project.ts`). One session does both halves, so the absence at
 * session start is read against a presence the same project produces after
 * the toggle; a second session in the file would not reach the spawn again,
 * because the language-server launch state is process-wide. Warming the
 * dispatch and formatter modules is an import with no child process, so no
 * spawn can show its gate; the `no-lens` gate on those is read from the
 * extension log in the case below.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	BLOCKING_FILE,
	endTurn,
	step,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";
import {
	markerProject,
	spawnedWithin,
	until,
} from "./support/marker-lsp-project.js";

const fixture = piSessionFixture();

/** How many times the session-start LSP module warm has resolved. */
function warmResolvedCount(): number {
	const log = path.join(fixture.root, "home", "extension.log");
	if (!fs.existsSync(log)) return 0;
	return fs
		.readFileSync(log, "utf-8")
		.split("\n")
		.filter((line) => line.includes("LSP warm resolved")).length;
}

it("spawns no server and warms nothing at session start under --no-lens, and a server on the next use after /lens-toggle", async () => {
	const { proj, marker } = markerProject(fixture.root, "spawn-toggled");
	const handle = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: new Map<string, boolean>([
			["no-lsp", false],
			["no-lens", true],
		]),
		responses: [
			step(writeTarget("b.ts", BLOCKING_FILE), "writing"),
			endTurn("done"),
		],
	});
	expect(await spawnedWithin(marker, 4000), "no server at session start").toBe(
		undefined,
	);
	expect(warmResolvedCount(), "no module warm at session start").toBe(0);
	await handle.prompt("/lens-toggle");
	await handle.prompt("edit b.ts");
	expect(handle.errors).toEqual([]);
	expect(
		await spawnedWithin(marker, 20_000),
		"the toggled-on session spawns the server for the file it edits",
	).toBeDefined();
	await handle.dispose();

	// Control for the module-warm record: a session without the flag writes it.
	const control = markerProject(fixture.root, "warm-control");
	await startPiSession({
		root: fixture.root,
		cwd: control.proj,
		flags: new Map<string, boolean>([["no-lsp", false]]),
		responses: [endTurn("done")],
	});
	expect(
		await until(() => warmResolvedCount() > 0, 10_000),
		"control: a session without the flag warms the LSP module at start",
	).toBe(true);
}, 90_000);
