/**
 * #4342 round 3: `downloadGrammarDetailed`'s stall bound.
 *
 * Round 2 bounded each test-setup prefetch with a 30 s wall-clock
 * `AbortSignal.timeout`. On a 5 Mbps link the 26 parallel fetches shared the
 * bandwidth and 10 of them hit the wall clock while bytes were still arriving.
 * The bound now counts only time with no bytes: a stalled transfer fails, a slow
 * one completes. The black-hole and mid-body cases run against a real local
 * socket, so the abort travels through the real fetch; the slow-link case uses
 * fake timers and a body stream the test feeds by hand.
 *
 * #4425: the two production callers that had no bound, `TreeSitterClient`'s
 * lazy fetch and `scripts/download-grammars.js`, pass the same bound; the
 * `#4425` blocks below drive each through its own entry.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	_setGrammarManifestForTests,
	downloadGrammarDetailed,
	GRAMMAR_STALL_MS,
	vendoredGrammarsDir,
} from "../../clients/grammar-source.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import {
	downloadGrammar,
	loadManifest,
	sidecarPathFor,
} from "../../scripts/download-grammars.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/** Not in the pinned manifest, so only the magic and length checks apply. */
const GRAMMAR = "tree-sitter-stall-fixture.wasm";
const STALL_MS = 200;
const WASM_HEADER = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

describe("grammar download stall bound (#4342)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let server: http.Server | undefined;
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-grammar-stall-");
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		removeTempDirSync(env.tmpDir);
	});

	/** Serve every request with `handler` on a loopback port, and send the
	 * grammar fetch there instead of the CDN. */
	async function serveGrammar(handler: http.RequestListener): Promise<void> {
		const local = http.createServer(handler);
		local.on("connection", (socket) => socket.on("error", () => {}));
		await new Promise<void>((resolve) =>
			local.listen(0, "127.0.0.1", () => resolve()),
		);
		server = local;
		const { port } = local.address() as AddressInfo;
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
			realFetch(`http://127.0.0.1:${port}/${GRAMMAR}`, init),
		);
	}

	// Recurrence: without the bound a black-holed CDN holds the fetch until
	// undici's 300 s headers timeout, far past the 5 s test timeout.
	it("fails a connection that never answers within the stall bound", async () => {
		await serveGrammar(() => {
			/* accept, never answer */
		});

		const result = await downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});

		expect(result).toEqual({
			ok: false,
			retryable: true,
			reason: `No bytes arrived for ${STALL_MS} ms — a stalled transfer.`,
		});
		expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
	});

	// Recurrence: a bound that only covered the headers would let a body that
	// stops mid-transfer hang the read.
	it("fails a body that stops arriving mid-transfer", async () => {
		await serveGrammar((_req, res) => {
			res.writeHead(200, { "content-length": "100000" });
			res.write(WASM_HEADER);
		});

		const result = await downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("stalled transfer");
		expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
	});

	// Recurrence: round 2's wall-clock limit, which failed a 5 Mbps link that
	// was still delivering. Each chunk lands just inside the bound, and the
	// whole transfer takes nearly twice it.
	it("completes a slow body that keeps delivering past the bound", async () => {
		vi.useFakeTimers();
		let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
		let aborted = false;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					feed = controller;
					// The fetch contract: aborting the request's signal errors
					// its body stream.
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						controller.error(init.signal?.reason);
					});
				},
			});
			return new Response(body, { status: 200 });
		});
		/** Send a chunk, or end the body, unless the download already aborted. */
		const offer = (chunk?: Uint8Array): void => {
			if (aborted) return;
			if (chunk) feed?.enqueue(chunk);
			else feed?.close();
		};

		const pending = downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer(WASM_HEADER.slice(0, 4));
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer(WASM_HEADER.slice(4));
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer();

		expect(await pending).toEqual({ ok: true, retryable: true });
		expect(fs.readFileSync(path.join(env.tmpDir, GRAMMAR))).toEqual(
			Buffer.from(WASM_HEADER),
		);
	});

	describe("TreeSitterClient lazy fetch (#4425)", () => {
		const KOTLIN = "tree-sitter-kotlin.wasm";

		afterEach(() => {
			_setGrammarManifestForTests(undefined);
		});

		type ClientInternals = {
			grammarsDir: string;
			grammarStallMs: number;
			grammarsWriteDir(): string | undefined;
		};

		/** An initialized client whose grammar directories are all under the
		 * test's tmp dir: the suite's prefetch fills the worktree's `grammars/`
		 * with kotlin, which would answer before any fetch. */
		async function clientOver(
			writeDir: string,
			searchDirs: string[] = [writeDir],
		): Promise<{ client: TreeSitterClient; file: string }> {
			resetDegradationLedger();
			const client = new TreeSitterClient();
			expect(await client.init()).toBe(true);
			const internals = client as unknown as ClientInternals;
			internals.grammarsDir = writeDir;
			vi.spyOn(client, "grammarSourceDirs").mockReturnValue(searchDirs);
			vi.spyOn(internals, "grammarsWriteDir").mockReturnValue(writeDir);
			const file = path.join(env.tmpDir, "probe.kt");
			fs.writeFileSync(file, "fun main() { println(1) }\n");
			return { client, file };
		}

		const kotlinLedgerReason = (): string | undefined =>
			getDegradationSummary()
				.find((group) => group.kind === "grammar-blocked")
				?.latestReasons.find((entry) => entry.subject === KOTLIN)?.reason;

		// Recurrence: master waited out undici's 300 s headers timeout here.
		it("returns null from parseFile within the stall bound when the CDN black-holes the grammar", async () => {
			const { client, file } = await clientOver(env.tmpDir);
			(client as unknown as ClientInternals).grammarStallMs = STALL_MS;
			await serveGrammar(() => {
				/* accept, never answer */
			});

			expect(await client.parseFile(file, "kotlin")).toBeNull();

			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(kotlinLedgerReason()).toContain(
				`No bytes arrived for ${STALL_MS} ms — a stalled transfer.`,
			);
			expect(fs.existsSync(path.join(env.tmpDir, KOTLIN))).toBe(false);
		}, 5_000);

		// Recurrence: a bound that only looked right on a short fake clock, or one
		// the client never passed, leaves the 300 s wait; the production value is
		// the shared constant, no sooner and no later.
		it("aborts a silent fetch at the shared bound, then retries once after the cooldown", async () => {
			const { client, file } = await clientOver(env.tmpDir);
			vi.useFakeTimers();
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						);
					}),
			);
			const first = client.parseFile(file, "kotlin");
			// A second demand while the first is in flight shares its fetch.
			const concurrent = client.parseFile(file, "kotlin");

			await vi.advanceTimersByTimeAsync(GRAMMAR_STALL_MS - 1);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			// Still waiting: a pending promise loses a race against a resolved one.
			const waiting = Symbol("waiting");
			expect(await Promise.race([first, Promise.resolve(waiting)])).toBe(
				waiting,
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(await first).toBeNull();
			expect(await concurrent).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			// Inside the cooldown the CDN is not hit again.
			expect(await client.parseFile(file, "kotlin")).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			// Past it, the next demand is one more fetch: the "second" fetch of
			// one grammar in a long session is a retry, not a duplicate.
			await vi.advanceTimersByTimeAsync(TRANSIENT_BASE_COOLDOWN_MS);
			const retry = client.parseFile(file, "kotlin");
			await vi.advanceTimersByTimeAsync(GRAMMAR_STALL_MS);
			expect(await retry).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});

		// The stall bound reads the body through a reader instead of
		// `arrayBuffer()`; a real grammar must still land and parse.
		it.each([
			["the write directory", false],
			["a directory searched before it", true],
		])(
			"replaces a stale grammar in %s with one fetch and reuses it",
			async (_label, staleEarlier) => {
				const writeDir = path.join(env.tmpDir, "write");
				const earlierDir = path.join(env.tmpDir, "earlier");
				fs.mkdirSync(writeDir);
				fs.mkdirSync(earlierDir);
				const staleDir = staleEarlier ? earlierDir : writeDir;
				fs.writeFileSync(path.join(staleDir, KOTLIN), WASM_HEADER);
				// Any loadable module stands in for the pinned build.
				const pinned = fs.readFileSync(
					path.join(vendoredGrammarsDir(), "tree-sitter-cue.wasm"),
				);
				_setGrammarManifestForTests({
					package: "tree-sitter-wasms",
					version: "test",
					grammars: {
						[KOTLIN]: `sha256:${createHash("sha256").update(pinned).digest("hex")}`,
					},
				});
				const { client, file } = await clientOver(
					writeDir,
					staleEarlier ? [earlierDir, writeDir] : [writeDir],
				);
				const fetchSpy = vi
					.spyOn(globalThis, "fetch")
					.mockImplementation(
						async () => new Response(pinned, { status: 200 }),
					);

				expect(await client.parseFile(file, "kotlin")).not.toBeNull();
				expect(await client.parseFile(file, "kotlin")).not.toBeNull();

				expect(fetchSpy).toHaveBeenCalledTimes(1);
				expect(fs.readFileSync(path.join(writeDir, KOTLIN))).toEqual(pinned);
			},
		);
	});

	describe("install script (#4425)", () => {
		// Not in the pinned manifest, so no hash applies to the stand-in body.
		const manifest = { ...loadManifest(), grammars: {} };

		it("rejects a black-holed fetch within the stall bound and writes nothing", async () => {
			await serveGrammar(() => {
				/* accept, never answer */
			});

			await expect(
				downloadGrammar(env.tmpDir, GRAMMAR, manifest, STALL_MS),
			).rejects.toThrow(
				`no bytes arrived for ${STALL_MS} ms fetching ${GRAMMAR}`,
			);
			expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
			expect(
				fs.existsSync(sidecarPathFor(path.join(env.tmpDir, GRAMMAR))),
			).toBe(false);
		}, 5_000);

		it("rejects a body that stops arriving mid-transfer", async () => {
			await serveGrammar((_req, res) => {
				res.writeHead(200, { "content-length": "100000" });
				res.write(WASM_HEADER);
			});

			await expect(
				downloadGrammar(env.tmpDir, GRAMMAR, manifest, STALL_MS),
			).rejects.toThrow("no bytes arrived");
			expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
		}, 5_000);

		// Recurrence: a wall-clock limit would fail a slow link that still
		// delivers; each chunk lands just inside the bound.
		it("completes a slow body that keeps delivering past the bound", async () => {
			vi.useFakeTimers();
			let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						feed = controller;
						init?.signal?.addEventListener("abort", () =>
							controller.error(init.signal?.reason),
						);
					},
				});
				return new Response(body, { status: 200 });
			});

			const pending = downloadGrammar(env.tmpDir, GRAMMAR, manifest, STALL_MS);
			await vi.advanceTimersByTimeAsync(STALL_MS - 20);
			feed?.enqueue(WASM_HEADER.slice(0, 4));
			await vi.advanceTimersByTimeAsync(STALL_MS - 20);
			feed?.enqueue(WASM_HEADER.slice(4));
			await vi.advanceTimersByTimeAsync(STALL_MS - 20);
			feed?.close();

			await pending;
			// Recurrence: a stall timer left armed after success keeps the install
			// process alive for the full bound (15 s) after the last byte.
			expect(vi.getTimerCount()).toBe(0);
			expect(fs.readFileSync(path.join(env.tmpDir, GRAMMAR))).toEqual(
				Buffer.from(WASM_HEADER),
			);
			expect(
				fs.existsSync(sidecarPathFor(path.join(env.tmpDir, GRAMMAR))),
			).toBe(true);
		});
	});
});
