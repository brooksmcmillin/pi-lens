/**
 * Vitest globalSetup: fetch every missing tree-sitter grammar wasm ONCE, in
 * parallel, before any worker process spawns.
 *
 * `clients/tree-sitter-client.ts`'s `ensureGrammar()` de-duplicates a fetch only
 * WITHIN one process. Vitest runs worker PROCESSES in parallel, each with its own
 * singleton, so a grammar missing from disk would be fetched by every worker
 * that needs it, at the same moment, from the same CDN URL. Fetching here, once,
 * before any worker exists, removes that race.
 *
 * The set is `GRAMMARS` from `scripts/download-grammars.ts` (the download list),
 * not a hand list. Earlier revisions prewarmed only `CORE` and left the long tail
 * to a lazy fetch inside the test. Under a cold cache with a stalled CDN that cost
 * 20 files their 5 s test timeouts (#4342). `npm run prepare` downloads only the
 * 12 CORE files, so every CI job starts with the other 14 missing and fetches
 * them here.
 *
 * A grammar counts as present when any directory the runtime loads grammars from
 * holds it (`TreeSitterClient.grammarSourceDirs`), not only the repo's
 * `grammars/`: a lane worktree has no `grammars/`, while the shared install's
 * `node_modules/web-tree-sitter/grammars` already holds most of the set.
 *
 * Each fetch carries a stall bound (`GRAMMAR_STALL_MS` with no bytes), not a
 * wall-clock limit, so a slow link that keeps delivering completes; a retryable
 * failure (a stall, a reset, offline, 5xx, 429) gets one more attempt. A grammar
 * still missing after that fails the run under CI and warns once locally, naming
 * every such grammar, so offline machines and network-less sandboxes can still
 * run the suite (the state table is in PR #4410, round 3).
 *
 * Measured by calling `setup()` directly in a private copy of the tree, Linux,
 * network up, 3 runs each (cold = no grammar in any runtime directory; warm =
 * every file present):
 *   CORE only (12 files, master):  cold 1039 / 908 / 1442 ms;  warm 0.2 / 0.2 / 0.2 ms
 *   GRAMMARS  (26 files, this):    cold 458 / 531 / 417 ms;    warm 1.5 / 1.6 / 1.6 ms
 * Importing `tree-sitter-client.js` adds about 30 ms once per run (52 to 66 ms
 * against 26 to 28 ms for master's two imports).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	downloadGrammarDetailed,
	GRAMMAR_STALL_MS,
} from "../../clients/grammar-source.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { GRAMMARS } from "../../scripts/download-grammars.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const grammarsDir = path.join(repoRoot, "grammars");

export interface PrefetchOptions {
	grammars: readonly string[];
	/** Every directory the runtime loads grammars from. */
	searchDirs: readonly string[];
	/** Where a missing grammar is written. */
	destDir: string;
	/** Under CI a grammar that cannot be fetched stops the run. */
	ci: boolean;
	stallMs: number;
	log: (line: string) => void;
}

/** `undefined` once the file is on disk, else why it is not. */
async function fetchWithOneRetry(
	destDir: string,
	filename: string,
	stallMs: number,
): Promise<string | undefined> {
	let result = await downloadGrammarDetailed(destDir, filename, { stallMs });
	if (!result.ok && result.retryable) {
		result = await downloadGrammarDetailed(destDir, filename, { stallMs });
	}
	if (result.ok) return undefined;
	if (!result.retryable) return "the CDN answered 404 or 410";
	return `${result.reason ?? "download failed"} (2 attempts)`;
}

export async function prefetchGrammars(opts: PrefetchOptions): Promise<void> {
	const missing = opts.grammars.filter(
		(filename) =>
			!opts.searchDirs.some((dir) => fs.existsSync(path.join(dir, filename))),
	);
	if (missing.length === 0) return;

	const started = performance.now();
	opts.log(
		`[pi-lens test setup] pre-fetching ${missing.length} missing tree-sitter grammar(s) once, in parallel, before test workers spawn: ${missing.join(", ")}`,
	);
	const outcomes = await Promise.all(
		missing.map(async (filename) => ({
			filename,
			failure: await fetchWithOneRetry(opts.destDir, filename, opts.stallMs),
		})),
	);
	const failed = outcomes.filter(({ failure }) => failure !== undefined);
	if (failed.length === 0) {
		opts.log(
			`[pi-lens test setup] pre-fetched ${missing.length} grammar(s) in ${Math.round(performance.now() - started)} ms`,
		);
		return;
	}
	const named = failed
		.map(({ filename, failure }) => `${filename} (${failure})`)
		.join(", ");
	const message = `[pi-lens test setup] could not pre-fetch ${failed.length} of ${missing.length} tree-sitter grammar(s): ${named}. Check the network or the CDN, or place the files in ${opts.destDir}. See #4342.`;
	if (opts.ci) throw new Error(`${message} CI is set, so the run stops here.`);
	opts.log(
		`${message} Continuing: CI is not set, and a test that needs one of these fetches it itself or degrades.`,
	);
}

/** What `setup()` runs with; `client` is injectable so a test can stand up a
 * fake install layout behind the real `grammarSourceDirs`. */
export function setupOptions(
	client: Pick<TreeSitterClient, "grammarSourceDirs"> = new TreeSitterClient(),
): PrefetchOptions {
	return {
		grammars: GRAMMARS,
		searchDirs: client.grammarSourceDirs(),
		destDir: grammarsDir,
		ci: Boolean(process.env.CI),
		stallMs: GRAMMAR_STALL_MS,
		log: (line) => console.error(line),
	};
}

export default async function setup(): Promise<void> {
	await prefetchGrammars(setupOptions());
}
