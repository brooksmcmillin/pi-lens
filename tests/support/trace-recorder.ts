import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { RealPi } from "./real-pi-harness.js";

/**
 * Trace-validation pilot (#3533, docs/adr/0010): write the real child's
 * `session_scope_transition` rows, in log order, for
 * `scripts/trace-validate-session-lifecycle.mjs` to check against
 * formal/session-lifecycle. A no-op unless `REAL_PI_HARNESS_TRACE_DIR` is set,
 * so no lane records anything by default. The rows are the production
 * `logScopeTransition` records: this hook adds no production behaviour.
 */
export function recordScopeTransitions(pi: RealPi, name: string): void {
	const dir = process.env.REAL_PI_HARNESS_TRACE_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	// Only what the checker reads: a row's `filePath` is the session's cwd, a
	// host path that must not land in a tracked fixture.
	const rows = pi.lens
		.latencyRows()
		.filter((row) => row.phase === "session_scope_transition")
		.map(({ phase, pid, metadata }) => ({ phase, pid, metadata }));
	writeFileSync(
		path.join(dir, `${name}.rows.json`),
		`${JSON.stringify(rows, null, 2)}\n`,
	);
}
