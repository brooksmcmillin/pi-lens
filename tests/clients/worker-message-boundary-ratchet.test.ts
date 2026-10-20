/**
 * #4402 ratchet: every worker, child-process and IPC `message` handler in the
 * shipped trees checks its input's shape and keeps a throw inside itself.
 *
 * ## The recurrence this guards
 *
 * #4400: `handleSnapshotWorkerResult` took every worker `message` as a
 * `ProjectSnapshotPersistWorkerResult` and passed `result.stagePath` to
 * `fs.rmSync`. A result without the field threw inside the listener. A throw
 * there is an uncaught exception, never the caller's, and pi exited
 * (pi-lens 4.4.3, `pi --mode rpc`). #4406 fixed that read; this file keeps
 * the next handler from shipping the same shape.
 *
 * ## The rule (tests/support/worker-message-scan.ts)
 *
 * Shape: the message parameter is typed `unknown` and never cast, so tsc
 * refuses a field read until a check has narrowed it. Containment: the body
 * is one `try` whose `catch` does not rethrow and whose block lets no
 * rejection out, or it delegates to a same-file function that is contained.
 * The scan parses comment-blanked source (strings kept for the `"message"`
 * needle); a `try` in a comment or a string never counts.
 *
 * State table, written before the scanner (handler form x verdict). Each row
 * is a named case below.
 *
 * | Form | Verdict |
 * |---|---|
 * | inline, `(m: unknown)`, body one try/catch | contained |
 * | inline, param untyped or typed as the expected result | uncontained (shape) |
 * | inline, a statement outside the try | uncontained |
 * | try/catch whose catch rethrows | uncontained |
 * | try/catch/finally whose finally throws (#4413 r1 F3) | uncontained |
 * | try/finally with no catch | uncontained |
 * | `.then()` without `.catch()` in the try | uncontained |
 * | async IIFE in the try, its body not contained | uncontained |
 * | same-file async call in the try, not awaited or caught, body not contained (F2) | uncontained |
 * | the same call awaited, or followed by `.catch` | contained |
 * | `void f(m)` in the try, `f` not a same-file function (F2) | unresolved |
 * | `m as T` or `<T>m` anywhere in the handler | uncontained (shape) |
 * | identifier naming a same-file declaration or const arrow | that function's verdict |
 * | `(m: unknown) => handle(m)` / `void (async () => {…})()` | the delegate's verdict |
 * | delegate with an argument other than the message or a literal (F1) | uncontained |
 * | identifier or delegate this file does not define (an import) | unresolved |
 * | factory call or member expression as the handler | unresolved |
 * | `try` only in a comment, or only in a string | uncontained |
 * | registration only in a comment or a string | not a site |
 * | `once`, `prependListener`, `addEventListener`, `onmessage =`, `` `message` `` | a site |
 * | event name in a same-file declarator bound to `"message"` (F5) | a site |
 * | event name from a parameter or an import | not a site (known limit) |
 * | module-level registration (F6) | keyed `#<module>`, a repeat ` #2` |
 *
 * There is no exemption list. Every live handler is decidable by the rule, so
 * the list would start empty and could only shrink; a handler the rule cannot
 * decide is restructured into a form it can (inline it, or define the
 * delegate in the same file).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	type MessageHandlerSite,
	scanMessageHandlers,
} from "../support/worker-message-scan.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * The live population, pinned in both directions with each site's reviewed
 * role. A new site reds as UNPINNED, a moved or deleted one as STALE.
 */
const PINNED_SITES: Readonly<Record<string, string>> = {
	"clients/gzip-stage-write.ts#serveGzipStageWorker port.on":
		"worker side of both persist workers: a request that fails the shape check is answered with an error result carrying whatever routing fields it had",
	"clients/project-snapshot-persist-worker.ts#serveForcedFailure parentPort.on":
		"test-only seam (#4401, PI_LENS_TEST_SNAPSHOT_WORKER_FAIL): answers a routable request with an id and generation and no stagePath, the #4400 wire shape; inert unless the variable is set",
	"clients/project-snapshot.ts#getSnapshotPersistWorker worker.on":
		"project-snapshot host (#4400): readGzipStageWorkerResult, then handleSnapshotWorkerResult; a rejected or throwing message is counted in the degradation ledger",
	"clients/review-graph/builder.ts#getPersistWorker worker.on":
		"review-graph host: handleWorkerMessage, then handleWorkerResult; a rejected or throwing message is counted in the degradation ledger",
};

function scanShippedTrees(): {
	sites: MessageHandlerSite[];
	scannedFiles: number;
} {
	const files = [
		...["clients", "mcp", "tools"].flatMap((dir) =>
			listSourceFiles(path.join(REPO_ROOT, dir), { skipTests: true }),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	const sites: MessageHandlerSite[] = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scannedFiles++;
		sites.push(...scanMessageHandlers(source, relativePosix(REPO_ROOT, file)));
	}
	return { sites, scannedFiles };
}

function verdictOf(source: string): Pick<MessageHandlerSite, "verdict"> & {
	problems: string[];
} {
	const sites = scanMessageHandlers(source, "fixture.ts");
	expect(sites).toHaveLength(1);
	return { verdict: sites[0].verdict, problems: sites[0].problems };
}

const CONTAINED_BODY = [
	"  try {",
	"    const result = readResult(message);",
	"    if (result === undefined) return;",
	"    handle(result);",
	"  } catch (err) {",
	"    note(err);",
	"  }",
];

describe("worker message boundary ratchet (#4402, recurrence #4400)", () => {
	it("finds every message handler in the shipped trees contained", () => {
		const { sites, scannedFiles } = scanShippedTrees();
		// #1718 shape: a walk that resolved nothing would read as clean.
		assertNonEmptyScan("worker message ratchet (files)", scannedFiles, 300);
		assertNonEmptyScan("worker message ratchet (sites)", sites.length, 3);
		expect(
			sites
				.filter((site) => site.verdict !== "contained")
				.map(
					(site) =>
						`${site.key} (line ${site.line}, ${site.verdict}): ${site.problems.join("; ")}`,
				),
		).toEqual([]);
	});

	it("pins the population in both directions", () => {
		const live = scanShippedTrees()
			.sites.map((site) => site.key)
			.sort();
		const pinned = Object.keys(PINNED_SITES).sort();
		expect(
			live.filter((key) => !pinned.includes(key)),
			"UNPINNED message handlers: make each one contained, then pin it here with its role",
		).toEqual([]);
		expect(
			pinned.filter((key) => !live.includes(key)),
			"STALE pins: the scan no longer finds these sites; re-pin from the live scan",
		).toEqual([]);
	});

	it("passes an inline handler typed unknown whose body is one try/catch", () => {
		const source = [
			'worker.on("message", (message: unknown) => {',
			...CONTAINED_BODY,
			"});",
		].join("\n");
		expect(verdictOf(source)).toEqual({ verdict: "contained", problems: [] });
	});

	it("fails the #4400 listener: typed as the expected result, body outside any try", () => {
		// The listener as it stood at 0338dabfe (clients/project-snapshot.ts).
		const source = [
			"function handleSnapshotWorkerResult(result: ProjectSnapshotPersistWorkerResult): void {",
			"  const pending = _snapshotWorkerRequests.get(result.id);",
			"  if (!pending) {",
			"    fs.rmSync(result.stagePath, { force: true });",
			"    return;",
			"  }",
			"}",
			"function start() {",
			'  worker.on("message", (result: ProjectSnapshotPersistWorkerResult) => {',
			"    if (_snapshotPromotionSeamForTests) {",
			"      void _snapshotPromotionSeamForTests().then(() => handleSnapshotWorkerResult(result));",
			"      return;",
			"    }",
			"    handleSnapshotWorkerResult(result);",
			"  });",
			"}",
		].join("\n");
		const { verdict, problems } = verdictOf(source);
		expect(verdict).toBe("uncontained");
		expect(problems).toEqual([
			'message parameter "result" is typed "ProjectSnapshotPersistWorkerResult"; type it unknown so tsc requires a shape check before any field read (#4400)',
			"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
		]);
	});

	it("fails an untyped parameter: Node types the message as any", () => {
		const source = [
			'parentPort.on("message", (request) => {',
			...CONTAINED_BODY,
			"});",
		].join("\n");
		expect(verdictOf(source).problems).toEqual([
			'message parameter "request" is typed implicitly; type it unknown so tsc requires a shape check before any field read (#4400)',
		]);
	});

	it("fails a cast of the message, which skips the shape check", () => {
		for (const cast of ["(message as Result)", "(<Result>message)"]) {
			const source = [
				'worker.on("message", (message: unknown) => {',
				"  try {",
				`    handle(${cast}.id);`,
				"  } catch (err) {",
				"    note(err);",
				"  }",
				"});",
			].join("\n");
			expect(verdictOf(source).problems, cast).toEqual([
				`message parameter "message" is cast (${cast.slice(1, -1)}); a cast skips the shape check`,
			]);
		}
	});

	it("fails a statement outside the try", () => {
		const source = [
			'worker.on("message", (message: unknown) => {',
			"  const result = readResult(message);",
			...CONTAINED_BODY,
			"});",
		].join("\n");
		expect(verdictOf(source)).toEqual({
			verdict: "uncontained",
			problems: [
				"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
			],
		});
	});

	it("fails a catch that rethrows and a try with no catch", () => {
		const rethrows = [
			'worker.on("message", (message: unknown) => {',
			"  try { handle(message); } catch (err) { note(err); throw err; }",
			"});",
		].join("\n");
		expect(verdictOf(rethrows).problems).toEqual([
			"catch rethrows (throw err;)",
		]);
		const finallyOnly = [
			'worker.on("message", (message: unknown) => {',
			"  try { handle(message); } finally { done(); }",
			"});",
		].join("\n");
		expect(verdictOf(finallyOnly).problems).toEqual([
			"try has no catch: a throw still leaves the listener",
		]);
	});

	it("fails a finally that throws, as it fails a catch that rethrows", () => {
		// #4413 r1 F3: the finally clause was never walked.
		const source = [
			'worker.on("message", (message: unknown) => {',
			"  try { handle(message); } catch (err) { note(err); } finally { throw new Error('late'); }",
			"});",
		].join("\n");
		expect(verdictOf(source)).toEqual({
			verdict: "uncontained",
			problems: ["finally throws (throw new Error('late');)"],
		});
	});

	it("fails a delegate whose argument is evaluated before the delegate's try", () => {
		// #4413 r1 F1: `handle(parse(m))` runs parse in the listener, before
		// handle's try, so a parse throw ends the host as #4400 did.
		const withDelegate = (registration: string) =>
			[
				"function handle(message: unknown, ...rest: unknown[]): void {",
				...CONTAINED_BODY,
				"}",
				registration,
			].join("\n");
		for (const [registration, argument] of [
			['worker.on("message", (m: unknown) => handle(parse(m)));', "parse(m)"],
			[
				'worker.on("message", (m: unknown) => handle(m, extra(m)));',
				"extra(m)",
			],
			[
				'worker.on("message", (m: unknown) => { handle(readResult(m)); });',
				"readResult(m)",
			],
		]) {
			expect(verdictOf(withDelegate(registration)), registration).toEqual({
				verdict: "uncontained",
				problems: [
					`argument ${argument} is evaluated before handle's try runs; pass the message itself and read it inside the try`,
				],
			});
		}
		expect(
			verdictOf(
				withDelegate(
					'worker.on("message", (m: unknown) => handle(m, "x", 1, null, undefined, true));',
				),
			),
		).toEqual({ verdict: "contained", problems: [] });
		// An unresolved delegate still names the argument it evaluates first.
		expect(
			verdictOf('worker.on("message", (m: unknown) => imported(parse(m)));'),
		).toEqual({
			verdict: "unresolved",
			problems: [
				"argument parse(m) is evaluated before imported's try runs; pass the message itself and read it inside the try",
				"delegates to imported, which this file does not define; the scan cannot follow it",
			],
		});
	});

	it("judges an unhandled same-file async call in the try like the async IIFE", () => {
		// #4413 r1 F2: the rejection of an un-awaited async call leaves the try,
		// and pi's crash guard rethrows an unhandled rejection (host death).
		const source = (call: string, runBody: string[], asyncHandler = false) =>
			[
				"async function run(message: unknown): Promise<void> {",
				...runBody,
				"}",
				`worker.on("message", ${asyncHandler ? "async " : ""}(message: unknown) => {`,
				"  try {",
				`    ${call}`,
				"  } catch (err) {",
				"    note(err);",
				"  }",
				"});",
			].join("\n");
		const uncontainedRun = [
			"  const result = readResult(message);",
			"  apply(result);",
		];
		const notContained =
			"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host";
		expect(verdictOf(source("void run(message);", uncontainedRun))).toEqual({
			verdict: "uncontained",
			problems: [
				`run(message) is neither awaited nor caught, so its rejection leaves the try: ${notContained}`,
			],
		});
		expect(verdictOf(source("run(message);", uncontainedRun))).toEqual({
			verdict: "uncontained",
			problems: [
				`run(message) is neither awaited nor caught, so its rejection leaves the try: ${notContained}`,
			],
		});
		expect(
			verdictOf(source("void run(message);", CONTAINED_BODY)).verdict,
		).toBe("contained");
		expect(
			verdictOf(source("await run(message);", uncontainedRun, true)).verdict,
		).toBe("contained");
		expect(
			verdictOf(
				source("void run(message).catch((err) => note(err));", uncontainedRun),
			).verdict,
		).toBe("contained");
		// A voided call marks a promise even when the callee is not declared
		// async (it returns one), so its body is judged the same way.
		const syncReturningPromise = source("void run(message);", [
			"  const pending = save(message);",
			"  return pending;",
		]).replace("async function run", "function run");
		expect(verdictOf(syncReturningPromise)).toEqual({
			verdict: "uncontained",
			problems: [
				`run(message) is neither awaited nor caught, so its rejection leaves the try: ${notContained}`,
			],
		});
		for (const callee of ["imported", "store.persist"]) {
			expect(
				verdictOf(source(`void ${callee}(message);`, uncontainedRun)),
				callee,
			).toEqual({
				verdict: "unresolved",
				problems: [
					`voided promise from ${callee}, which this file does not define; the scan cannot follow it`,
				],
			});
		}
	});

	it("fails a rejection that can leave the try, and passes it once caught", () => {
		const floating = [
			'worker.on("message", (message: unknown) => {',
			"  try {",
			"    void seam().then(() => handle(message));",
			"  } catch (err) {",
			"    note(err);",
			"  }",
			"});",
		].join("\n");
		expect(verdictOf(floating).problems).toEqual([
			"a .then() chain without .catch() lets a rejection out of the try (seam().then(() => handle(message)))",
		]);
		expect(
			verdictOf(
				floating.replace(
					"handle(message));",
					"handle(message)).catch((err) => note(err));",
				),
			).verdict,
		).toBe("contained");
		const asyncIife = [
			'worker.on("message", (message: unknown) => {',
			"  try {",
			"    void (async () => { await handle(message); })();",
			"  } catch (err) {",
			"    note(err);",
			"  }",
			"});",
		].join("\n");
		expect(verdictOf(asyncIife).problems).toEqual([
			"body is not one try/catch: a throw from a statement outside a try leaves the listener and ends the host",
		]);
	});

	it("does not accept a try that exists only in a comment or a string", () => {
		// The self-excuse direction: prose must never satisfy the rule.
		const commented = [
			'worker.on("message", (message: unknown) => {',
			"  // try {",
			"  const result = readResult(message);",
			"  handle(result);",
			"  /* } catch (err) { note(err); } */",
			"});",
		].join("\n");
		expect(verdictOf(commented).verdict).toBe("uncontained");
		const quoted = [
			'worker.on("message", (message: unknown) => {',
			'  const advice = "try { handle(message); } catch (err) {}";',
			"  handle(readResult(message), advice);",
			"});",
		].join("\n");
		expect(verdictOf(quoted).verdict).toBe("uncontained");
	});

	it("does not count a registration written only in a comment or a string", () => {
		const source = [
			'// worker.on("message", (result) => handle(result));',
			"const advice = 'worker.on(\"message\", handle)';",
			"/* port.onmessage = handle; */",
		].join("\n");
		expect(scanMessageHandlers(source, "fixture.ts")).toEqual([]);
	});

	it("finds every listener spelling and the onmessage assignment", () => {
		const source = [
			"function handle(message: unknown): void {",
			...CONTAINED_BODY,
			"}",
			'parentPort?.once("message", handle);',
			"port.prependListener('message', handle);",
			"target.addEventListener(`message`, handle);",
			"port.onmessage = handle;",
			'child.on("message", handle);',
			// #4413 r1 F5: an event name held in a same-file declarator is a site.
			"const event = 'message';",
			"worker.on(event, (message) => handle(message));",
			"const other = 'error';",
			"worker.on(other, handle);",
		].join("\n");
		expect(
			scanMessageHandlers(source, "fixture.ts").map((site) => [
				site.key.replace(/^fixture\.ts#\S+ /, ""),
				site.verdict,
			]),
		).toEqual([
			["parentPort.once", "contained"],
			["port.prependListener", "contained"],
			["target.addEventListener", "contained"],
			["port.onmessage", "contained"],
			["child.on", "contained"],
			["worker.on", "uncontained"],
		]);
	});

	it("keys a module-level listener as the module, never the function above it", () => {
		// #4413 r1 F6: a line-based lookup keyed #4409's module-level listener
		// by the previous function, so inserting a function above moved the pin.
		const source = [
			"function handle(message: unknown): void {",
			...CONTAINED_BODY,
			"}",
			'parentPort.on("message", handle);',
			"function start(): void {",
			'  worker.on("message", (message: unknown) => {',
			"    worker.on('message', handle);",
			"  });",
			"}",
			"const boot = () => {",
			"  setup(() => worker.on('message', handle));",
			"};",
			'parentPort.on("message", handle);',
		].join("\n");
		expect(
			scanMessageHandlers(source, "fixture.ts").map((site) => site.key),
		).toEqual([
			"fixture.ts#<module> parentPort.on",
			"fixture.ts#start worker.on",
			"fixture.ts#start worker.on #2",
			"fixture.ts#boot worker.on",
			"fixture.ts#<module> parentPort.on #2",
		]);
	});

	it("follows a same-file delegate and judges it", () => {
		const delegate = (body: string[]) =>
			[
				"const handleWorkerMessage = (message: unknown): void => {",
				...body,
				"};",
				"function start() {",
				'  worker.on("message", (message: unknown) => handleWorkerMessage(message));',
				'  worker.on("message", handleWorkerMessage);',
				"}",
			].join("\n");
		expect(
			scanMessageHandlers(delegate(CONTAINED_BODY), "fixture.ts").map(
				(site) => site.verdict,
			),
		).toEqual(["contained", "contained"]);
		expect(
			scanMessageHandlers(
				delegate([
					"  const result = readResult(message);",
					"  handle(result);",
				]),
				"fixture.ts",
			).map((site) => site.verdict),
		).toEqual(["uncontained", "uncontained"]);
	});

	it("judges an async IIFE body as the handler body", () => {
		const source = (inner: string[]) =>
			[
				'parentPort.on("message", (message: unknown) => {',
				"  void (async () => {",
				...inner,
				"  })();",
				"});",
			].join("\n");
		expect(verdictOf(source(CONTAINED_BODY)).verdict).toBe("contained");
		expect(verdictOf(source(["    await handle(message);"])).verdict).toBe(
			"uncontained",
		);
	});

	it("reports a name two functions share as unresolved, never the first match", () => {
		// The contained twin comes first, so a resolver that took the first
		// match would pass the bare handler the listener may actually bind.
		const source = [
			"function outer() {",
			"  function handle(message: unknown): void {",
			...CONTAINED_BODY,
			"  }",
			"  return handle;",
			"}",
			"function handle(message: unknown): void {",
			"  const result = readResult(message);",
			"  apply(result);",
			"}",
			'worker.on("message", handle);',
		].join("\n");
		expect(verdictOf(source).verdict).toBe("unresolved");
	});

	it("reports a handler it cannot follow as unresolved, never contained", () => {
		for (const handler of [
			"importedHandler",
			"guarded(handle)",
			"this.handle",
			"(message: unknown) => importedHandler(message)",
		]) {
			const source = `worker.on("message", ${handler});`;
			expect(verdictOf(source).verdict, handler).toBe("unresolved");
		}
	});
});
