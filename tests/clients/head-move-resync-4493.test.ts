// flake-shape: real-process-spawn — a clean-tree HEAD move exists only in a real repository that git checks out, rebases or resets; a stubbed git could not rewrite the files the language server holds.
// flake-shape: in-process-mock — a project lsp.json cannot declare an auxiliary server (its role is reserved and inert), so the catalog lookup adds the auxiliary fake for the repositories registered here, and the role lookup (getServerById) answers for it too (#4476); every server is still a real child process on a real stdio wire
// flake-shape: ungoverned-wait-for — #4528 r1 F3 joins a dependency restart that runs between real server processes and ends after the bounded tool_call hook returns; nothing in it is awaitable.
/**
 * #4493: a clean-tree HEAD move left held documents stale on the server.
 *
 * After `git checkout B` on a clean tree (and a completed rebase or
 * cherry-pick, `git reset --hard`, or the same checkout made outside pi),
 * `git status` is empty, so opaque recovery resynced nothing and the server
 * kept the pre-move bytes of every document pi-lens had open. The next edit
 * of an unrelated line was blocked by an error `tsc` on disk does not report.
 *
 * These cases drive the REAL `handleToolCall` / `handleToolResult` seams with
 * a real RuntimeCoordinator, a real git repository and the real LSPService,
 * client and stdio wire. The servers are the shared fake LSP child process,
 * project-configured, with `FAKE_LSP_TRACE_TEXT` so its trace names the bytes
 * each didOpen/didChange carried: the wire is the witness, not pi-lens's own
 * bookkeeping. Only the host's command execution is stood in for: the test
 * runs the git command between the two hooks, as pi's bash tool would.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { workspaceFileCreatedAtFor } from "../../clients/lsp/workspace-diagnostics-session.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import {
	headRecordKey,
	observeGitHead,
	recoverOpaqueChangesViaGit,
	resetOpaqueMutationState,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	handleToolResult,
	resyncHeadMove,
} from "../../clients/runtime-tool-result.js";
import { execFileSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

/**
 * #4493 r2: the auxiliary scanner a repository's `.ts` files also go to (the
 * ast-grep slot of the default stack). A project `lsp.json` cannot declare an
 * auxiliary (its `role` is reserved and inert, clients/lsp/config.ts), so the
 * catalog lookup adds it for the repositories registered here, the pattern the
 * #1714 real-stream suites use; every other lookup is the real one.
 */
const primaryOrdering = vi.hoisted(
	() => new Map<string, "single-task-ordered" | "threaded" | "unmeasured">(),
);
const auxiliaries = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../clients/lsp/config.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/config.js")>();
	const { sep } = await import("node:path");
	return {
		...actual,
		getServersForFileWithConfig: (filePath: string) => {
			const servers = actual
				.getServersForFileWithConfig(filePath)
				.map((server) => {
					for (const [dir, ordering] of primaryOrdering)
						if (filePath.startsWith(`${dir}${sep}`))
							return { ...server, replyOrdering: ordering };
					return server;
				});
			for (const [dir, aux] of auxiliaries)
				if (filePath.startsWith(`${dir}${sep}`))
					return [...servers, aux as (typeof servers)[number]];
			return servers;
		},
	};
});

// #4476: the role lookup the registry's restart asks (`getServerById`) knows
// the built-in catalog only; it answers for the auxiliaries registered here too.
vi.mock("../../clients/lsp/server.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/server.js")>();
	return {
		...actual,
		getServerById: (id: string) =>
			[...auxiliaries.values()].find(
				(aux) => (aux as { id?: string }).id === id,
			) ?? actual.getServerById(id),
	};
});

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4493-head-move-";
const env = setupTestEnvironment(PREFIX);

const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

interface Repo {
	dir: string;
	trace: string;
	git: (...args: string[]) => string;
	file: (name: string) => string;
}

let repoCount = 0;

/** Real git in `cwd`, with a fixed identity; its trimmed stdout. */
function runGit(cwd: string, args: string[]): string {
	return String(
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.local",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.local",
			},
		}),
	).trim();
}

/**
 * A repository on branch `A` whose branch `B` rewrites `changed`. Both
 * servers are the fake, one for `.ts` and one for `.py` (the non-TypeScript
 * row); the built-in servers that would claim those files are disabled.
 */
async function makeRepo(
	base: Record<string, string>,
	changed: Record<string, string>,
	initArgs: string[] = [],
	profile: Record<string, string> = {},
): Promise<Repo> {
	const dir = path.join(env.tmpDir, `repo-${++repoCount}`);
	const trace = path.join(env.tmpDir, `repo-${repoCount}.trace`);
	primaryOrdering.set(dir, "single-task-ordered");
	fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
	const shim = path.join(env.tmpDir, `repo-${repoCount}-server.mjs`);
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_TRACE_TEXT = "1";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			...Object.entries(profile).map(
				([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`,
			),
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	const server = (extensions: string[]) => ({
		name: "fake",
		extensions,
		command: process.execPath,
		args: [shim],
		rootMarkers: ["package.json"],
	});
	const files: Record<string, string> = {
		"package.json": "{}\n",
		".gitignore": ".pi-lens/\n",
		// Same files committed in the same second give the same commit ids;
		// this makes every repository's ids, and so its rows, its own.
		"repo-id.txt": `${repoCount}\n`,
		...base,
	};
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
	fs.writeFileSync(
		path.join(dir, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: { "fake-ts": server([".ts"]), "fake-py": server([".py"]) },
			disabledServers: [
				"typescript",
				"deno",
				"python",
				"python-jedi",
				"opengrep",
				"ast-grep",
				"typos",
			],
		}),
	);
	const git = (...args: string[]) => runGit(dir, args);
	git("init", "-q", "-b", "A", ...initArgs);
	git("add", "-A");
	git("commit", "-qm", "base");
	git("branch", "B");
	git("checkout", "-q", "B");
	for (const [name, content] of Object.entries(changed))
		fs.writeFileSync(path.join(dir, name), content);
	git("commit", "-qam", "B");
	git("checkout", "-q", "A");
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	return { dir, trace, git, file: (name) => path.join(dir, name) };
}

async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

/** Open `files` on their server, as the post-write sync does. */
async function hold(repo: Repo, names: string[]): Promise<void> {
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
	}
}

/**
 * Give `repo`'s `.ts` files an auxiliary scanner that spends `changeCostMs` of
 * synchronous work on each didChange, and open `names` on both servers.
 */
async function holdWithAuxiliary(
	repo: Repo,
	names: string[],
	changeCostMs: number,
): Promise<void> {
	const { spawnFakeLspServer } = await import("../support/fake-lsp-server.js");
	auxiliaries.set(repo.dir, {
		id: `fake-aux-${path.basename(repo.dir)}`,
		name: "fake-aux",
		role: "auxiliary",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => repo.dir,
		spawn: async () => ({
			process: await spawnFakeLspServer({
				cwd: repo.dir,
				env: {
					...process.env,
					FAKE_LSP_CHANGE_COST_MS: String(changeCostMs),
				},
			}),
			source: "test" as const,
		}),
	});
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "all",
			source: "lsp_sync",
		});
	}
}

function traceLines(repo: Repo): string[] {
	return fs.existsSync(repo.trace)
		? fs.readFileSync(repo.trace, "utf8").split("\n").filter(Boolean)
		: [];
}

/**
 * The server's trace up to a request sent now. The fake reads stdin in
 * order, and the client writes one ordered stream, so a didChange written
 * before this call is traced before the request is answered. A plain read of
 * the trace races the server process instead.
 */
async function wire(repo: Repo, onServerOf: string): Promise<string[]> {
	await (await lspService()).documentSymbol(repo.file(onServerOf));
	return traceLines(repo);
}

/** The bytes the server received after `mark` trace lines, as `text` lines. */
async function textSince(
	repo: Repo,
	mark: number,
	onServerOf: string,
): Promise<string[]> {
	return (await wire(repo, onServerOf))
		.slice(mark)
		.filter((line) => line.startsWith("text "));
}

const textLine = (repo: Repo, name: string) =>
	`text ${pathToFileURL(repo.file(name)).href} ${sha(fs.readFileSync(repo.file(name), "utf8"))}`;

/**
 * Whether the client already sent `name`'s disk bytes, read synchronously:
 * called right after a hook returns, with the service fetched beforehand, it
 * says the didChange went out BEFORE the return (no later microtask or I/O
 * can complete in between). The wire check then shows the server got them.
 */
function sentDiskBytes(
	service: Awaited<ReturnType<typeof lspService>>,
	repo: Repo,
	name: string,
): boolean {
	const file = repo.file(name);
	const want = hashDiagnosticContent(fs.readFileSync(file, "utf8"));
	return service.getTrackedContent(file, repo.dir)?.hash === want;
}

/** The text of a tool_result's content, as the model reads it. */
function resultText(
	result: Awaited<ReturnType<typeof handleToolResult>>,
): string {
	return (result?.content ?? [])
		.map((part) => ("text" in part ? String(part.text ?? "") : ""))
		.join("\n");
}

/**
 * One pi session's hooks. `shared` passes another session's coordinator: in
 * index.ts one module-level RuntimeCoordinator serves the primary and every
 * concurrent secondary session, so they share its `sessionGeneration`.
 */
/**
 * A session's hooks. `parent` makes every call nested under that tool call,
 * as a codemode script's bash is (`parentToolCallId` on both events).
 */
function session(
	repo: Repo,
	sessionId: string,
	shared?: RuntimeCoordinator,
	parent?: string,
) {
	const runtime = shared ?? new RuntimeCoordinator();
	runtime.projectRoot = repo.dir;
	if (!shared) runtime.setTelemetryIdentity({ sessionId });
	let n = 0;
	const callDeps = (toolName: string, input: unknown, toolCallId: string) =>
		({
			event: {
				toolName,
				toolCallId,
				input,
				...(parent !== undefined && { parentToolCallId: parent }),
			},
			ctx: { cwd: repo.dir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
			sessionId,
		}) as Parameters<typeof handleToolCall>[0];
	const resultDeps = (command: string, toolCallId: string) =>
		({
			event: {
				toolName: "bash",
				toolCallId,
				input: { command },
				content: [{ type: "text", text: "ok" }],
				...(parent !== undefined && { parentToolCallId: parent }),
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			sessionId,
		}) as unknown as Parameters<typeof handleToolResult>[0];
	return {
		runtime,
		/** The bash tool_call; the returned function is its tool_result. */
		async bashCall(command: string): Promise<() => Promise<string>> {
			const id = `${sessionId}-c${++n}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps("bash", { command }, id)),
			);
			return async () =>
				resultText(await handleToolResult(resultDeps(command, id)));
		},
		/**
		 * One whole bash call: tool_call, the host's run, tool_result. Answers
		 * the text the tool_result returned to the model.
		 */
		async bash(command: string, run: () => void): Promise<string> {
			const result = await this.bashCall(command);
			run();
			return result();
		},
		async read(file: string): Promise<void> {
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps("read", { path: file }, `${sessionId}-c${++n}`),
				),
			);
		},
	};
}

/**
 * The head_moved rows whose move landed on `ref` (branch B): `repo-id.txt`
 * makes commit ids unique per repository, so no other case's row can match.
 */
async function headMovedRows(
	repo: Repo,
	ref = "B",
): Promise<Array<{ result: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const to = repo.git("rev-parse", ref).slice(0, 12);
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes('"opaque_mutation_head_moved"'))
		.map(
			(line) =>
				JSON.parse(line) as {
					result: string;
					metadata: Record<string, unknown>;
				},
		)
		.filter((row) => row.metadata.to === to);
}

/**
 * The head_moved rows once `count` have landed. The row is written when the
 * resync's detached second phase (every holding server, the drift records)
 * ends, after the hook returned.
 */
async function settledHeadMovedRows(repo: Repo, count: number, ref = "B") {
	await expect
		.poll(async () => (await headMovedRows(repo, ref)).length, {
			timeout: 30_000,
			interval: 100,
		})
		.toBe(count);
	return headMovedRows(repo, ref);
}

/** Every `phase` row in the real latency sink. */
async function phaseRows(
	phase: string,
): Promise<Array<{ filePath: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes(`"${phase}"`))
		.map(
			(line) =>
				JSON.parse(line) as {
					filePath: string;
					metadata: Record<string, unknown>;
				},
		);
}

const TYPES_A =
	"export function isChatModel(x: unknown): boolean { return !!x; }\n";
const TYPES_B = `${TYPES_A}export function isChatModelConfig(x: unknown): boolean { return !!x; }\n`;
const MAIN =
	'import { isChatModel } from "./lib/types";\nexport const note = "one";\n';

let previousTestMode: string | undefined;
let previousDriftMs: string | undefined;

beforeAll(() => {
	// Host-boundary stub: a project-configured server needs pi's trust answer
	// (#4248 refuses it otherwise).
	setProjectTrustState("trusted");
	// latency.log writes are off under PI_LENS_TEST_MODE (#1742); the
	// head_moved row is read back from the real sink.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	// The paced drift heartbeat could heal a stale document by chance on a
	// later touch; off, only the HEAD-move resync can produce the new bytes.
	previousDriftMs = process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
	process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "0";
});

afterAll(async () => {
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	if (previousDriftMs === undefined)
		delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
	else process.env.PI_LENS_LSP_DRIFT_CHECK_MS = previousDriftMs;
	await cleanupTestEnvironmentsDrained(PREFIX, {
		beforeDrain: async () => {
			await (await lspService()).shutdown();
		},
	});
	resetProjectTrust();
});

beforeEach(() => {
	resetOpaqueMutationState();
});

describe("a clean-tree HEAD move resyncs held documents (#4493)", () => {
	// Recurrence: the reported block. `git checkout B` on a clean tree sent no
	// didChange for the held lib/types.ts, so main.ts's import of the new
	// export stayed an error until the 10 s drift heartbeat happened to run.
	it("sends a held document's new bytes before the checkout's tool_result returns, and records no mutation", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN, "lib/unheld.ts": "" },
			{ "lib/types.ts": TYPES_B, "lib/unheld.ts": "export {};\n" },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-checkout");
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(repo.git("status", "--porcelain")).toBe("");
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		// The delta is incoming content: no fileSeq bump, no change-log entry.
		expect(s.runtime.getFileSeq(repo.file("lib/types.ts"))).toBe(0);
		expect(fs.existsSync(getProjectChangeLogPath(repo.dir))).toBe(false);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			// The unheld file is in the delta but not resynced: only a held
			// document can be stale.
			result: "changed:2",
			metadata: {
				trigger: "tool_result",
				changed: 2,
				held: 1,
				resynced: 1,
				deferred: 0,
				failed: 0,
			},
		});
	}, 30_000);

	// Recurrence: review r1 F4's named output reads HEAD from the files git
	// keeps. A reftable ref store (git 2.45+) keeps no loose or packed ref, so
	// that read cannot answer; without the `git rev-parse` fallback the
	// feature would be silently off there. Skipped only where this git cannot
	// create a reftable repository.
	const reftable = (() => {
		try {
			const probe = path.join(env.tmpDir, "reftable-probe");
			fs.mkdirSync(probe, { recursive: true });
			runGit(probe, ["init", "-q", "--ref-format=reftable"]);
			return true;
		} catch {
			return false;
		}
	})();
	it("sends the new bytes before the tool_result in a repository whose refs are a reftable", async (ctx) => {
		ctx.skip(!reftable, "this git cannot create a reftable repository");
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
			["--ref-format=reftable"],
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-reftable");
		const service = await lspService();

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
	}, 30_000);

	// Recurrence: the probe's rows 3 and 4 plus the reset sibling. Each
	// completes on a clean tree and moves HEAD, so each was as invisible as
	// the checkout.
	it.each([
		{
			kind: "a completed rebase",
			setup: (repo: Repo) => {
				fs.writeFileSync(repo.file("notes.txt"), "A local\n");
				repo.git("add", "notes.txt");
				repo.git("commit", "-qm", "A local note");
			},
			command: "git rebase B",
		},
		{
			kind: "a completed cherry-pick",
			setup: () => {},
			command: "git cherry-pick B",
		},
		{
			kind: "git reset --hard",
			setup: () => {},
			command: "git reset --hard B",
		},
	])(
		"sends the new bytes before the tool_result of $kind returns",
		async ({ setup, command }) => {
			const repo = await makeRepo(
				{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
				{ "lib/types.ts": TYPES_B },
			);
			setup(repo);
			await hold(repo, ["lib/types.ts", "main.ts"]);
			const s = session(repo, `s-${command.split(" ")[1]}`);
			const service = await lspService();
			const mark = (await wire(repo, "main.ts")).length;

			await s.bash(command, () => repo.git(...command.split(" ").slice(1)));

			expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
			expect(repo.git("status", "--porcelain")).toBe("");
			expect(fs.readFileSync(repo.file("lib/types.ts"), "utf8")).toBe(TYPES_B);
			expect(await textSince(repo, mark, "main.ts")).toContain(
				textLine(repo, "lib/types.ts"),
			);
		},
		30_000,
	);

	// Recurrence: probe row 6 (the non-TypeScript screen, AGENTS.md shape 42).
	// The seam is language-neutral; a held Python document heals the same way.
	it("resyncs a held non-TypeScript document", async () => {
		const repo = await makeRepo(
			{ "app/models.py": "def is_chat_model(x):\n    return bool(x)\n" },
			{
				"app/models.py":
					"def is_chat_model(x):\n    return bool(x)\n\ndef is_chat_model_config(x):\n    return bool(x)\n",
			},
		);
		await hold(repo, ["app/models.py"]);
		const s = session(repo, "s-python");
		const service = await lspService();
		const mark = (await wire(repo, "app/models.py")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "app/models.py")).toBe(true);
		expect(await textSince(repo, mark, "app/models.py")).toContain(
			textLine(repo, "app/models.py"),
		);
	}, 30_000);

	// Recurrence: probe row 5. A checkout made outside pi emits no tool event,
	// so only the next tool_call can notice it; a read is enough.
	it("resyncs at the next turn's first tool_call after a move made outside pi", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-outside");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		repo.git("checkout", "-q", "B");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { trigger: "tool_call", resynced: 1 },
		});
	}, 30_000);

	// Recurrence: probe INJECT2. One forced pass resyncs 4 documents, so a
	// 12-document hop left 8 stale for two more 10 s heartbeats.
	it("heals a 12-document hop before the tool_result returns", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/m${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		await hold(repo, names);
		const s = session(repo, "s-twelve");
		const service = await lspService();
		const mark = (await wire(repo, names[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(names.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		const received = await textSince(repo, mark, names[0]!);
		for (const name of names) expect(received).toContain(textLine(repo, name));
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]).toMatchObject({
			metadata: { held: 12, resynced: 12, deferred: 0 },
		});
	}, 60_000);

	// Recurrence: review r1 F1, the reported STOP on the default stack. The
	// resync touched each held document on every holding server in turn, so
	// the auxiliary's #1714 pacing barrier, waiting out a scanner busy with the
	// earlier didChanges, held back the PRIMARY's later didChanges past the
	// hook bound: the tool_result returned with documents stale on the primary
	// and the next edit STOPped on TS2305 (13 held files, 2 of 2 live runs).
	it("sends every changed held document to the primary before the tool_result returns, however slow the auxiliary", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/s${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		try {
			await holdWithAuxiliary(repo, names, 250);
			const s = session(repo, "s-slow-aux");
			const service = await lspService();

			await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

			expect(
				names.filter((name) => !sentDiskBytes(service, repo, name)),
			).toEqual([]);
			// The auxiliary catches up after the look; the one row lands then.
			await expect
				.poll(async () => (await headMovedRows(repo)).length, {
					timeout: 30_000,
					interval: 200,
				})
				.toBe(1);
			expect((await headMovedRows(repo))[0]).toMatchObject({
				metadata: { held: 12, primary: 12, deferred: 0 },
			});
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 90_000);

	// Recurrence: review r1 F1, part 2. pi runs one message's tool calls in
	// parallel, so a read's tool_call can arrive while the bash's tool_result
	// look is still resending. The turn was already marked looked, so the
	// tool_call skipped the look and the read ran against the stale primary.
	it("holds a parallel tool_call until the running look has sent the move's bytes", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-join");
		s.runtime.beginTurn("s-join");
		const service = await lspService();
		const result = await s.bashCall("git checkout B");
		repo.git("checkout", "-q", "B");

		const looking = result();
		await s.read(repo.file("main.ts"));
		const sentAtRead = sentDiskBytes(service, repo, "lib/types.ts");
		await looking;

		expect(sentAtRead).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: review r1 F2 (#1687's shape). A look that joins a running
	// look must see a move made after that look read HEAD; the single-flight's
	// trailing pass is what reads it again. The shim holds the running look in
	// its `git diff` so the second move lands mid-flight.
	it("a look that joins a running look sees a move made after that look read HEAD", async (ctx) => {
		ctx.skip(
			process.platform === "win32",
			"the git shim that stalls the running look is a POSIX shell script",
		);
		// C changes a file B does not, so only a look that reads HEAD after
		// the move to C (the trailing pass) resends it: the running look's
		// delta is A..B.
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "lib/other.ts": "export const o = 0;\n" },
			{ "lib/types.ts": TYPES_B },
		);
		repo.git("checkout", "-q", "B");
		fs.writeFileSync(repo.file("lib/other.ts"), "export const o = 1;\n");
		repo.git("commit", "-qam", "C");
		repo.git("branch", "C");
		repo.git("reset", "-q", "--hard", "HEAD~1");
		repo.git("checkout", "-q", "A");
		await hold(repo, ["lib/types.ts", "lib/other.ts"]);
		const service = await lspService();
		// Host boundary: a `git` on PATH that stalls `diff` while a marker
		// exists, then runs the real git.
		const realGit = (process.env.PATH ?? "")
			.split(path.delimiter)
			.map((dir) => path.join(dir, "git"))
			.find((candidate) => fs.existsSync(candidate));
		if (!realGit) throw new Error("git is not on PATH");
		const shimDir = path.join(env.tmpDir, `git-shim-${repoCount}`);
		const slow = path.join(shimDir, "slow");
		const started = path.join(shimDir, "started");
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(
			path.join(shimDir, "git"),
			[
				"#!/bin/sh",
				`if [ "$1" = "diff" ] && [ -e ${JSON.stringify(slow)} ]; then : > ${JSON.stringify(started)}; sleep 0.4; fi`,
				`exec ${JSON.stringify(realGit)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
		try {
			const look = {
				root: repo.dir,
				key: headRecordKey("trailing", "s-trailing"),
				trigger: "tool_result" as const,
				label: "git checkout",
			};
			await resyncHeadMove(look);
			repo.git("checkout", "-q", "B");
			fs.writeFileSync(slow, "");
			const running = resyncHeadMove(look);
			await expect.poll(() => fs.existsSync(started)).toBe(true);
			repo.git("checkout", "-q", "C");
			fs.rmSync(slow);

			await resyncHeadMove(look);

			expect(sentDiskBytes(service, repo, "lib/other.ts")).toBe(true);
			await running;
		} finally {
			process.env.PATH = previousPath;
		}
	}, 30_000);

	// Recurrence: review r1 F3. The forced passes stop as soon as no queued
	// document is waiting; without that exit every move runs all 16 passes.
	it("runs one forced pass for a one-document move", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-passes");

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		const file = normalizeMapKey(repo.file("lib/types.ts"));
		const rowFor = async () =>
			(await phaseRows("lsp_external_change_resync")).find(
				(row) => normalizeMapKey(row.filePath) === file,
			);
		await expect.poll(rowFor, { timeout: 10_000 }).toBeDefined();
		expect((await rowFor())?.metadata.passes).toBe(1);
	}, 30_000);

	// Recurrence: the 512-record drift-tracker eviction dropped the record of
	// a document the server still held, so a resync driven by the records
	// would skip it. The HEAD-move targets come from the clients' open
	// documents, so the document still heals before the return. #4503 made the
	// eviction half of that state unreachable (a held record is never evicted),
	// so the record is dropped through the tracker's own API to keep the case
	// the move must answer: held, no record, still on the wire.
	it("resyncs a held document whose drift record is gone", async () => {
		const held = Array.from(
			{ length: 513 },
			(_, i) => `src/f${String(i).padStart(3, "0")}.ts`,
		);
		const moved = held.slice(0, 20);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(moved.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const service = await lspService();
		const drift = (
			service as unknown as {
				documentDrift: {
					peek(file: string): unknown;
					forget(file: string): void;
				};
			}
		).documentDrift;
		// #4503: 513 held records no longer evict the oldest one, so the record
		// of a document the server holds survives the cap.
		expect(drift.peek(repo.file(held[0]!))).toBeDefined();
		// The state #4493 is about: a held document with no drift record at all.
		drift.forget(repo.file(held[0]!));
		expect(drift.peek(repo.file(held[0]!))).toBeUndefined();
		const s = session(repo, "s-evicted");
		const mark = (await wire(repo, held[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(moved.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		expect(await textSince(repo, mark, held[0]!)).toContain(
			textLine(repo, held[0]!),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { changed: 20, held: 20, resynced: 20, deferred: 0 },
		});
	}, 120_000);

	// Recurrence: #4528 r4. The HEAD-move resync ran under the 500 ms
	// read-only bound, so a primary that read the move's changes slowly was
	// cut and the tool_result returned before the moved bytes were sent. CI's
	// shuffle seed 202 hit it with 24 live clients; here the primary pays
	// 120 ms a change on 120 KB fillers, so the phase outlasts 500 ms on any
	// host, and the move must still be on the wire when the result returns.
	it("sends every moved held document before the tool_result returns when the primary phase outlasts the read-only bound", async () => {
		const fillers = Array.from(
			{ length: 10 },
			(_, i) => `lib/h${String(i).padStart(2, "0")}.ts`,
		);
		const big = (tag: string) =>
			`export const s = ${JSON.stringify(tag.repeat(120 * 1024))};\n`;
		const repo = await makeRepo(
			{
				"lib/types.ts": TYPES_A,
				...Object.fromEntries(fillers.map((name) => [name, big("a")])),
			},
			{
				"lib/types.ts": TYPES_B,
				...Object.fromEntries(fillers.map((name) => [name, big("b")])),
			},
			[],
			{ FAKE_LSP_CHANGE_COST_MS: "120" },
		);
		const moved = [...fillers, "lib/types.ts"];
		await hold(repo, moved);
		const service = await lspService();
		const s = session(repo, "s-4528-r4-cut");

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(moved.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]).toMatchObject({
			metadata: { changed: 11, resynced: 11, deferred: 0, drained: true },
		});
	}, 120_000);

	// Recurrence: an unbounded drain would hold the hook for a branch hop of
	// any size. The forced passes stop at 64 documents, and the one row
	// states how many the drain left to the paced heartbeat.
	it("states in the one row how many held documents the drain cap deferred", async () => {
		const held = Array.from(
			{ length: 70 },
			(_, i) => `src/g${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(held.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const move = {
			root: repo.dir,
			key: headRecordKey("cap", "s-cap"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(move);

		repo.git("checkout", "-q", "B");
		await resyncHeadMove(move);

		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "changed:70",
			metadata: {
				changed: 70,
				held: 70,
				primary: 64,
				resynced: 64,
				deferred: 6,
			},
		});
	}, 120_000);

	// Recurrence: queued targets are resent unconditionally, so every agent
	// `git commit` (a HEAD move whose files the server already holds) would
	// resend each committed held document and its importers.
	it("resends nothing when the move leaves the held bytes current, as a commit does", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		fs.writeFileSync(repo.file("lib/types.ts"), TYPES_B);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-commit");
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git commit -qam types", () =>
			repo.git("commit", "-qam", "types"),
		);

		expect(await textSince(repo, mark, "main.ts")).toEqual([]);
		const rows = await settledHeadMovedRows(repo, 1, "HEAD");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "changed:1",
			metadata: { held: 1, current: 1, resynced: 0 },
		});
	}, 30_000);

	// Recurrence: a session's parallel bash calls look concurrently. A look
	// that saw no move (its sibling's look claimed it) returned at once, while
	// the sibling was still resending, so that tool_result came back with the
	// held document stale. Looks of one session run one at a time, and a look
	// arriving mid-flight returns only after the flight's resync.
	it("returns no concurrent look of a session before the move's resync is sent", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const service = await lspService();
		const look = {
			root: repo.dir,
			key: headRecordKey("race", "s-race"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(look);
		repo.git("checkout", "-q", "B");

		const first = await Promise.race([
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
		]);

		expect(first).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: a failed or truncated `git diff` read as an empty delta would
	// report "nothing changed" for a move whose documents stayed stale. The
	// row says the delta is unknown instead (an old HEAD a gc pruned, here a
	// commit id the repository never had).
	it("states delta-unknown and resends the held documents that differ from disk when the old HEAD cannot be diffed", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const move = {
			root: repo.dir,
			key: headRecordKey("gone", "s-gone"),
			trigger: "tool_call" as const,
			label: "read",
		};
		observeGitHead(move.key, "c".repeat(40));
		repo.git("checkout", "-q", "B");

		const service = await lspService();

		await resyncHeadMove(move);

		// Review r1 F6 (shape 48): the delta is unknown but the held set is
		// not, so the held documents whose bytes differ from disk are resent.
		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		await expect.poll(async () => (await headMovedRows(repo)).length).toBe(1);
		expect((await headMovedRows(repo))[0]).toMatchObject({
			result: "delta-unknown",
			metadata: { changed: -1, held: 1 },
		});
	}, 30_000);

	// Recurrence: a shared record would let one session's observation answer
	// for another's; each session keeps its own HEAD record, so a concurrent
	// session sees the move at its own next call. The two sessions share one
	// coordinator, as in index.ts, so only the session id tells them apart.
	it("keeps one HEAD record per session: a second session sees the move at its own call", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const primary = session(repo, "s-primary");
		const secondary = session(repo, "s-secondary", primary.runtime);
		await secondary.bash("true", () => {});

		await primary.bash("git checkout B", () => repo.git("checkout", "-q", "B"));
		await secondary.read(repo.file("main.ts"));

		const rows = await settledHeadMovedRows(repo, 2);
		expect(rows.map((row) => row.metadata.trigger)).toEqual([
			"tool_result",
			"tool_call",
		]);
	}, 30_000);

	// Recurrence: pi runs the bash calls of one message in parallel, so every
	// tool_call precedes the first tool_result. One move is one row.
	it("records one move once when parallel bash calls share it", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-parallel");
		const first = await s.bashCall("git checkout B");
		const second = await s.bashCall("ls");
		repo.git("checkout", "-q", "B");

		await first();
		await second();

		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);
});

describe("the per-session HEAD records (#4493)", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);

	// Recurrence: a record per (slot, session) grows with every cwd and every
	// session a long-lived process sees; the store is capped at 64, and a
	// session that keeps looking keeps its record while idle ones age out.
	it("keeps 64 records, refreshing the one a session observes again", () => {
		for (let i = 0; i < 64; i++) observeGitHead(`k${i}`, A);
		observeGitHead("k0", A);
		observeGitHead("k64", A);

		// k0 was refreshed, so it still reports the move; k1 was the oldest and
		// went, so its next look is a first sight, not a move.
		expect(observeGitHead("k0", B)).toBe(A);
		expect(observeGitHead("k1", B)).toBeUndefined();
	});
});

describe("opaque recovery from a subdirectory (#4493 residual 3)", () => {
	// Recurrence: `git status --porcelain` prints paths relative to the
	// repository root, and recovery resolved them against the session's cwd:
	// from a subdirectory every dirty path pointed below itself and was
	// dropped as vanished, so an opaque write there resynced nothing.
	it("recovers a dirty path when the cwd is a subdirectory of the repository", async () => {
		const repo = await makeRepo(
			{ "sub/x.ts": "export const x = 0;\n" },
			{ "sub/x.ts": "export const x = 1;\n" },
		);
		const startedAt = Date.now();
		fs.writeFileSync(repo.file("sub/x.ts"), "export const x = 2;\n");

		const outcome = await recoverOpaqueChangesViaGit(
			repo.file("sub"),
			startedAt,
		);

		expect(outcome.paths).toEqual([normalizeMapKey(repo.file("sub/x.ts"))]);
	}, 30_000);

	// Recurrence: a linked worktree's `.git` is a file, not a directory with a
	// HEAD; a path base that read only the directory form put every linked
	// worktree back on the cwd and dropped its subdirectory paths again.
	it("recovers a dirty path when the cwd is a subdirectory of a linked worktree", async () => {
		const repo = await makeRepo(
			{ "sub/x.ts": "export const x = 0;\n" },
			{ "sub/x.ts": "export const x = 1;\n" },
		);
		const linked = `${repo.dir}-linked`;
		repo.git("worktree", "add", "-q", linked, "B");
		const startedAt = Date.now();
		fs.writeFileSync(path.join(linked, "sub/x.ts"), "export const x = 2;\n");

		const outcome = await recoverOpaqueChangesViaGit(
			path.join(linked, "sub"),
			startedAt,
		);

		expect(outcome.paths).toEqual([
			normalizeMapKey(path.join(linked, "sub/x.ts")),
		]);
	}, 30_000);
});

/** The bash_write_primary_resync rows of `repo` (#4507). */
async function primaryResyncRows(repo: Repo) {
	return (await phaseRows("bash_write_primary_resync")).filter((row) =>
		row.filePath.includes(repo.dir),
	) as unknown as Array<{
		result: string;
		filePath: string;
		metadata: Record<string, unknown>;
	}>;
}

describe("a bash command's writes reach the primaries before its dispatches (#4507)", () => {
	// a.ts imports a name the same command adds to z.ts. The checker profile
	// models TypeScript 7's closed-file view: a.ts is checked against the z.ts
	// bytes the server holds.
	const A0 =
		'import { isChatModel } from "./z";\nexport const v = isChatModel(1);\n';
	const A1 =
		'import { isChatModelConfig } from "./z";\nexport const v = isChatModelConfig(1);\n';
	const CHECKER = { FAKE_LSP_CLOSED_FILE_CACHE: "1" };
	// makeRepo's branch B must change something; these cases never check it out.
	const NOTES_A = { "notes.txt": "a\n" };
	const NOTES_B = { "notes.txt": "b\n" };

	// Recurrence: #4507. The command's files were dispatched one at a time, so
	// a.ts (first) was checked while the server still held z.ts's old bytes and
	// the result STOPped on an export the same command had just added.
	it("checks a dependent the command rewrote against its rewritten dependency", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4507-sed");
		const service = await lspService();

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(text).not.toContain("STOP");
		expect(sentDiskBytes(service, repo, "z.ts")).toBe(true);
		expect(sentDiskBytes(service, repo, "a.ts")).toBe(true);
		expect(await primaryResyncRows(repo)).toMatchObject([
			{
				result: "sent",
				metadata: { written: 2, opaque: 0, targets: 2, primary: 2 },
			},
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F2. A codemode script's bash is a nested call
	// (parentToolCallId on both events); nothing may key the primary phase on
	// a top-level call, or a nested sed brings the phantom STOP back.
	it("checks a dependent a nested bash rewrote against its rewritten dependency", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4528-nested", undefined, "codemode-1");

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "sent", metadata: { written: 2, targets: 2, primary: 2 } },
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F1. The 500 ms bound cut the primary phase while it
	// was still sending, and the dispatch loop then checked a.ts before z.ts's
	// new bytes were on the wire: the #4507 phantom STOP under load. Here the
	// primary reads its input slowly (each didChange of a 120 KB filler costs
	// it 120 ms), so the phase outlasts 500 ms on any host.
	it.each([
		["push", {}],
		["pull", { FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" }],
	] as const)(
		"checks a dependent against its rewritten dependency when the primary phase outlasts the read-only bound (%s diagnostics)",
		async (mode, diagnostics) => {
			const fillers = Array.from(
				{ length: 10 },
				(_, i) => `f${String(i).padStart(2, "0")}.ts`,
			);
			const big = (tag: string) =>
				`export const s = ${JSON.stringify(tag.repeat(120 * 1024))};\n`;
			const repo = await makeRepo(
				{
					"z.ts": TYPES_A,
					"a.ts": A0,
					...Object.fromEntries(fillers.map((name) => [name, big("a")])),
					...NOTES_A,
				},
				NOTES_B,
				[],
				{ ...CHECKER, FAKE_LSP_CHANGE_COST_MS: "120", ...diagnostics },
			);
			const order = ["a.ts", ...fillers, "z.ts"];
			await hold(repo, order);
			const s = session(repo, `s-4528-cut-${mode}`);
			const mark = traceLines(repo).length;

			const text = await s.bash(`sed -i s/a/b/ ${order.join(" ")}`, () => {
				fs.writeFileSync(repo.file("a.ts"), A1);
				for (const name of fillers) fs.writeFileSync(repo.file(name), big("b"));
				fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			});

			expect(text).not.toContain("no exported member");
			if (mode === "pull") {
				// The wire: a.ts's first pull came after z.ts's new bytes.
				const after = (await wire(repo, "z.ts")).slice(mark);
				const zSent = after.indexOf(textLine(repo, "z.ts"));
				const aPull = `recv textDocument/diagnostic ${pathToFileURL(repo.file("a.ts")).href}`;
				expect(zSent).toBeGreaterThanOrEqual(0);
				expect(after.indexOf(aPull)).toBeGreaterThan(zSent);
			}
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "sent", metadata: { targets: 12, primary: 12 } },
			]);
		},
		120_000,
	);

	// Recurrence: #4528 r1 F1, the second half. A send resolves once its bytes
	// are in the pipe, not once the server read them. This primary reads its
	// input at once and works through it slowly (150 ms a change), republishing
	// every open document after each change, so right after the sends it is
	// still publishing a.ts checked against z.ts's old bytes. The phase ends
	// with a request each server answers only after the sends before it.
	it("checks a dependent against its rewritten dependency while the primary is still working through the command's sends", async () => {
		const fillers = Array.from(
			{ length: 8 },
			(_, i) => `g${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			{
				"z.ts": TYPES_A,
				"a.ts": A0,
				...Object.fromEntries(
					fillers.map((name) => [name, "export const v = 0;\n"]),
				),
				...NOTES_A,
			},
			NOTES_B,
			[],
			{
				...CHECKER,
				FAKE_LSP_NOTIFY_BACKLOG_WEDGE: "100000",
				FAKE_LSP_NOTIFY_COST_MS: "0",
				FAKE_LSP_CHANGE_COST_MS: "150",
			},
		);
		const order = ["a.ts", ...fillers, "z.ts"];
		await hold(repo, order);
		const s = session(repo, "s-4528-backlog");

		const text = await s.bash(`sed -i s/0/1/ ${order.join(" ")}`, () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			for (const name of fillers)
				fs.writeFileSync(repo.file(name), "export const v = 1;\n");
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "sent", metadata: { targets: 10, primary: 10 } },
		]);
	}, 120_000);

	// Recurrence: #4528 r2, a ping overtakes didChange on a threaded primary.
	it.each(["threaded", "unmeasured"] as const)(
		"records undrained when %s replies overtake queued changes",
		async (ordering) => {
			const repo = await makeRepo(
				{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
				NOTES_B,
				[],
				{
					...CHECKER,
					FAKE_LSP_NOTIFY_BACKLOG_WEDGE: "100000",
					FAKE_LSP_NOTIFY_COST_MS: "0",
					FAKE_LSP_PING_OVERTAKES: "1",
				},
			);
			primaryOrdering.set(repo.dir, ordering);
			await hold(repo, ["a.ts", "z.ts"]);
			const s = session(repo, `s-4528-${ordering}`);
			await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
				fs.writeFileSync(repo.file("a.ts"), A1);
				fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			});
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "undrained", metadata: { targets: 2 } },
			]);
		},
		60_000,
	);

	// Recurrence: the degraded half of #4528 r1 F1. A primary that never
	// answers the drain request (here it dies on reading the first new bytes) may
	// still be serving checks from before the sends; that must be on record,
	// and no check may read clean.
	it("records an undrained phase and reads nothing clean when the primary dies before answering the drain request", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			{ ...CHECKER, FAKE_LSP_EXIT_ON_CHANGE_TEXT: "isChatModelConfig" },
		);
		await hold(repo, ["a.ts", "z.ts"]);
		const s = session(repo, "s-4528-undrained");

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "undrained", metadata: { targets: 2 } },
		]);
		expect(text).not.toContain("JavaScript/TypeScript clean");
	}, 60_000);

	// Recurrence: #4507's opaque half. An unrecognized command's dirty paths
	// were resent to the servers detached, after the dispatch loop had already
	// checked them one at a time.
	it("sends an opaque command's held writes to the primaries before its result returns", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4507-opaque");
		const service = await lspService();

		await s.bash("node codemod.mjs", () => {
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			fs.writeFileSync(repo.file("a.ts"), A1);
		});

		expect(sentDiskBytes(service, repo, "z.ts")).toBe(true);
		expect(sentDiskBytes(service, repo, "a.ts")).toBe(true);
		expect(await primaryResyncRows(repo)).toMatchObject([
			{
				result: "sent",
				metadata: { written: 2, opaque: 2, targets: 2, primary: 2 },
			},
		]);
	}, 60_000);

	// Recurrence: #4493 r1 F1's shape on the bash-write path. Awaiting every
	// holding server would wait out a slow auxiliary and the hook bound would
	// cut the phase; only the primaries are awaited.
	it("sends every written held document to the primary before the result returns, however slow the auxiliary", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/w${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			{
				...Object.fromEntries(
					names.map((name) => [name, "export const v = 0;\n"]),
				),
				...NOTES_A,
			},
			NOTES_B,
		);
		try {
			await holdWithAuxiliary(repo, names, 250);
			const s = session(repo, "s-4507-slow-aux");
			const service = await lspService();

			await s.bash("node codemod.mjs", () => {
				for (const name of names)
					fs.writeFileSync(repo.file(name), "export const v = 1;\n");
			});

			expect(
				names.filter((name) => !sentDiskBytes(service, repo, name)),
			).toEqual([]);
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "sent", metadata: { opaque: 12, targets: 12, primary: 12 } },
			]);
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 90_000);

	// Recurrence: the phase must not open documents no server holds (a write
	// to an unheld file is the dispatch's to open), nor log a row for them.
	it("sends nothing and logs no row when no server holds a written file", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
		);
		const s = session(repo, "s-4507-unheld");

		await s.bash("node codemod.mjs", () => {
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(await primaryResyncRows(repo)).toEqual([]);
	}, 60_000);
});

/** The `lsp_diagnostics` tool's answer for `file`, as the model reads it. */
async function diagnose(repo: Repo, file: string): Promise<string> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4476",
		{ paths: [file], serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: repo.dir },
	)) as { content: Array<{ text?: string }> };
	return result.content.map((part) => String(part.text ?? "")).join("\n");
}

/** How many times a fake server was initialized for `repo`. */
const initializeCount = (repo: Repo) =>
	traceLines(repo).filter((line) => line === "recv initialize").length;

/** The lsp_out_of_band_change rows of `repo` (#4476). */
async function outOfBandRows(repo: Repo) {
	return (await phaseRows("lsp_out_of_band_change")).filter(
		(row) => row.filePath === repo.dir,
	) as unknown as Array<{ result: string; metadata: Record<string, unknown> }>;
}

describe("a change pi-lens sees only on disk reaches the servers and the cache (#4476)", () => {
	// The checker profile models TypeScript 7's native server: a closed file's
	// view is what it first read, until an exact-URI watched-files event or a
	// restart. `G_*` names need an ambient declaration; `dep` resolves to
	// node_modules/dep/index.d.ts.
	const CHECKER = { FAKE_LSP_CLOSED_FILE_CACHE: "1" };
	const IGNORE = { ".gitignore": ".pi-lens/\ngen/\nnode_modules/\n" };
	const NOTES = [{ "notes.txt": "a\n" }, { "notes.txt": "b\n" }] as const;
	const USES_G = "export const n: number = G_FOO;\n";
	const USES_DEP = 'import type { Cfg2 } from "dep";\nexport type T = Cfg2;\n';
	let previousLookMs: string | undefined;
	beforeAll(() => {
		// Every tool_call look walks: the interval is pinned in its own case.
		previousLookMs = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	});
	afterAll(() => {
		if (previousLookMs === undefined)
			delete process.env.PI_LENS_DECLARATION_LOOK_MS;
		else process.env.PI_LENS_DECLARATION_LOOK_MS = previousLookMs;
	});

	// Recurrence: #4476 R1. A command wrote a declaration file into a gitignored
	// directory (codegen); no tool result names it, so the server never re-read
	// it and the cache kept serving the importer's old finding.
	it("clears a finding when a bash command creates the ambient declaration in a gitignored directory", async () => {
		const repo = await makeRepo(
			{ ...IGNORE, "a.ts": USES_G, ...NOTES[0] },
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-create");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"Cannot find name 'G_FOO'",
		);

		await s.bash("node gen.mjs", () => {
			fs.mkdirSync(repo.file("gen"));
			fs.writeFileSync(
				repo.file("gen/globals.d.ts"),
				"declare const G_FOO: number;\n",
			);
		});

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"Cannot find name",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{
				result: "declarations",
				metadata: {
					trigger: "tool_result",
					created: 1,
					changed: 0,
					deleted: 0,
				},
			},
		]);
	}, 60_000);

	// Recurrence: #4476 with #4507's shape. A command that generates a
	// declaration and rewrites a file using it: the file's dispatch follows the
	// look at once, so the watched-files event must be on the wire before it,
	// not after the debounce window.
	it.each([
		["push", CHECKER],
		["pull", { ...CHECKER, FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" }],
	] as const)(
		"checks a file the same command rewrote against the declaration it generated (%s diagnostics)",
		async (_mode, profile) => {
			const repo = await makeRepo(
				{ ...IGNORE, "a.ts": "export const n: number = 1;\n", ...NOTES[0] },
				NOTES[1],
				[],
				profile,
			);
			await hold(repo, ["a.ts"]);
			const s = session(repo, "s-4476-same-command");

			const text = await s.bash("sed -i s/1/G_FOO/ a.ts", () => {
				fs.mkdirSync(repo.file("gen"));
				fs.writeFileSync(
					repo.file("gen/globals.d.ts"),
					"declare const G_FOO: number;\n",
				);
				fs.writeFileSync(repo.file("a.ts"), USES_G);
			});

			expect(text).not.toContain("Cannot find name");
			expect(text).not.toContain("STOP");
		},
		60_000,
	);

	// Recurrence: #4476 R2, edit and delete. An ambient declaration changed
	// outside pi kept its old view on the server, and a clean cache entry kept
	// answering clean for a file that no longer compiles.
	const edit = (file: string) =>
		fs.writeFileSync(file, "declare const G_BAR: number;\n");
	const remove = (file: string) => fs.rmSync(file);
	const PULL = { ...CHECKER, FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" };
	it.each([
		["edited", "push", edit, { changed: 1 }, CHECKER],
		["deleted", "push", remove, { deleted: 1 }, CHECKER],
		["edited", "pull", edit, { changed: 1 }, PULL],
	] as const)(
		"reports the finding when the ambient declaration is %s outside pi, at the next tool_call (%s diagnostics)",
		async (_label, mode, change, counts, profile) => {
			const repo = await makeRepo(
				{
					"a.ts": USES_G,
					"types/globals.d.ts": "declare const G_FOO: number;\n",
					...NOTES[0],
				},
				NOTES[1],
				[],
				profile,
			);
			const s = session(repo, `s-4476-${_label}-${mode}`);
			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"Cannot find name",
			);
			await s.read(repo.file("a.ts"));

			change(repo.file("types/globals.d.ts"));
			await s.read(repo.file("a.ts"));

			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"Cannot find name 'G_FOO'",
			);
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "declarations",
					metadata: { trigger: "tool_call", ...counts },
				},
			]);
		},
		60_000,
	);

	// Recurrence: #4476 R2 for a finding. An edit outside pi that declares the
	// missing name: the cached finding names the server that reported it, and
	// a change seen on disk names none, so it must count for every server.
	it("clears a finding when the ambient declaration is edited outside pi to declare the name", async () => {
		const repo = await makeRepo(
			{
				"a.ts": USES_G,
				"types/globals.d.ts": "declare const G_BAR: number;\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-edit-fixes");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"Cannot find name 'G_FOO'",
		);
		await s.read(repo.file("a.ts"));

		fs.writeFileSync(
			repo.file("types/globals.d.ts"),
			"declare const G_FOO: number;\n",
		);
		await s.read(repo.file("a.ts"));

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"Cannot find name",
		);
	}, 60_000);

	// Recurrence: #4476's install comment. After `npm install` brought a
	// version with different types, the server kept the old declarations of
	// the closed dependency files for its whole life.
	it("restarts the server after a bash dependency install, so the dependent sees the new declarations", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"node_modules/.package-lock.json": '{"v":1}\n',
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		// Another project's server, live in the same service.
		const other = await makeRepo(
			{ "b.ts": "export {};\n", ...NOTES[0] },
			NOTES[1],
		);
		await hold(other, ["b.ts"]);
		try {
			// The repository's auxiliary scanner resolves no dependencies.
			await holdWithAuxiliary(repo, ["a.ts"], 0);
			const s = session(repo, "s-4476-install");
			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"has no exported member 'Cfg2'",
			);
			// A command that installs nothing restarts nothing.
			await s.bash("ls", () => {});
			expect(initializeCount(repo)).toBe(1);

			await s.bash("npm install dep@2", () => {
				fs.writeFileSync(
					repo.file("node_modules/dep/index.d.ts"),
					"export type Cfg2 = { b: number };\n",
				);
				fs.writeFileSync(
					repo.file("node_modules/.package-lock.json"),
					'{"v":2}\n',
				);
			});

			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"no exported member",
			);
			expect(initializeCount(repo)).toBe(2);
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "install",
					metadata: { trigger: "tool_result", restarted: 1 },
				},
			]);
			// Only the primary clients of the installed root restart.
			expect(initializeCount(other)).toBe(1);
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 60_000);

	// Recurrence: #4528 r1 F2. A codemode script's `npm install` is a nested
	// bash (parentToolCallId on both events); its result must look for the
	// install like a top-level one.
	it("restarts the server after a dependency install a nested bash ran", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"node_modules/.package-lock.json": '{"v":1}\n',
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4528-nested-install", undefined, "codemode-2");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"has no exported member 'Cfg2'",
		);
		await s.bash("ls", () => {});

		await s.bash("npm install dep@2", () => {
			fs.writeFileSync(
				repo.file("node_modules/dep/index.d.ts"),
				"export type Cfg2 = { b: number };\n",
			);
			fs.writeFileSync(
				repo.file("node_modules/.package-lock.json"),
				'{"v":2}\n',
			);
		});

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"no exported member",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{ result: "install", metadata: { trigger: "tool_result", restarted: 1 } },
		]);
	}, 60_000);

	// Recurrence: #4476 F5/F12. An install made outside pi is seen at the next
	// tool_call, and two sessions on one root share the server: the install
	// restarts it once, not once per session.
	it("restarts once at the next tool_call after an install outside pi, however many sessions look", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"pnpm-lock.yaml": "v: 1\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const first = session(repo, "s-4476-outside-1");
		const second = session(repo, "s-4476-outside-2");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"has no exported member 'Cfg2'",
		);
		await first.read(repo.file("a.ts"));
		await second.read(repo.file("a.ts"));

		fs.writeFileSync(
			repo.file("node_modules/dep/index.d.ts"),
			"export type Cfg2 = { b: number };\n",
		);
		fs.writeFileSync(repo.file("pnpm-lock.yaml"), "v: 2\n");
		await Promise.all([
			first.read(repo.file("a.ts")),
			second.read(repo.file("a.ts")),
		]);

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"no exported member",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{ result: "install", metadata: { trigger: "tool_call", restarted: 1 } },
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F3, refuted and pinned. The install moves the cache
	// clock, then the restart waits on the spawn gate (here behind another
	// root's restart, whose server ignores shutdown). A project-wide pull
	// started in that wait reads the old server's view, with a stamp newer
	// than the clock; the read after the restart must still not serve it.
	// (lsp_diagnostics' own per-file pulls take their leases through the same
	// gate, behind the restart, so they get the new server.)
	it("refuses an entry the old server answered while the restart waited for the spawn gate", async () => {
		const previousPull = process.env.PI_LENS_LSP_WORKSPACE_PULL;
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";
		try {
			const slow = await makeRepo(
				{
					...IGNORE,
					"b.ts": "export {};\n",
					"pnpm-lock.yaml": "v: 1\n",
					...NOTES[0],
				},
				NOTES[1],
				[],
				{ FAKE_LSP_IGNORE_SHUTDOWN: "1" },
			);
			const repo = await makeRepo(
				{
					...IGNORE,
					"a.ts": USES_DEP,
					"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
					"node_modules/.package-lock.json": '{"v":1}\n',
					...NOTES[0],
				},
				NOTES[1],
				[],
				{
					...CHECKER,
					FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0",
					FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1",
				},
			);
			await hold(slow, ["b.ts"]);
			const first = session(slow, "s-4528-f3-slow");
			const second = session(repo, "s-4528-f3");
			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"has no exported member 'Cfg2'",
			);
			await first.read(slow.file("b.ts"));
			await second.read(repo.file("a.ts"));

			fs.writeFileSync(slow.file("pnpm-lock.yaml"), "v: 2\n");
			fs.writeFileSync(
				repo.file("node_modules/dep/index.d.ts"),
				"export type Cfg2 = { b: number };\n",
			);
			fs.writeFileSync(
				repo.file("node_modules/.package-lock.json"),
				'{"v":2}\n',
			);
			// The slow root's restart holds the spawn gate through its shutdown.
			const slowLook = first.read(slow.file("b.ts"));
			await vi.waitFor(() =>
				expect(traceLines(slow)).toContain("recv shutdown"),
			);
			const clock = () =>
				workspaceFileCreatedAtFor(
					() => false,
					() => false,
				);
			const before = clock();
			const look = second.read(repo.file("a.ts"));
			await vi.waitFor(() => expect(clock()).toBeGreaterThan(before));
			// The install is noted; the restart waits behind the slow one.
			const service = await lspService();
			const sweep = async () =>
				JSON.stringify(
					(
						await service.runWorkspaceDiagnostics(repo.dir, {
							files: [repo.file("a.ts")],
						})
					).map((result) => result.diagnostics.map((d) => d.message)),
				);
			const during = await sweep();
			await Promise.all([slowLook, look]);
			// The hooks bound their looks; the restarts finish after them.
			await vi.waitFor(
				async () =>
					expect(await outOfBandRows(repo)).toMatchObject([
						{ result: "install", metadata: { restarted: 1 } },
					]),
				{ timeout: 15_000 },
			);

			expect(during).toContain("no exported member");
			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"no exported member",
			);
		} finally {
			if (previousPull === undefined)
				delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
			else process.env.PI_LENS_LSP_WORKSPACE_PULL = previousPull;
		}
	}, 60_000);

	// Recurrence: the walk's cost at every tool_call. Within the interval a
	// tool_call look reads the install stamps only; a bash result always walks.
	it("walks the declaration files at most once per interval at tool_calls, and at every bash result", async () => {
		const repo = await makeRepo(
			{
				"a.ts": USES_G,
				"types/globals.d.ts": "declare const G_FOO: number;\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-interval");
		process.env.PI_LENS_DECLARATION_LOOK_MS = "600000";
		try {
			await s.read(repo.file("a.ts"));
			fs.rmSync(repo.file("types/globals.d.ts"));
			await s.read(repo.file("a.ts"));
			expect(await outOfBandRows(repo)).toEqual([]);

			await s.bash("ls", () => {});
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "declarations",
					metadata: { trigger: "tool_result", deleted: 1 },
				},
			]);
		} finally {
			process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		}
	}, 60_000);

	// Recurrence: shape 10. A tree too large to walk must say so, never read as
	// "no declaration changed".
	it.each([
		[
			"directory",
			(repo: Repo) => {
				for (let i = 0; i < 4100; i++)
					fs.mkdirSync(repo.file(`gen/d${i}`), { recursive: true });
			},
		],
		[
			"file",
			(repo: Repo) => {
				fs.mkdirSync(repo.file("gen"));
				for (let i = 0; i < 2100; i++)
					fs.writeFileSync(repo.file(`gen/t${i}.d.ts`), "export {};\n");
			},
		],
	] as const)(
		"records one degradation when the walk passes its %s cap",
		async (label, grow) => {
			// In a gitignored directory: the bash result dispatches none of them.
			const repo = await makeRepo(
				{ ...IGNORE, "a.ts": USES_G, ...NOTES[0] },
				NOTES[1],
			);
			grow(repo);
			const s = session(repo, `s-4476-cap-${label}`);
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			const capped = () =>
				getDegradationSummary()
					.find((group) => group.kind === "lsp-declaration-look-capped")
					?.latestReasons.filter((entry) =>
						entry.subject.includes(path.basename(repo.dir)),
					).length ?? 0;

			await s.read(repo.file("a.ts"));
			await s.bash("ls", () => {});

			expect(capped()).toBe(1);
			expect(await outOfBandRows(repo)).toEqual([]);
		},
		60_000,
	);
});
