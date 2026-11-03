/**
 * Test-side runner for the drains modules register in
 * `clients/background-write-drains.ts` (#4937).
 *
 * Recurrence this prevents: a drain that resolved while its writer still had
 * work pending (a bounded snapshot wait, a probe-cache retry) read as settled,
 * and the write landed after the fixture root was removed. The runner rejects
 * on any drain that reports work remaining, so the file fails loudly instead of
 * removing the root under a live writer.
 */
import { registeredBackgroundWriteDrainsForTests } from "../../clients/background-write-drains.js";

/** Run every registered drain, in registration order; reject on any that is not settled. */
export async function drainRegisteredBackgroundWritesForTests(): Promise<void> {
	for (const drain of registeredBackgroundWriteDrainsForTests()) {
		const remaining = await drain();
		if (remaining !== undefined) throw new Error(remaining);
	}
}
