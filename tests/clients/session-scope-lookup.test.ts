/**
 * #4965 (shape 72): the lookup from a session's key to its live scope
 * (`bindSessionId`, `scopeOfSession`, `sessionCell`), through the real scope
 * records and the real degradation ledger.
 *
 * The recurrences these prevent: a store keyed by session id in a process
 * table, which a late call for a retired session re-created with no owner to
 * end it, and which a reused session id inherited (shape 72, #4554, #4564).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	beginScope,
	bindSessionId,
	retireScope,
	scopeCell,
	scopeOfSession,
	sessionCell,
	sessionLookupKey,
} from "../../clients/session-scope.js";

const live: Array<ReturnType<typeof beginScope>> = [];
const begin = (role: "primary" | "secondary" = "primary") => {
	const scope = beginScope({ role });
	live.push(scope);
	return scope;
};

beforeEach(() => resetDegradationLedger());
afterEach(() => {
	for (const scope of live.splice(0)) retireScope(scope, "test");
});

describe("session lookup key", () => {
	it("is the trimmed id when the host gave one, whatever the role", () => {
		expect(sessionLookupKey(" abc ", "primary")).toBe("abc");
		expect(sessionLookupKey("abc", "concurrent-secondary")).toBe("abc");
	});

	it("keeps roles apart when the host gave none, so a secondary cannot read the primary's state", () => {
		// RECURRENCE GUARDED: with no stable id a concurrent secondary overwrote the
		// primary's baseline (cache-observability, #473).
		const keys = [undefined, "", "  "].flatMap((id) => [
			sessionLookupKey(id, "primary"),
			sessionLookupKey(id, "concurrent-secondary"),
			sessionLookupKey(id),
		]);
		expect([...new Set(keys)].sort()).toEqual([
			"concurrent-secondary:<no-session>",
			"primary:<no-session>",
			"unknown:<no-session>",
		]);
	});
});

describe("scopeOfSession", () => {
	it("names the live scope bound to a key, and no other scope", () => {
		const a = begin();
		const b = begin("secondary");
		bindSessionId(a, "lookup-a");
		bindSessionId(b, "lookup-b");
		expect(scopeOfSession("lookup-a")).toBe(a);
		expect(scopeOfSession("lookup-b")).toBe(b);
		expect(scopeOfSession("lookup-c")).toBeUndefined();
	});

	it("forgets a scope the moment it retires", () => {
		const scope = begin();
		bindSessionId(scope, "lookup-retire");
		retireScope(scope, "shutdown");
		expect(scopeOfSession("lookup-retire")).toBeUndefined();
	});

	it("leaves a key a successor re-bound to the successor when the old scope retires", () => {
		// RECURRENCE GUARDED: a /reload or resume binds the same session id to the
		// next scope before the previous one's retirement lands; the late retire
		// must not unbind the live successor.
		const previous = begin();
		const successor = begin();
		bindSessionId(previous, "lookup-reload");
		bindSessionId(successor, "lookup-reload");
		retireScope(previous, "reload");
		expect(scopeOfSession("lookup-reload")).toBe(successor);
	});

	it("refuses to bind a retired scope", () => {
		const scope = begin();
		retireScope(scope, "shutdown");
		bindSessionId(scope, "lookup-dead");
		expect(scopeOfSession("lookup-dead")).toBeUndefined();
	});
});

describe("sessionCell", () => {
	it("is the scope's own cell: the same object scopeCell answers, one per scope", () => {
		const a = begin();
		const b = begin("secondary");
		bindSessionId(a, "cell-a");
		bindSessionId(b, "cell-b");
		const cellA = sessionCell("cell-a", "k", () => ({ n: 1 }));
		const cellB = sessionCell("cell-b", "k", () => ({ n: 2 }));
		expect(cellA).toBe(scopeCell(a, "k"));
		expect(cellB).toBe(scopeCell(b, "k"));
		expect(cellA).not.toBe(cellB);
	});

	it("ends with the scope: a successor on the same id starts with an empty cell", () => {
		const first = begin();
		bindSessionId(first, "cell-reuse");
		sessionCell("cell-reuse", "k", () => ({ n: 1 }));
		retireScope(first, "shutdown");
		const second = begin();
		bindSessionId(second, "cell-reuse");
		expect(sessionCell("cell-reuse", "k")).toBeUndefined();
	});

	it("drops a write for a session with no live scope and counts it; a read counts nothing", () => {
		// RECURRENCE GUARDED: the resurrection a process table allowed.
		expect(sessionCell("cell-ghost", "ghost-cell")).toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);

		expect(sessionCell("cell-ghost", "ghost-cell", () => ({}))).toBeUndefined();
		expect(sessionCell("cell-ghost", "ghost-cell", () => ({}))).toBeUndefined();

		const [missed] = getDegradationSummary();
		expect({
			kind: missed?.kind,
			count: missed?.count,
			subjects: missed?.latestReasons.map((r) => r.subject),
		}).toEqual({
			kind: "session-scope-lookup-missed",
			count: 2,
			subjects: ["ghost-cell"],
		});
	});
});
