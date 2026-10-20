/**
 * #3748 item 1, the pi host ADAPTER: `index.ts`'s `context` handler drains the
 * agent advisory queue for the scope its own activation serves.
 *
 * The recurrence this prevents: `consumeAgentNudge(dbg)` passing no scope. The
 * queue is drained per scope (`tests/clients/agent-advisory-scope.test.ts`),
 * so that call would silently stop delivering the primary's own advisory, such
 * as the #3741 fix-run loss notice, while every unit test stayed green.
 *
 * Real: the extension, its host-mock `session_start` and `context` handlers,
 * and the `RuntimeCoordinator` `index.ts` owns, reached by observing the
 * `resetForSession` its session start performs. Nothing is faked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	queueAgentAdvisory,
	_resetAgentNudgeForTests,
} from "../clients/agent-nudge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir: string;

beforeEach(() => {
	// The process primary registration, the advisory queue and the scopes are
	// process-global. Clearing the lifecycle state per case keeps a primary left
	// by ANOTHER suite (same vitest worker) from turning this file's first start
	// into a declined secondary, which would make the two cases below assert
	// against a different classification than the one they name.
	_resetSessionLifecycleForTests();
	_resetAgentNudgeForTests();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3748-advisory-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
});

describe("pi context delivers the primary's own queued advisory (#3748)", () => {
	it("injects an advisory queued under the activation's session scope", async () => {
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		);
		const runtime = runtimes[0];
		expect(runtime).toBeDefined();
		queueAgentAdvisory("lost edit in a.rs", runtime.captureSessionGeneration());

		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, and
		// the delivery keeps it — dropping it would red here, not ship a
		// promptless request.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in a.rs");

		// Release the process primary, so the case below starts one of its own
		// rather than being declined behind a leaked registration.
		await pi.emit(
			"session_shutdown",
			{ reason: "quit" },
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		);
	});

	it("drains the requesting session's own scope after a concurrent start (#4631 F3)", async () => {
		// The window this closes: on pi 0.87+ the drain runs in
		// `context_with_system`, the LAST phase of the host's `emitContext`, after
		// every other extension's `context` handler has been awaited. `scope` is
		// activation-wide and `session_start` reassigns it, so a concurrent
		// in-process start (#473) landing in that window used to make the primary's
		// request drain the SECONDARY's scope: the primary's own advisory stayed
		// queued and never reached the model.
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-primary" }),
		);
		const primary = runtimes[0];
		expect(primary).toBeDefined();
		queueAgentAdvisory("lost edit in a.rs", primary.captureSessionGeneration());

		// The concurrent start. A DIFFERENT root makes the classification
		// unambiguous (#473: a subagent sharing the activation): the primary is
		// live, so this start is declined as a concurrent-secondary and its own
		// scope REPLACES the activation-wide `scope`. Asserted, so a state change
		// that admitted it as a replacement start cannot quietly retarget the
		// case: an admitted start retires the primary's scope, which is a
		// different scenario (the session really ended).
		const secondaryCwd = path.join(tmpDir, "secondary-root");
		fs.mkdirSync(secondaryCwd, { recursive: true });
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: secondaryCwd, sessionId: "pi-3748-secondary" }),
		);
		expect(runtimes).toHaveLength(1);

		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-primary" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, and
		// the delivery keeps it — dropping it would red here, not ship a
		// promptless request.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in a.rs");
	});

	it("drains the activation-wide scope when this activation never recorded the requesting session (#4631 F3 fallback)", async () => {
		// #4631 round 6 (R6-2): the OTHER arm of the same drain. The lookup
		// (`liveSessionMembers.find(...)`) answers for a session this activation
		// started; when the request names a session it never recorded, the
		// activation-wide `scope` is the only identity left and the fallback
		// carries it. Without one of the two arms, a branch that returns
		// `undefined` here would silently stop delivering and every case above
		// would stay green.
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-recorded" }),
		);
		const recorded = runtimes[0];
		expect(recorded).toBeDefined();
		queueAgentAdvisory(
			"lost edit in b.rs",
			recorded.captureSessionGeneration(),
		);

		// The request's own session id is NOT in `liveSessionMembers`: no
		// `session_start` in this activation carried it, so the lookup answers
		// nothing and the drain must fall back to the activation-wide scope.
		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-never-recorded" }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in b.rs");
	});
});
