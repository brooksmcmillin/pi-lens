/**
 * The stale-context stub a session-event handler is handed after pi has
 * invalidated its context (#1925). It lives outside `pi-mock.ts` so a test
 * file that needs only the stub does not load the hand-built pi double, which
 * throws at load for a file off the importer list (#4913 L1). `pi-mock.ts`
 * re-exports both names for the files that still import them from there.
 */

/**
 * The exact message the pi SDK's `assertActive()` throws from every accessor
 * on a context invalidated by `ctx.newSession()`, `ctx.fork()`,
 * `ctx.switchSession()`, or `ctx.reload()`
 * (`core/extensions/loader.js` in the installed
 * `@earendil-works/pi-coding-agent`).
 */
export const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession(), " +
	"ctx.fork(), ctx.switchSession(), or ctx.reload().";

/**
 * A context the SDK has invalidated (#1925). Every accessor pi wraps in
 * `assertActive()` throws `STALE_CTX_MESSAGE`; nothing else is defined, so a
 * handler that reads any of them without a guard rejects exactly the way it
 * does in production after a session replacement.
 *
 * Modelled as throwing GETTERS rather than a throw-everything Proxy on
 * purpose: the real ctx is a class instance, so an undeclared property
 * (`then`, `Symbol.toPrimitive`) reads `undefined` instead of throwing, and a
 * Proxy would make `await`ing or interpolating the object throw in ways the
 * SDK never does.
 */
export function makeStaleCtx(): Record<string | symbol, unknown> {
	const ctx = {} as Record<string | symbol, unknown>;
	// Every `assertActive()`-wrapped accessor on ExtensionContext.
	const guarded = [
		"ui",
		"cwd",
		"mode",
		"hasUI",
		"signal",
		"sessionManager",
		"model",
		"isProjectTrusted",
		"isIdle",
		"hasPendingMessages",
		"abort",
		"shutdown",
		"getContextUsage",
		"compact",
		"getSystemPrompt",
		"waitForIdle",
	];
	for (const name of guarded) {
		Object.defineProperty(ctx, name, {
			configurable: true,
			enumerable: true,
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});
	}
	return ctx;
}
