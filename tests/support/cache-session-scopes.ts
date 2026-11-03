/**
 * The cache observation keeps its per-session state on the session's scope
 * (#4965). These wrappers bind the session first (`bound-sessions.ts`), as
 * production's `session_start` does, then call the real function.
 */

import * as cacheObservability from "../../clients/cache-observability.js";
import { bindSession, retireBoundSessions } from "./bound-sessions.js";

/** Retire every scope a test bound: its sessions' cache state ends with them. */
export function resetCachePrefixObservation(): void {
	retireBoundSessions();
}

export function logCacheUsage(
	message: unknown,
	dbg?: (msg: string) => void,
	context?: Parameters<typeof cacheObservability.logCacheUsage>[2],
): void {
	bindSession(context?.sessionId, context?.sessionRole);
	cacheObservability.logCacheUsage(message, dbg, context);
}

export function observeCacheContext(
	args: Parameters<typeof cacheObservability.observeCacheContext>[0],
): void {
	bindSession(args.sessionId, args.sessionRole);
	cacheObservability.observeCacheContext(args);
}

export function observeCachePrefix(
	...args: Parameters<typeof cacheObservability.observeCachePrefix>
): ReturnType<typeof cacheObservability.observeCachePrefix> {
	bindSession(args[2], args[3]);
	return cacheObservability.observeCachePrefix(...args);
}

export function recordToolResultDelivery(
	args: Parameters<typeof cacheObservability.recordToolResultDelivery>[0],
): void {
	bindSession(args.sessionId, args.sessionRole);
	cacheObservability.recordToolResultDelivery(args);
}
