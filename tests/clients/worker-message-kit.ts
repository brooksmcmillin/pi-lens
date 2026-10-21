/**
 * Observe a persist host's real `Worker` (#4400, #4402). The Worker is the
 * host boundary: the real worker script runs, and the host's own `message`
 * listener runs on every message. The wrapper only records what the listener
 * saw and what it threw, which stands in for the uncaught-exception exit a
 * listener throw causes in pi.
 *
 * - `dropRequestStagePath` drops `stagePath` from each request at
 *   `postMessage`, so the real worker fails before staging and posts its own
 *   error result.
 * - `stripResultStagePath` drops `stagePath` from each real result, and
 *   `transformResult` rewrites it, at the `message` boundary (a worker from
 *   another build).
 * - `workers` holds each Worker the host created, so a test can deliver a
 *   message the real worker never produces through the same listener chain
 *   (`worker.emit("message", value)`).
 */
import { Worker } from "node:worker_threads";
import { vi } from "vitest";

export interface WorkerResultLike {
	id: number;
	generation?: number;
	stagePath?: string;
	error?: string;
	[key: string]: unknown;
}

export interface SentRequest {
	id: number;
	generation: number;
	stagePath?: string;
}

export interface ObservedWorker {
	seen: WorkerResultLike[];
	thrown: unknown[];
	sentStagePaths: string[];
	sentRequests: SentRequest[];
	workers: Worker[];
}

export function observeWorker(
	options: {
		dropRequestStagePath?: boolean;
		stripResultStagePath?: boolean;
		transformResult?: (message: WorkerResultLike) => unknown;
		/** Runs before the request crosses to the worker (a stage path can be blocked here). */
		beforeRequest?: (request: SentRequest) => void;
	} = {},
): ObservedWorker {
	const observed: ObservedWorker = {
		seen: [],
		thrown: [],
		sentStagePaths: [],
		sentRequests: [],
		workers: [],
	};
	const transform =
		options.transformResult ??
		(options.stripResultStagePath
			? (message: WorkerResultLike) => ({ ...message, stagePath: undefined })
			: undefined);
	const realOn = Worker.prototype.on;
	vi.spyOn(Worker.prototype, "on").mockImplementation(function (
		this: Worker,
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	) {
		if (event !== "message") return realOn.call(this, event, listener);
		if (!observed.workers.includes(this)) observed.workers.push(this);
		return realOn.call(this, event, (message: WorkerResultLike) => {
			observed.seen.push(message);
			const delivered =
				transform && typeof message === "object" && message
					? transform(message)
					: message;
			try {
				listener(delivered);
			} catch (err) {
				observed.thrown.push(err);
			}
		});
	} as typeof Worker.prototype.on);
	const realPost = Worker.prototype.postMessage;
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: Worker,
		message: SentRequest,
		transferList?: ArrayBuffer[],
	) {
		observed.sentRequests.push({
			id: message.id,
			generation: message.generation,
			stagePath: message.stagePath,
		});
		if (message.stagePath !== undefined) {
			observed.sentStagePaths.push(message.stagePath);
		}
		options.beforeRequest?.(message);
		const { stagePath: _dropped, ...withoutStagePath } = message;
		realPost.call(
			this,
			options.dropRequestStagePath ? withoutStagePath : message,
			transferList,
		);
	} as typeof Worker.prototype.postMessage);
	return observed;
}
