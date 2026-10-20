/**
 * #4401: the failing-worker variant of scripts/rpc-load-check.mjs makes the
 * project-snapshot persist worker answer with `{ id, generation, error }` and
 * no `stagePath`, the wire shape that killed pi in #4400. This pins the seam
 * from the worker side, against the built twin.
 *
 * Recurrences these tests prevent:
 *  - the env var or the error text drifting from what the smoke keys on
 *    (FORCE_WORKER_FAIL_ENV / FORCED_ERROR_MARKER): the variant would then
 *    either never force a failure (a vacuous green) or flag its own expected
 *    fallback as a failure (a permanent red);
 *  - the seam leaking into production: with the variable unset the worker must
 *    still stage the file and echo its path, as every released build does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FORCE_WORKER_FAIL_ENV,
	FORCED_ERROR_MARKER,
} from "../../scripts/rpc-load-check.mjs";

const WORKER = path.resolve(
	import.meta.dirname,
	"../../clients/project-snapshot-persist-worker.js",
);

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-snapshot-worker-seam-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function roundTrip(
	env: Record<string, string | undefined>,
): Promise<{ result: Record<string, unknown>; stagePath: string }> {
	const stagePath = path.join(dir, "snapshot.gz.stage-1");
	const worker = new Worker(WORKER, { env: { ...process.env, ...env } });
	try {
		const result = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
				worker.postMessage({
					id: 7,
					generation: 3,
					stagePath,
					data: new TextEncoder().encode('{"seq":0}'),
					generatedAt: "2026-10-14T00:00:00.000Z",
				});
			},
		);
		return { result, stagePath };
	} finally {
		await worker.terminate();
	}
}

describe("project-snapshot persist worker failure seam", () => {
	it("answers without a stagePath and with the marker the smoke keys on", async () => {
		const { result, stagePath } = await roundTrip({
			[FORCE_WORKER_FAIL_ENV]: "no-stage-path",
		});
		expect(result.id).toBe(7);
		expect(result.generation).toBe(3);
		expect(String(result.error)).toContain(FORCED_ERROR_MARKER);
		expect("stagePath" in result).toBe(false);
		expect(fs.existsSync(stagePath)).toBe(false);
	});

	// Recurrence: #4400, a listener that throws on a message it did not expect
	// is an uncaught worker exception. The seam must not add one (#4402).
	it("drops a malformed message and still answers the next routable one", async () => {
		const worker = new Worker(WORKER, {
			env: { ...process.env, [FORCE_WORKER_FAIL_ENV]: "no-stage-path" },
		});
		try {
			const result = await new Promise<Record<string, unknown>>(
				(resolve, reject) => {
					worker.once("message", resolve);
					worker.once("error", reject);
					for (const malformed of [null, "text", 5, {}, { id: 1 }]) {
						worker.postMessage(malformed);
					}
					worker.postMessage({ id: 9, generation: 4 });
				},
			);
			expect(result.id).toBe(9);
			expect(result.generation).toBe(4);
			expect(String(result.error)).toContain(FORCED_ERROR_MARKER);
		} finally {
			await worker.terminate();
		}
	});

	it("is inert when the variable is unset: stages the file and echoes its path", async () => {
		const { result, stagePath } = await roundTrip({
			[FORCE_WORKER_FAIL_ENV]: undefined,
		});
		expect(result.error).toBeUndefined();
		expect(result.stagePath).toBe(stagePath);
		expect(fs.existsSync(stagePath)).toBe(true);
	});
});
