/**
 * #4403 round 4 (N2): a cascade neighbour whose primary language server did not
 * answer gets one line naming the server and the cause, once per server per
 * session, through the real turn path (pi's `tool_result`, `turn_end` and the
 * next model `context`).
 *
 * Round 5 (V1) recurrence: the once-per-session mark was taken when a run
 * computed the line. Writing b.ts and then its neighbour a.ts in one turn made
 * turn_end drop b.ts's run as superseded, a.ts's run could no longer name the
 * server, and the line was lost for the session. The mark is now taken when
 * turn_end delivers the line.
 *
 * Recurrence: round 3 made a collecting touch with a disabled primary return a
 * verdict instead of nothing. The cascade's neighbour touch reads that verdict,
 * so a.ts and c.ts came back as "Cascade diagnostics inconclusive for 2
 * neighbor file(s)" with no cause, on every write, even when only an unrelated
 * alternate (deno) was disabled. A missing primary still dropped them silently.
 *
 * Language servers are the host boundary: each one's command is a project
 * override pointing at a shim that runs the shared fake server, which answers
 * every pull with no findings. A missing server's command points at a path
 * that does not exist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import { RUNTIME_CONFIG } from "../../clients/runtime-config.js";
import { makeSessionStartEvent } from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
const PREFIX = "pi-lens-4403-cascade-";
// The turn-end cap is read on every turn_end; the cases below lower it for
// one turn and restore it.
const turnEndCap = RUNTIME_CONFIG.turnEnd as { maxChars: number };

const FALLBACK_CAUSE =
	"it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting";
const cascadeLine = (ids: string, cause: string): string =>
	`⚠️ Cascade: no language server answered for neighbor files of ${ids} (${cause}), so their cross-file errors were not checked (not a clean result).`;

type Case = {
	name: string;
	typescript: "working" | "slow" | "disabled" | "missing";
	deno: "missing" | "disabled";
	/** The cascade lines the first turn shows; later turns show none. */
	firstTurn: string[];
};

const CASES: readonly Case[] = [
	{
		name: "typescript working",
		typescript: "working",
		deno: "disabled",
		firstTurn: [],
	},
	// Still starting when b.ts is written: the cascade defers a cold
	// server's neighbours (clients/lsp/cascade-tier.ts) rather than naming
	// it, so a session's first edit does not report a server that is only
	// warming up.
	{
		name: "typescript still starting",
		typescript: "slow",
		deno: "disabled",
		firstTurn: [],
	},
	{
		name: "typescript disabled, deno missing",
		typescript: "disabled",
		deno: "missing",
		firstTurn: [cascadeLine("deno, typescript", FALLBACK_CAUSE)],
	},
	{
		name: "typescript disabled, deno disabled",
		typescript: "disabled",
		deno: "disabled",
		// deno stands in only for a disabled typescript, so with both off
		// both are the file's disabled primaries.
		firstTurn: [
			cascadeLine(
				"typescript, deno",
				"it is disabled in config by lsp.disabledServers",
			),
		],
	},
	{
		name: "typescript missing, deno disabled",
		typescript: "missing",
		deno: "disabled",
		firstTurn: [
			cascadeLine(
				"typescript",
				"it could not be started, or was still starting",
			),
		],
	},
];

/**
 * a.ts and c.ts import b.ts, d.ts imports a.ts, and f.ts imports e.ts, which
 * nothing else touches. g.ts lacks the fake server's clean marker, so a
 * reporting typos (`typos: "reporting"`) gives it a blocker.
 */
const CLEAN = "// fake-lsp-clean\n";
const FILES: Record<string, (n: number) => string> = {
	a: (n) => `import { b } from "./b";\nexport const a = b + ${n};\n${CLEAN}`,
	b: (n) => `export const b = ${n};\n${CLEAN}`,
	c: (n) => `import { b } from "./b";\nexport const c = b + ${n};\n${CLEAN}`,
	d: (n) => `import { a } from "./a";\nexport const d = a + ${n};\n${CLEAN}`,
	e: (n) => `export const e = ${n};\n${CLEAN}`,
	f: (n) => `import { e } from "./e";\nexport const f = e + ${n};\n${CLEAN}`,
	g: (n) => `export const g = ${n};\n`,
};

/** One turn's writes, in order: a file name and the value it is given. */
type Turn = ReadonlyArray<readonly [name: string, n: number]>;

type Setup = Pick<Case, "name" | "typescript" | "deno"> & {
	/** typos answers a file without the clean marker with one error. */
	typos?: "reporting";
	/** `RUNTIME_CONFIG.turnEnd.maxChars` per turn; undefined keeps it. */
	maxChars?: ReadonlyArray<number | undefined>;
};

function makeWorkspace(testCase: Setup): string {
	const env = setupTestEnvironment(PREFIX);
	const workspace = fs.realpathSync(env.tmpDir);
	const shim = (serverId: string, delayMs = 0, reporting = false): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
				reporting ? "" : 'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	const missing = (serverId: string): string[] => [
		path.join(workspace, "missing", serverId),
		"--stdio",
	];
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4403-cascade","private":true}\n',
	);
	// #4560: the fixture root already carries the shared `.git` marker.
	fs.mkdirSync(path.join(workspace, ".pi-lens"));
	for (const [name, content] of Object.entries(FILES))
		fs.writeFileSync(path.join(workspace, `${name}.ts`), content(1));
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				typescript: {
					command:
						testCase.typescript === "missing"
							? missing("typescript-language-server")
							: shim("typescript", testCase.typescript === "slow" ? 8_000 : 0),
				},
				deno: { command: missing("deno") },
				typos: {
					command: shim("typos", 0, testCase.typos === "reporting"),
				},
				opengrep: { command: shim("opengrep") },
			},
			disabledServers: [
				"ast-grep",
				"zizmor",
				...(testCase.typescript === "disabled" ? ["typescript"] : []),
				...(testCase.deno === "disabled" ? ["deno"] : []),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start servers early.
			warmFiles: ["no-such-warm-file.ts"],
		}),
	);
	return workspace;
}

/** The cascade lines among what the next model context delivers. */
async function deliveredCascadeLines(
	pi: ReturnType<typeof createPiMock>,
	ctx: unknown,
): Promise<string[]> {
	const context = (await pi.emit(
		"context",
		{ messages: [{ role: "user", content: "continue" }] },
		ctx,
	)) as { messages?: Array<{ content: unknown }> } | undefined;
	return (context?.messages ?? [])
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: JSON.stringify(message.content),
		)
		.join("\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("Cascade"));
}

/**
 * Runs the turns through one session and returns the cascade lines each
 * turn's next model context delivers.
 */
async function runTurns(
	testCase: Setup,
	turns: readonly Turn[],
): Promise<string[][]> {
	const workspace = makeWorkspace(testCase);
	const savedConfigPath = process.env.PI_LENS_CONFIG_PATH;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
	const configPath = path.join(workspace, "global-config.json");
	fs.writeFileSync(configPath, "{}\n");
	process.env.PI_LENS_CONFIG_PATH = configPath;
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	let shutdown: (() => Promise<unknown>) | undefined;
	const savedMaxChars = turnEndCap.maxChars;
	try {
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const { default: extension } = await import("../../index.js");
		const pi = createPiMock({});
		extension(pi.asExtensionAPI());
		// The command overrides are project config (#4248).
		const ctx = makeCtx({
			cwd: workspace,
			sessionId: `cascade-4403-${testCase.name}`,
			isProjectTrusted: true,
		});
		resetLSPService();
		getLSPService();
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		shutdown = () => pi.emit("session_shutdown", { reason: "quit" }, ctx);
		const write = async (name: string, n: number): Promise<void> => {
			const target = path.join(workspace, `${name}.ts`);
			fs.writeFileSync(target, FILES[name](n));
			await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: target, content: fs.readFileSync(target, "utf8") },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx,
			);
		};
		const delivered: string[][] = [];
		for (const [index, writes] of turns.entries()) {
			turnEndCap.maxChars = testCase.maxChars?.[index] ?? savedMaxChars;
			await pi.emit("turn_start", {}, ctx);
			for (const [name, n] of writes) await write(name, n);
			await pi.emit("turn_end", {}, ctx);
			delivered.push(await deliveredCascadeLines(pi, ctx));
		}
		return delivered;
	} finally {
		// Also after a failed assertion, so the next case starts a new session.
		turnEndCap.maxChars = savedMaxChars;
		await shutdown?.();
		await getLSPService().shutdown();
		resetLSPService();
		if (savedConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	}
}

const UNSTARTED_LINE = cascadeLine(
	"typescript",
	"it could not be started, or was still starting",
);

describe("a cascade neighbour no primary answered for (#4403 N2)", () => {
	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
	});

	for (const testCase of CASES) {
		it(`${testCase.name}: ${testCase.firstTurn.length > 0 ? "one cause-named line, then none" : "no cascade line"}`, async () => {
			// Two writes of b.ts in the first turn: the first run is
			// superseded at turn_end, so the line must ride the second.
			const turns = await runTurns(testCase, [
				[
					["b", 2],
					["b", 3],
				],
				[["b", 4]],
				[["b", 5]],
			]);
			expect(turns).toEqual([testCase.firstTurn, [], []]);
		}, 180_000);
	}

	// Round 5 (V1): the server is marked once the line is delivered, so a run
	// that turn_end drops does not use the line up, and two runs that name the
	// same server in one turn show it once. typescript missing, deno disabled.
	const SCRIPTS: ReadonlyArray<{
		name: string;
		firstTurn: Turn;
		expected: string[][];
	}> = [
		{
			// b.ts's run is superseded by the write of its neighbour a.ts, and
			// a.ts's own run (neighbour d.ts) carries the line.
			name: "b.ts, then its neighbour a.ts",
			firstTurn: [
				["b", 2],
				["a", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
		{
			// c.ts has no importers, so nothing carries the line in turn 1;
			// the server is not marked, and turn 2's run names it.
			name: "b.ts, then its neighbour c.ts, which nothing imports",
			firstTurn: [
				["b", 2],
				["c", 2],
			],
			expected: [[], [UNSTARTED_LINE], []],
		},
		{
			// Both runs survive turn_end and both name typescript.
			name: "b.ts and an unrelated e.ts",
			firstTurn: [
				["b", 2],
				["e", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
	];
	// Round 6 (W1): the line is committed when the section reaches the agent,
	// not when turn_end composes it. Recurrence: a mark taken at compose
	// would spend the line on a section the cap cut. g.ts's blocker leads
	// the message and the 40-char cap keeps only part of it, so the cascade
	// section is held; the empty turn 2 delivers the held run, with the line
	// at the head of the section.
	it("delivers the line once: a section the cap cut, then the next turn", async () => {
		const turns = await runTurns(
			{
				name: "cut section",
				typescript: "missing",
				deno: "disabled",
				typos: "reporting",
				maxChars: [40],
			},
			[
				[
					["g", 2],
					["b", 2],
				],
				[],
				[["b", 5]],
			],
		);
		// #4486: the held run no longer lists g.ts as a degraded-fallback
		// neighbour. Its cached typos finding was stored before b.ts's cascade
		// started, so it is not an observation after the edit (and g.ts's own
		// dispatch reports it). The section is the line alone.
		expect(turns).toEqual([[], [UNSTARTED_LINE], []]);
	}, 180_000);

	// Round 6 (W2): a cascade section that leads an over-long message counts
	// as delivered. Recurrence: the line sat after the impact header, so a cap
	// that cut inside it spent the line on a fragment. The kept lines now head
	// the section.
	it("delivers the line once: the cascade section leads and the cap cuts it", async () => {
		const turns = await runTurns(
			{
				name: "leading section",
				typescript: "missing",
				deno: "disabled",
				maxChars: [UNSTARTED_LINE.length + 5],
			},
			[[["b", 2]], [["b", 4]], [["b", 5]]],
		);
		expect(turns).toEqual([[UNSTARTED_LINE], [], []]);
	}, 180_000);

	for (const script of SCRIPTS) {
		it(`delivers the line once: ${script.name}`, async () => {
			const turns = await runTurns(
				{
					name: script.name,
					typescript: "missing",
					deno: "disabled",
				},
				[script.firstTurn, [["b", 4]], [["b", 5]]],
			);
			expect(turns).toEqual(script.expected);
		}, 180_000);
	}
});
