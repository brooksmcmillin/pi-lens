// flake-shape: raw-timer-wait — the marker server is a real child process the extension spawns on its own schedule, so a spawn (or its absence over a bounded window) is joinable only by polling the file it writes.
/**
 * A project whose TypeScript server is a real child process that records its
 * own start (#4913 F1). `serverOverrides.typescript` runs a wrapper that
 * appends to a marker file, then becomes the repo's fake LSP server
 * (`tests/fixtures/fake-lsp-server.mjs`: answers the handshake and exits on
 * stdin EOF or when its parent dies, so nothing outlives a run). A claim about
 * "no language server was started" reads the REAL spawn through the marker,
 * not a pi-lens record of an attempt. No `warmFiles`, so the session-start warm
 * is the dominant-language path.
 *
 * One spawn-observing session per test FILE: the language-server launch state
 * is process-wide, and a later session in the same file does not reach the
 * spawn again.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_LSP_SERVER_PATH } from "./fake-lsp-server.js";

export function markerProject(
	root: string,
	slug: string,
): { proj: string; marker: string } {
	const proj = path.join(root, slug, "proj");
	fs.mkdirSync(path.join(proj, ".pi-lens"), { recursive: true });
	const marker = path.join(root, slug, "spawned.marker");
	const script = path.join(root, slug, "marker-server.mjs");
	fs.writeFileSync(
		script,
		[
			"import fs from 'node:fs';",
			"fs.appendFileSync(process.argv[2], 'spawned\\n');",
			`await import(${JSON.stringify(pathToFileURL(FAKE_LSP_SERVER_PATH).href)});`,
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(proj, "package.json"),
		'{"name":"synthetic-4913-spawn","private":true}\n',
	);
	fs.writeFileSync(
		path.join(proj, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				typescript: { command: [process.execPath, script, marker] },
			},
			disabledServers: ["ast-grep", "zizmor", "typos", "deno", "opengrep"],
		}),
	);
	fs.writeFileSync(path.join(proj, "b.ts"), "export const b = 1;\n");
	return { proj, marker };
}

/** Polls `done` until it holds or `limitMs` pass; true when it held. */
export async function until(
	done: () => boolean,
	limitMs: number,
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < limitMs) {
		if (done()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return done();
}

/** Milliseconds until the marker exists, or undefined after `limitMs`. */
export async function spawnedWithin(
	marker: string,
	limitMs: number,
): Promise<number | undefined> {
	const started = Date.now();
	return (await until(() => fs.existsSync(marker), limitMs))
		? Date.now() - started
		: undefined;
}
