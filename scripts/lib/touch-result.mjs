// The one reading of an `LSPService.touchFile` result for the LSP scripts
// (smoke-tools, bench-lsp, the clean-signal probe, the idle-eviction probe).

/**
 * The diagnostics a touch collected, or `undefined` when no server answered
 * ("no client ready").
 *
 * - `touched`: what `touchFile` returned, a `{ diags, inconclusive?, ... }`
 *   wrapper since #1179, or `undefined` when no client was acquired and
 *   nothing is disabled. Two scripts still tested `Array.isArray(result)` and
 *   read every touch as unanswered (bench-lsp) or counted none of its
 *   diagnostics (the clean-signal probe's `dirtyDiags`).
 * - `touchOptions`: the options object the touch was sent with, so the
 *   auxiliaries it asked for come from the request itself, never restated by
 *   the caller.
 * - `service`: the LSP service that ran the touch, asked for its live servers
 *   only when no primary answered and auxiliaries were requested.
 *
 * #4403 (PR #4411): a touch that acquires no language server returns the
 * `primary-unavailable` verdict, with no diagnostics, once a primary is off in
 * `lsp.disabledServers`, which every smoke alternate row writes for its
 * default. Read as an answer, that turned the official Docker smoke row on a
 * runner without the binary from "unavailable" into "no warm client" (#4465).
 * An auxiliary answers without a primary, but the verdict does not say whether
 * one attached: a requested auxiliary counts only while it is running, or a
 * missing one reads as a clean answer (bench-lsp timed spawns that never
 * happened, #4466 review F1).
 */
export function touchAnsweredDiagnostics(touched, touchOptions, service) {
	if (touched?.inconclusiveReason !== "primary-unavailable")
		return touched?.diags;
	const auxiliaryIds = touchOptions?.auxiliaryServerIds ?? [];
	if (auxiliaryIds.length === 0) return undefined;
	const alive = service.getAliveServerIds();
	return auxiliaryIds.some((id) => alive.includes(id))
		? touched.diags
		: undefined;
}
