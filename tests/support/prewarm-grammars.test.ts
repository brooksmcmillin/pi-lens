/**
 * #4342 round 3: the grammar prefetch globalSetup's verdicts, from the state
 * table in PR #4410.
 *
 * - Present means present in any directory the runtime loads grammars from,
 *   through the real `TreeSitterClient.grammarSourceDirs`.
 * - A retryable failure (5xx here) gets one more attempt; a 404 does not.
 * - A grammar still missing fails the run when `CI` is set, and otherwise warns
 *   once, naming every grammar, and lets the run continue.
 *
 * The CDN is a loopback server; the fetch is redirected to it at the network
 * boundary.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import {
	type PrefetchOptions,
	prefetchGrammars,
	setupOptions,
} from "./prewarm-grammars.js";
import { withEnv } from "./with-env.js";

/** Not in the pinned manifest, so only the magic and length checks apply. */
const GRAMMAR_A = "tree-sitter-prefetch-a.wasm";
const GRAMMAR_B = "tree-sitter-prefetch-b.wasm";
const WASM_BYTES = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

describe("grammar prefetch globalSetup (#4342)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let server: http.Server | undefined;
	let requests: string[];
	let lines: string[];
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-prefetch-");
		requests = [];
		lines = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		removeTempDirSync(env.tmpDir);
	});

	/** A loopback CDN answering request `n` (0-based) with `statuses[n]`, the
	 * last status repeating; a 200 carries a wasm body. */
	async function serveStatuses(statuses: number[]): Promise<void> {
		const local = http.createServer((req, res) => {
			requests.push(path.basename(req.url ?? ""));
			const status =
				statuses[Math.min(requests.length - 1, statuses.length - 1)];
			res.writeHead(status, { "content-length": String(WASM_BYTES.length) });
			res.end(status === 200 ? WASM_BYTES : Buffer.alloc(WASM_BYTES.length));
		});
		local.on("connection", (socket) => socket.on("error", () => {}));
		await new Promise<void>((resolve) =>
			local.listen(0, "127.0.0.1", () => resolve()),
		);
		server = local;
		const { port } = local.address() as AddressInfo;
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
			realFetch(
				`http://127.0.0.1:${port}/${path.basename(String(input))}`,
				init,
			),
		);
	}

	/** Every fetch fails as it does offline. */
	function goOffline(): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			requests.push(path.basename(String(input)));
			throw new TypeError("fetch failed");
		});
	}

	function options(overrides: Partial<PrefetchOptions>): PrefetchOptions {
		return {
			grammars: [GRAMMAR_A, GRAMMAR_B],
			searchDirs: [path.join(env.tmpDir, "empty")],
			destDir: path.join(env.tmpDir, "grammars"),
			ci: false,
			stallMs: 2_000,
			log: (line) => lines.push(line),
			...overrides,
		};
	}

	// Recurrence: round 2 refused to start an offline run anywhere; under CI the
	// refusal is the point, so a stalled CDN fails once at setup instead of as
	// 5 s timeouts in 20 files.
	it("stops the run under CI, naming every grammar it could not fetch", async () => {
		goOffline();
		const restore = withEnv({ CI: "true" });
		let ci: boolean;
		try {
			ci = setupOptions({ grammarSourceDirs: () => [] }).ci;
		} finally {
			restore();
		}

		await expect(prefetchGrammars(options({ ci }))).rejects.toThrow(
			/could not pre-fetch 2 of 2 tree-sitter grammar\(s\): tree-sitter-prefetch-a\.wasm \(download failed \(2 attempts\)\), tree-sitter-prefetch-b\.wasm .*CI is set/,
		);
	});

	// Recurrence: round 2's hard fail stopped every network-less sandbox and
	// offline laptop from running any test in a fresh worktree (review F2).
	it("warns once locally, naming every grammar, and lets the run continue", async () => {
		goOffline();
		const restore = withEnv({ CI: undefined });
		let ci: boolean;
		try {
			ci = setupOptions({ grammarSourceDirs: () => [] }).ci;
		} finally {
			restore();
		}

		await expect(prefetchGrammars(options({ ci }))).resolves.toBeUndefined();

		const warnings = lines.filter((line) =>
			line.includes("could not pre-fetch"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			`${GRAMMAR_A} (download failed (2 attempts))`,
		);
		expect(warnings[0]).toContain(
			`${GRAMMAR_B} (download failed (2 attempts))`,
		);
		expect(warnings[0]).toContain("Continuing");
	});

	// Recurrence: one transient CDN error per job reds a required shard once the
	// prefetch is fail-closed under CI (review F1, angle 1).
	it("retries a 503 once and lands the grammar", async () => {
		await serveStatuses([503, 200]);

		await prefetchGrammars(options({ grammars: [GRAMMAR_A], ci: true }));

		expect(requests).toEqual([GRAMMAR_A, GRAMMAR_A]);
		expect(
			fs.readFileSync(path.join(env.tmpDir, "grammars", GRAMMAR_A)),
		).toEqual(WASM_BYTES);
	});

	// Recurrence: a retry on a durable answer doubles the cost and hides that
	// the URL is wrong.
	it("does not retry a 404", async () => {
		await serveStatuses([404, 200]);

		await prefetchGrammars(options({ grammars: [GRAMMAR_A] }));

		expect(requests).toEqual([GRAMMAR_A]);
		expect(lines.at(-1)).toContain(
			`${GRAMMAR_A} (the CDN answered 404 or 410)`,
		);
	});

	// Recurrence: round 2 looked only in the repo's grammars/, which a lane
	// worktree does not have, while the shared web-tree-sitter/grammars held
	// 20 of the 26 files (review F2).
	it("counts a grammar in web-tree-sitter/grammars as present", async () => {
		const pkgDir = path.join(env.tmpDir, "node_modules", "web-tree-sitter");
		fs.mkdirSync(path.join(pkgDir, "grammars"), { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, "package.json"),
			JSON.stringify({ name: "web-tree-sitter" }),
		);
		fs.writeFileSync(path.join(pkgDir, "tree-sitter.wasm"), WASM_BYTES);
		fs.writeFileSync(path.join(pkgDir, "grammars", GRAMMAR_A), WASM_BYTES);
		const client = new TreeSitterClient(false, undefined, {
			resolveAsset: () => undefined,
			resolvePackage: (specifier) => {
				if (specifier === "web-tree-sitter/tree-sitter.wasm") {
					return path.join(pkgDir, "tree-sitter.wasm");
				}
				throw new Error(`Cannot find module '${specifier}'`);
			},
			packageRoot: () => path.join(env.tmpDir, "no-package-root"),
			cwd: () => path.join(env.tmpDir, "no-cwd"),
		});
		goOffline();

		await prefetchGrammars(
			options({ searchDirs: setupOptions(client).searchDirs }),
		);

		expect(requests).toEqual([GRAMMAR_B, GRAMMAR_B]);
		expect(lines.at(-1)).toContain("could not pre-fetch 1 of 1");
	});
});
