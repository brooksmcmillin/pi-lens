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
 * TIER 2 (#4632 slice 3). This file used to drive pi's real
 * `ExtensionRunner.emitContext` with a transcript it built itself
 * (`requestTranscript()`), which pinned the host's post-processing of a RETURN
 * VALUE but not the request the model receives: the head, the mid-list message
 * and the placement were all this file's own objects. It now runs a real
 * `AgentSession` through `tests/support/pi-session.ts`, so every one of them —
 * the two-phase `emitContext`, the system head, the mid-list delta
 * `pi_lens_activate_tools` appends, the trailing user message — is pi's, and the
 * assertion is about the messages the PROVIDER got (#4632 acceptance 3). The
 * extension under test is the built `index.js` pi's own loader loads, not an
 * in-process factory.
 *
 * Both #4644 observables are pinned here, unchanged in meaning: the injected
 * payload reaches the model beside a mid-list system message without touching
 * the head or that message, and the `latency.log` rows name the hook that
 * delivered it and the message the prefix hash is anchored to.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotAdvisoryProvenance } from "../clients/advisory-provenance.js";
import { CacheManager } from "../clients/cache-manager.js";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import {
	fauxAssistantMessage,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";

const fixture = piSessionFixture();

/** The marker the injected finding carries, so its arrival is checkable. */
const FINDING_MARKER = "TESTFINDINGS_4631_XYZZY";

const sessionCwd = (name: string) => path.join(fixture.root, name, "proj");

/**
 * Seed the turn-end findings row the injector consumes (#4631's source), under
 * the session's own cwd — the key `consumeTurnEndFindings`
 * (`clients/runtime-context.ts`) reads it back by. The row is written by THIS
 * process and read by the LOADED copy, which is what the cache's layout and
 * the provenance carry allow: both sides resolve the same data directory from
 * the env `startPiSession` pinned (#4632 acceptance 3).
 */
function seedTurnEndFindings(cwd: string): void {
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

/** This process's latency sink: the loaded copy writes under the same pinned home. */
const latencyLogPath = () => path.join(getGlobalPiLensLogDir(), "latency.log");

/**
 * Every row the sink holds, drained first (shape 67). A case reads only the
 * window that opened after its own marker, so no sibling case's rows decide
 * an assertion. `flushAllNdjsonWriters` settles the LOADED copy's queue too:
 * the NDJSON writer map is process-global.
 */
async function latencyRows(): Promise<
	Array<{ phase?: string; metadata?: Record<string, unknown> }>
> {
	await flushAllNdjsonWriters();
	const read = readNdjsonRows<{
		phase?: string;
		metadata?: Record<string, unknown>;
	}>(latencyLogPath());
	// The old inline reader threw on a line it could not parse; a counted skip
	// keeps that strictness and names the count (#4699 F2).
	expect(read.skipped).toBe(0);
	return read.rows;
}

describe("#4631 a mid-list system message never changes the head", () => {
	it("keeps the system head byte-identical beside a mid-list system message", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: sessionCwd("witness-head"),
			// A QUICK start writes no `session-start-guidance`, so the baseline
			// turn below is genuinely quiet and the head it sends is the reference
			// the provider cached.
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage(
					fauxToolCall("pi_lens_activate_tools", {
						tools: ["ast_grep_search"],
					}),
				),
				fauxAssistantMessage("activation answer"),
				fauxAssistantMessage("injecting answer"),
			],
		});
		const { requests } = handle;

		// A turn that injects nothing: pi-lens answers `undefined` and the host
		// keeps its own list.
		await handle.prompt("first question");
		const quiet = requests.at(-1);
		if (!quiet) throw new Error("the quiet turn sent no request");
		expect(JSON.stringify(quiet)).not.toContain(FINDING_MARKER);

		// pi appends ONE system message announcing the tool delta, which is the
		// mid-list shape `restoreSystemMessages` folded into the head. The tool
		// call runs in the LOADED copy's registry: this file passes no factory.
		await handle.prompt("activate the search tool");
		const beforeInjection = requests.at(-1);
		if (!beforeInjection)
			throw new Error("the activation turn sent no request");
		const delta = beforeInjection.at(-1);
		if (delta?.role !== "system")
			throw new Error("the activation turn appended no system delta");
		const deltaIndex = beforeInjection.length - 1;

		seedTurnEndFindings(handle.cwd);
		await handle.prompt("keep working");
		const injecting = requests.at(-1);
		if (!injecting) throw new Error("the injecting turn sent no request");

		// The whole earlier transcript — head AND mid-list delta — is the
		// unchanged prefix, byte for byte.
		expect(JSON.stringify(injecting.slice(0, beforeInjection.length))).toBe(
			JSON.stringify(beforeInjection),
		);
		// The head is the bytes the provider cached on the quiet turn: key order
		// and values both count, because the provider hashes the serialized
		// message.
		expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(quiet[0]));
		// The mid-list system message keeps its own position and its own bytes:
		// nothing merged it into the head, and nothing deleted it.
		expect(injecting[deltaIndex]).toEqual(delta);
		// The payload lands, once, folded into the trailing user prompt (#3693's
		// placement rule: the last message here is a plain user prompt).
		expect(JSON.stringify(injecting).split(FINDING_MARKER)).toHaveLength(2);
		expect(JSON.stringify(injecting.at(-1))).toContain(FINDING_MARKER);
		expect(handle.errors).toEqual([]);
	});

	it("injects once per request through the full-transcript hook", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: sessionCwd("witness-once"),
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("injecting answer"),
				fauxAssistantMessage("third answer"),
			],
		});

		await handle.prompt("first question");
		seedTurnEndFindings(handle.cwd);
		await handle.prompt("second question");
		// The payload is consumed by that one request...
		expect(JSON.stringify(handle.requests.at(-1))).toContain(FINDING_MARKER);
		await handle.prompt("third question");
		// ...so the next request injects nothing: a host that emitted both
		// request hooks still injects once.
		expect(JSON.stringify(handle.requests.at(-1))).not.toContain(
			FINDING_MARKER,
		);
		expect(handle.requests).toHaveLength(3);
	});

	/**
	 * #4743 acceptance 3: the cell above with `--lens-retain-injections` on.
	 * The third request repeats the finding, so "not present" no longer holds;
	 * the intent does: the finding is consumed once and delivered as new once.
	 * It sits in the second prompt, where the second request put it, and the
	 * third request's record names no new delivery.
	 */
	it("with retained injections on, repeats the payload but consumes and delivers it once", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: sessionCwd("witness-once-retained"),
			startupMode: "quick",
			flags: new Map([["lens-retain-injections", true]]),
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("injecting answer"),
				fauxAssistantMessage("third answer"),
			],
		});

		const firstRow = (await latencyRows()).length;
		await handle.prompt("first question");
		seedTurnEndFindings(handle.cwd);
		await handle.prompt("second question");
		await handle.prompt("third question");
		expect(handle.requests).toHaveLength(3);
		const [, second, third] = handle.requests;
		const carrying = (request: typeof third) =>
			request.flatMap((message, index) =>
				JSON.stringify(message).includes(FINDING_MARKER) ? [index] : [],
			);
		// Once per request, and at the same message: the second prompt.
		expect(carrying(second)).toEqual([second.length - 1]);
		expect(carrying(third)).toEqual(carrying(second));
		expect(JSON.stringify(third).split(FINDING_MARKER)).toHaveLength(2);

		const rows = (await latencyRows()).slice(firstRow);
		// One consume of the record (`consumeTurnEndFindings` logs its decision).
		expect(
			rows.filter(
				(row) =>
					row.phase === "advisory_provenance_decision" &&
					row.metadata?.advisoryKind === "turn-end",
			),
		).toHaveLength(1);
		const contextRows = rows.filter((row) => row.phase === "cache_context");
		expect(contextRows.map((row) => row.metadata?.injectionOccurred)).toEqual([
			false,
			true,
			false,
		]);
		expect(contextRows[2]?.metadata?.retention).toMatchObject({
			reemitted: 1,
			retainedNew: false,
		});
	});

	/**
	 * The records #4631's diagnosis had to reconstruct by hand: which request hook
	 * delivered the observation, and which message the prefix hash was anchored
	 * to. Read back from the real `latency.log` the LOADED copy wrote, inside
	 * this case's own window so no sibling case's rows decide it.
	 */
	it("names the injecting hook and the message the prefix is anchored to", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: sessionCwd("witness-records"),
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("injecting answer"),
			],
		});

		const firstRow = (await latencyRows()).length;
		await handle.prompt("first question");
		seedTurnEndFindings(handle.cwd);
		await handle.prompt("second question");

		const rows = (await latencyRows()).slice(firstRow);
		expect(rows.length).toBeGreaterThan(0);
		const contextRow = rows
			.filter((row) => row.phase === "cache_context")
			.at(-1);
		expect(contextRow?.metadata?.injectionHook).toBe("context_with_system");
		expect(contextRow?.metadata?.injectionOccurred).toBe(true);

		const prefixRow = rows
			.filter((row) => row.phase === "cache_prefix_break")
			.at(-1);
		expect(prefixRow?.metadata?.firstMessageRole).toBe("system");
	});
});
