/**
 * #4589 admission reasons: WHY each server-teardown baseline row is admitted.
 *
 * `test-server-teardown-baseline.ts` says which starts are not provably closed
 * and awaited. This file says why, one entry per admitted row, and the sweep
 * re-checks the claim against the file's own source with the detector's own
 * mechanism classifier. The split is AGENTS.md shape 38: a baseline row needs
 * a reason in a separate checked file, or a new leak is admitted by appending
 * one line.
 *
 * The mechanisms are the close evidence each row actually has:
 *
 * - `teardown`: the close sits in an `afterEach`/`afterAll` callback but its
 *   promise is never awaited;
 * - `finally`: the close sits in a `finally` but its promise is never
 *   awaited;
 * - `helper`: the close runs inside a closure the file returns to its caller
 *   (a handle), so the close's own invocation is outside the detector's reach;
 * - `none`: nothing in the file closes the started binding. These rows are
 *   real leaks the ratchet holds until a fix closes them.
 *
 * A row admitted as `teardown` cannot be admitted as `helper` or `finally`:
 * the mechanism is re-derived from the file, so the reason must name the
 * evidence that exists.
 */

import type { ServerTeardownMechanism } from "./test-server-teardown-gate.js";

/** Why one admitted start sits in the baseline. */
export interface ServerTeardownAdmission {
	mechanism: ServerTeardownMechanism;
	/** What closes the server, and why the detector cannot credit it. */
	reason: string;
}

export const TEST_SERVER_TEARDOWN_ADMISSIONS: Record<
	string,
	ServerTeardownAdmission
> = {
	"tests/clients/mcp/ipc.test.ts:activeServer": {
		mechanism: "teardown",
		reason:
			"the file-scope `afterEach` calls `activeServer.close()` (no callback, not awaited). Awaiting `close(cb)` with a peer socket still open would wait out the case budget, so the suite destroys the connections first and closes without awaiting; the close is the documented contract at warm-attach.test.ts's matching teardown.",
	},
	"tests/clients/warm-attach.test.ts:silent": {
		mechanism: "finally",
		reason:
			"the case closes the listener in its own `finally` (`silent.closeAllConnections?.()` then `silent.close()`), deliberately without awaiting: a still-open peer socket makes `close(cb)` wait out the whole test budget, as the comment there states.",
	},
	"tests/clients/warm-attach.test.ts:sessionA": {
		mechanism: "finally",
		reason:
			"the stub listener is a live incumbent for the ownership case and is closed in the case's `finally` after `closeAllConnections?.()`; awaiting the close callback would wait on the connection the case deliberately keeps open.",
	},
	"tests/mcp/analyze-cli.test.ts:server": {
		mechanism: "helper",
		reason:
			"both stubs close their listener through the record they return (`close: () => new Promise((done) => { ...; server.close(() => done()); })`), and every caller awaits `stub.close()` in its `afterEach`. The detector does not follow a handle across a return value, so the start is reported rather than credited.",
	},
};
