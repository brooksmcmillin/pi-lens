/**
 * Test-side stand-in for the one step production does before any state is kept
 * on a session's scope: `session_start` begins the scope and binds it to the
 * session's lookup key (`bindSessionId`, index.ts). A test that calls a
 * scope-cell store with an arbitrary session id begins and binds a real scope
 * first. The scopes are real; nothing here fakes the store.
 *
 * `retireBoundSessions` retires every scope this module began, which is how a
 * session's state ends in production (its scope retires).
 */

import {
	beginScope,
	bindSessionId,
	retireScope,
	type SessionScope,
	scopeOfSession,
	sessionLookupKey,
} from "../../clients/session-scope.js";

type Role = "primary" | "concurrent-secondary";

const begun: SessionScope[] = [];

/** Begin and bind the scope of `sessionId` (once per key until retired). */
export function bindSession(sessionId?: string, role?: Role): SessionScope {
	const key = sessionLookupKey(sessionId, role);
	const existing = scopeOfSession(key);
	if (existing) return existing;
	const scope = beginScope({
		role: role === "concurrent-secondary" ? "secondary" : "primary",
	});
	bindSessionId(scope, key);
	begun.push(scope);
	return scope;
}

export function retireBoundSessions(): void {
	for (const scope of begun.splice(0)) retireScope(scope, "test");
}
