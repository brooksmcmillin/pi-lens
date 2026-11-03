/**
 * The lane's own test-timeout multiplier, `PI_LENS_TEST_TIMEOUT_SCALE`.
 *
 * The Windows unit leg declares 3 because a population test costs several
 * times its Linux time there (a native path-canonicalization syscall per
 * pipeline run, #4019, #4518), and CI can compensate for a loaded runner
 * without moving a production budget. One home: four test files had each
 * hand-rolled this parse (#4592 review F5 fold), so the number the lanes
 * declare and the guard around it are stated once.
 *
 * A non-finite, zero or negative value falls back to 1 (#4592 review F4). A
 * scale of 0 would hand Vitest a zero budget and red every case as an
 * immediate timeout, and NaN would do the same, so the guard is part of the
 * contract and its own test drives both directions.
 */
export function testTimeoutScale(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** `baseMs` widened by the lane's scale. */
export function scaledTestTimeout(
	baseMs: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	return baseMs * testTimeoutScale(env);
}

/**
 * #4828: the budget for a test whose callback walks the repo tree (or reads a
 * population a walk built). Vitest's 5 s default reds on the Windows unit leg
 * (`Unit tests Windows`): the walk costs several times its Linux time there,
 * and `pi-mock-importer-sweep` timed out at 5000 ms on #4823 where Linux takes
 * 711 ms. The slowest Linux census in tests/config is 1.2 s
 * (`real-home-reader-registry`), so 30 s is at least 4x that, and the lane's
 * own scale (3 on Windows) widens it to 90 s. A ceiling only: a passing case
 * costs what it always did. `tests/config/tree-census-timeout.test.ts` refuses
 * a census that omits it.
 */
export const TREE_WALK_TIMEOUT_MS = scaledTestTimeout(30_000);
