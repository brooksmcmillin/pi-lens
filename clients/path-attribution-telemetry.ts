import { logLatency } from "./latency-logger.js";

// Verified guesses are expected host behavior, not degradations. Keep their
// exact session count in memory and publish one bounded row at session end.
// This tally is intentionally memory-only: a process crash loses its count.
// The rollup is best-effort session telemetry, not durable accounting.
let verifiedGuessCount = 0;

export function recordVerifiedPathAttributionGuess(): void {
	verifiedGuessCount += 1;
}

export function getVerifiedPathAttributionGuessCount(): number {
	return verifiedGuessCount;
}

export function emitVerifiedPathAttributionRollup(filePath: string): void {
	if (verifiedGuessCount === 0) return;
	logLatency({
		type: "phase",
		phase: "path_attribution_verified_rollup",
		filePath,
		durationMs: 0,
		metadata: { count: verifiedGuessCount },
	});
	verifiedGuessCount = 0;
}

export function resetVerifiedPathAttributionGuessCount(): void {
	verifiedGuessCount = 0;
}
