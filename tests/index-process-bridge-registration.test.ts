/**
 * #2437 — both `clients/read-bridge.ts` and `clients/mutation-bridge.ts` now
 * delegate their mount body to the shared `clients/process-bridge.ts`
 * helper. `tests/clients/{read,mutation}-bridge.test.ts` drive
 * `registerReadBridge`/`registerMutationBridge` with hand-built deps objects,
 * bypassing `index.ts`'s wiring entirely; this file drives the REAL
 * extension factory through pi's own loader (tier 1, #4632) so a regression in
 * how `index.ts` calls the shared helper (not just in the helper itself, or
 * in an isolated bridge module) is caught here.
 *
 * `registerReadBridge`/`registerMutationBridge` run synchronously inside the
 * factory's activation, unconditional on any session event — loading the built
 * extension is enough to trigger both. The mount reaches process-global
 * `globalThis[Symbol.for("pi-lens:…")]` keys, so a case reads the slot the
 * LOADED copy wrote, not a recording the test's own double kept.
 *
 * WHAT EACH CASE ASSERTS (#4632 slice 8, mode migrate-all):
 *
 * - `processing`: importing the built extension evaluates its module graph and
 *   mounts NOTHING; the mount is the host activation's (the `beforeAll` below),
 *   never an import side effect. The flags are read at module load, before any
 *   hook runs, so the case is order-free (#4699 F1: the capture this replaced
 *   was on the pi double, where nothing could run at import either way).
 * - `processing`: pi's loader runs the built factory, and that activation is
 *   what mounts both bridges (no session event is emitted at this tier, so a
 *   mount that waited for `session_start` would be absent).
 * - `shape`: the mounted slot's own contract — version 1, frozen table, a
 *   non-writable and non-configurable property.
 * - `processing`: a second activation of the built factory (its own host load,
 *   #473's re-activation / in-process secondary) is first-wins for both slots.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
	getMutationBridge,
	MUTATION_BRIDGE_KEY,
} from "../clients/mutation-bridge.js";
import { READ_BRIDGE_KEY } from "../clients/read-bridge.js";
// The built extension's module graph, evaluated by this file's import and never
// activated: the host runs the factory only in `startPiRunner()` (#4699 F1).
import "../index.js";
import { startPiRunner, type PiRunner } from "./support/pi-runner.js";

let runner: PiRunner;

/**
 * The mount state at module load, read before `beforeAll` activates anything.
 * Evaluated once per file, so no case's order can decide it.
 */
const mountedAtImport = {
	read: READ_BRIDGE_KEY in (globalThis as object),
	mutation: MUTATION_BRIDGE_KEY in (globalThis as object),
};

beforeAll(async () => {
	// The real host loads the built extension; activation alone must mount both
	// bridges, because this tier emits no lifecycle event.
	runner = await startPiRunner();
});

describe("process-bridge registration through the real extension factory (#2437)", () => {
	it("importing the built extension mounts neither bridge; the host's activation mounts both", () => {
		// `processing`: evaluating index.js ran no activation, so neither slot was
		// written. This is the load-time half of the claim the four cases below
		// carry from the other side: a mount moved to module scope (a
		// `registerReadBridge` call at a module tail, an import-time side effect)
		// reds HERE and nowhere else, because the others read after activation.
		expect(mountedAtImport).toEqual({ read: false, mutation: false });
		// And the activation that did happen (beforeAll) mounted both.
		expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(true);
		expect(MUTATION_BRIDGE_KEY in (globalThis as object)).toBe(true);
	});

	it("mounts the read bridge during the host's load, version 1, frozen", () => {
		// `processing`: the mount happened without a session_start, and pi
		// reported no handler error while the factory ran.
		expect(runner.errors).toEqual([]);

		expect(READ_BRIDGE_KEY in (globalThis as object)).toBe(true);
		const bridge = (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY] as
			| { version: number; recordRead: unknown }
			| undefined;
		// `shape`: what the shared helper installs at that key.
		expect(bridge?.version).toBe(1);
		expect(typeof bridge?.recordRead).toBe("function");
		expect(Object.isFrozen(bridge)).toBe(true);
	});

	it("mounts the mutation bridge through the shared helper, reachable through getMutationBridge", () => {
		expect(MUTATION_BRIDGE_KEY in (globalThis as object)).toBe(true);
		// `shape`: the reader the producer side documents resolves the mounted
		// table, which is the same slot activation wrote.
		const mounted = getMutationBridge();
		expect(mounted?.version).toBe(1);
		expect(typeof mounted?.recordMutation).toBe("function");
	});

	it("is first-wins across activations, same contract for both bridges", async () => {
		// `processing`: a second activation (a re-activation / secondary in-process
		// session, #473) must not replace either mount. The second load runs pi's
		// loader again, so the built factory activates a second time in this
		// process against its own module graph.
		const readBefore = (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY];
		const mutationBefore = getMutationBridge();
		expect(readBefore).toBeDefined();
		expect(mutationBefore).toBeDefined();

		const second = await startPiRunner();
		expect(second.errors).toEqual([]);

		expect((globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY]).toBe(
			readBefore,
		);
		expect(getMutationBridge()).toBe(mutationBefore);
	});

	it("the mounted properties are non-writable and non-configurable", () => {
		// `shape`: the mount is unreplaceable, which is what first-wins relies on.
		expect(() => {
			(globalThis as Record<symbol, unknown>)[MUTATION_BRIDGE_KEY] = {};
		}).toThrow(TypeError);
		expect(() => {
			delete (globalThis as Record<symbol, unknown>)[READ_BRIDGE_KEY];
		}).toThrow(TypeError);
	});
});
