/**
 * #4631 witness: on pi 0.87+ an injection must not rewrite the system head.
 *
 * Recurrence prevented: a `context` handler that returns a CHANGED list makes
 * pi's `restoreSystemMessages` rebuild one merged head from every system
 * message (`dist/core/extensions/runner.js`: `[getCurrentSystemMessage(current),
 * ...returned]`). A transcript carrying a mid-list system message — pi appends
 * one whenever prompt sections or tools change, which `pi_lens_activate_tools`
 * and a reload both do — therefore got a head whose text was the merge of both,
 * so the provider's cached prefix missed on every injecting turn. Reporter
 * evidence in #4631: 22.8k cacheRead on injecting turns against 212k+ without.
 *
 * The cases drive pi 1.3.0's REAL `ExtensionRunner` through the real
 * `AgentSessionRuntime` (as `tests/index-3521-fork-tree-witness.test.ts` does):
 * pi itself runs the extension factory, and `emitContext` is pi's own two-phase
 * request transform, not a hand-rolled stand-in for it. Nothing is mocked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import { snapshotAdvisoryProvenance } from "../clients/advisory-provenance.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./clients/test-utils.js";

const FLAGS = new Map<string, boolean>([
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
]);

const TMP_PREFIX = "pi-lens-4631-";
let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let cwd: string;
let agentDir: string;
let sessionsDir: string;
let previousDataDir: string | undefined;
const runtimes: AgentSessionRuntime[] = [];
const extensionErrors: unknown[] = [];

/** The marker the injected finding carries, so its arrival is checkable. */
const FINDING_MARKER = "TESTFINDINGS_4631_XYZZY";

beforeEach(() => {
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = env.tmpDir;
	cwd = path.join(root, "proj");
	agentDir = path.join(root, "agent");
	sessionsDir = path.join(root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(root, "data");
});

afterEach(async () => {
	try {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
		await drainBackgroundWritesForTests();
		expect(extensionErrors.splice(0)).toEqual([]);
	} finally {
		_resetSessionLifecycleForTests();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	}
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

async function startRuntime(): Promise<AgentSessionRuntime> {
	const runtime = await createAgentSessionRuntime(
		async ({
			cwd: runtimeCwd,
			sessionManager: sm,
			sessionStartEvent: event,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				extensionFlagValues: FLAGS,
				resourceLoaderOptions: { extensionFactories: [extension] },
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					sessionStartEvent: event,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
	);
	const bindings = { onError: (error: unknown) => extensionErrors.push(error) };
	runtime.setRebindSession(async () => {
		await runtime.session.bindExtensions(bindings);
	});
	await runtime.session.bindExtensions(bindings);
	runtimes.push(runtime);
	return runtime;
}

/**
 * A request transcript with a mid-list system message, exactly as pi builds one
 * after prompt sections or tools change: the leading system message carries the
 * prompt text, named sections and the eager tool declarations; a later system
 * message patches a section. Fresh objects per call, because the runner
 * `structuredClone`s its input.
 */
function requestTranscript(): Array<Record<string, unknown>> {
	return [
		{
			role: "system",
			content: "You are pi. PI-LENS BASE PROMPT",
			sections: { tone: "terse", "pi-lens": "base section" },
			toolsAdded: [
				{
					name: "eager_tool",
					description: "eagerly declared tool",
					parameters: { type: "object", properties: {} },
				},
			],
			timestamp: 1_700_000_000_000,
		},
		{ role: "user", content: "do the thing", timestamp: 1_700_000_001_000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: 1_700_000_002_000,
		},
		{
			role: "system",
			content: "UPDATED SYSTEM PROMPT SECTION: tools changed",
			sections: { tone: "verbose" },
			timestamp: 1_700_000_003_000,
		},
		{ role: "user", content: "keep working", timestamp: 1_700_000_004_000 },
	];
}

/** Seed the turn-end findings cache the `context` hook consumes (#4631's source). */
function seedTurnEndFindings(): void {
	const file = path.join(cwd, "unchanged.ts");
	fs.writeFileSync(file, "export const unchanged = true;\n");
	const provenance = snapshotAdvisoryProvenance({
		cwd,
		runtime: new RuntimeCoordinator(),
		generation: 1,
		files: [{ path: file, role: "affected" }],
	});
	new CacheManager().writeCache(
		"turn-end-findings",
		{ content: `${FINDING_MARKER} blocking finding`, provenance },
		cwd,
	);
}

async function request(
	runtime: AgentSessionRuntime,
): Promise<Array<Record<string, unknown>>> {
	return (await runtime.session.extensionRunner.emitContext(
		requestTranscript() as never,
	)) as unknown as Array<Record<string, unknown>>;
}

describe("#4631 a mid-list system message never changes the head", () => {
	it("keeps the system head byte-identical on an injecting turn", async () => {
		const runtime = await startRuntime();

		// A turn that injects nothing: pi-lens answers `undefined` and the host
		// keeps its own list, so this head is the reference the provider cached.
		const quiet = await request(runtime);
		const referenceHead = quiet[0];

		// The next request carries a real turn-end finding.
		seedTurnEndFindings();
		const injecting = await request(runtime);

		// The injected payload must actually reach the model on this turn.
		const flattened = JSON.stringify(injecting);
		expect(flattened).toContain(FINDING_MARKER);

		// ...and the head the provider sees first must be the same bytes it saw
		// before the injection: text, named sections, eager tool declarations.
		expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(referenceHead));
		expect(injecting[0]).toMatchObject({
			role: "system",
			content: "You are pi. PI-LENS BASE PROMPT",
			sections: { tone: "terse", "pi-lens": "base section" },
			toolsAdded: [expect.objectContaining({ name: "eager_tool" })],
		});

		// The mid-list system message keeps its own position and its own bytes:
		// nothing may merge it into the head, and nothing may delete it.
		expect(injecting[3]).toEqual(quiet[3]);
		expect(injecting[3]).toMatchObject({
			role: "system",
			content: "UPDATED SYSTEM PROMPT SECTION: tools changed",
			sections: { tone: "verbose" },
		});

		// Exactly one injection, folded into the trailing user prompt (#3693's
		// placement rule: the last message here is a plain user prompt).
		expect(flattened.split(FINDING_MARKER)).toHaveLength(2);
		expect(injecting).toHaveLength(requestTranscript().length);
		expect(String(injecting.at(-1)?.content)).toContain(FINDING_MARKER);
	});

	it("injects once per request through the full-transcript hook", async () => {
		const runtime = await startRuntime();
		seedTurnEndFindings();

		const first = await request(runtime);
		expect(JSON.stringify(first)).toContain(FINDING_MARKER);
		// The payload is consumed by that one request: the next request injects
		// nothing, so a host that emitted both request hooks still injects once.
		const second = await request(runtime);
		expect(JSON.stringify(second)).not.toContain(FINDING_MARKER);
	});

	/**
	 * The records #4631's diagnosis had to reconstruct by hand: which request hook
	 * delivered the observation, and which message the prefix hash was anchored
	 * to. Read back from the real `latency.log` the handler wrote.
	 */
	it("names the injecting hook and the message the prefix is anchored to", async () => {
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const runtime = await startRuntime();
			seedTurnEndFindings();
			await request(runtime);
			await flushLatencyLog();

			const rows = fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							phase?: string;
							metadata?: Record<string, unknown>;
						},
				);
			const contextRow = rows
				.filter((row) => row.phase === "cache_context")
				.at(-1);
			expect(contextRow?.metadata?.injectionHook).toBe("context_with_system");
			expect(contextRow?.metadata?.injectionOccurred).toBe(true);

			const prefixRow = rows
				.filter((row) => row.phase === "cache_prefix_break")
				.at(-1);
			expect(prefixRow?.metadata?.firstMessageRole).toBe("system");
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});
});
