/** Bounded, process-local telemetry for behavior degraded during one session. */

import { logExtension } from "./extension-log.js";

export type DegradationKind =
	| "trust-refusal"
	| "mode-suppression"
	| "ts-idle-eviction"
	| "spawn-failure"
	| "formatter-skip"
	| "grammar-blocked"
	| "lsp-breaker"
	| "formatter-failure"
	| "wasm-abort"
	| "lsp-diagnostics-timeout"
	| "bus-stale"
	| "query-predicates-invalid"
	| "install-retry-exhausted";

export interface DegradationRecord {
	kind: unknown;
	subject: unknown;
	reason: unknown;
}

export interface DegradationGroup {
	kind: string;
	/** Exact number recorded, including events no longer retained. */
	count: number;
	/** Number omitted from latestReasons by the per-kind bound. */
	droppedCount: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = 20;
const MAX_DISTINCT_KINDS = 32;
const OVERFLOW_KIND = "other";
const groups = new Map<
	string,
	{ count: number; entries: Array<{ subject: string; reason: string }> }
>();
const onceKeys = new Set<string>();
const tallies = new Map<string, number>();
// Monotonic session-boundary counter (#1536 review F5): callers that keep
// their OWN once-per-session latch outside the ledger (a per-instance Set
// the ledger itself doesn't own) can compare this lazily at use time and
// clear their latch on a mismatch — the same clear-on-transition shape as
// project-trust.ts's trustGeneration, but keyed to the ledger's own reset
// (resetDegradationLedger, wired into handleSessionStart) rather than a
// trust change.
let ledgerGeneration = 0;

/** Current session generation. Bump on every `resetDegradationLedger()`. */
export function getDegradationLedgerGeneration(): number {
	return ledgerGeneration;
}

export function recordDegradation(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		group.count += 1;
		// Bounded at RECORD time (#1366 review): reasons carry arbitrary error
		// text; a 10KB message must never become a 10KB health line or a 10KB
		// retained string.
		group.entries.push({ subject, reason });
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
	} catch (error) {
		debugLedgerFailure("record", error);
		// Telemetry must never break the observed path.
	}
}

/** Record at most once per kind/subject during the current session. */
export function recordDegradationOnce(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const key = `${kind}\0${subject}`;
		if (onceKeys.has(key)) return;
		onceKeys.add(key);
		recordDegradation({ kind, subject, reason: record.reason });
	} catch (error) {
		debugLedgerFailure("record-once", error);
		// Telemetry must never break the observed path.
	}
}

/**
 * Count a repeated degradation while retaining one latest-reason entry per
 * kind/subject. The group count remains the exact event total.
 */
export function incrementDegradationCount(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		const key = `${kind}\0${subject}`;
		const count = (tallies.get(key) ?? 0) + 1;
		tallies.set(key, count);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		group.count += 1;
		const entry = { subject, reason: truncateForLedger(`${reason} (count: ${count})`) };
		const existing = group.entries.findIndex((candidate) => candidate.subject === subject);
		if (existing >= 0) group.entries.splice(existing, 1);
		group.entries.push(entry);
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
	} catch (error) {
		debugLedgerFailure("increment", error);
		// Telemetry must never break the observed path.
	}
}

/** Detached snapshot, grouped in first-seen kind order. */
const LEDGER_FIELD_MAX = 200;

function normalizeForLedger(value: unknown): string {
	return String(value ?? "unknown");
}

function boundedKind(value: unknown): string {
	const kind = truncateForLedger(value);
	if (groups.has(kind) || kind === OVERFLOW_KIND) return kind;
	// Keep one slot available for all kinds beyond the cardinality bound.
	return groups.size < MAX_DISTINCT_KINDS - 1 ? kind : OVERFLOW_KIND;
}

function truncateForLedger(value: unknown): string {
	const text = normalizeForLedger(value);
	return text.length > LEDGER_FIELD_MAX
		? `${text.slice(0, LEDGER_FIELD_MAX)}…`
		: text;
}

export function getDegradationSummary(): DegradationGroup[] {
	return [...groups.entries()].map(([kind, group]) => ({
		kind,
		count: group.count,
		droppedCount: group.count - group.entries.length,
		latestReasons: group.entries.map((entry) => ({ ...entry })),
	}));
}

function isRenderableSummary(value: unknown): value is DegradationGroup[] {
	if (!Array.isArray(value)) return false;
	return value.every((group) => {
		if (group === null || typeof group !== "object") return false;
		const candidate = group as Partial<DegradationGroup>;
		return (
			typeof candidate.kind === "string" &&
			typeof candidate.count === "number" &&
			Array.isArray(candidate.latestReasons) &&
			candidate.latestReasons.every(
				(entry) =>
					entry !== null &&
					typeof entry === "object" &&
					typeof (entry as { subject?: unknown }).subject === "string" &&
					typeof (entry as { reason?: unknown }).reason === "string",
			)
		);
	});
}

export function renderDegradationLines(summary: unknown = getDegradationSummary()): string[] {
	if (!isRenderableSummary(summary)) return [];
	if (summary.length === 0) return [];
	return [
		"Degradations:",
		...summary.map((group) => {
			const latest = group.latestReasons.at(-1);
			return `  ⚠ ${group.kind}: ${group.count}${latest ? ` — ${latest.subject}: ${latest.reason}` : ""}`;
		}),
	];
}

function debugLedgerFailure(operation: string, error: unknown): void {
	try {
		logExtension({
			subsystem: "degradation-ledger",
			level: "debug",
			message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	} catch {
		// Debug logging must not compromise the non-fatal telemetry contract.
	}
}

/** Session-boundary/test reset. */
export function resetDegradationLedger(): void {
	groups.clear();
	onceKeys.clear();
	tallies.clear();
	ledgerGeneration++;
}

export const DEGRADATION_ENTRIES_PER_KIND = ENTRIES_PER_KIND;
export const DEGRADATION_MAX_DISTINCT_KINDS = MAX_DISTINCT_KINDS;
