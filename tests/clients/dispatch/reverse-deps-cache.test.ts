import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_getReverseDepsIndexCacheKeysForTests,
	_seedReverseDepsIndexCacheForTests,
	clearReverseDepsIndexCache,
} from "../../../clients/dispatch/integration.js";

const index = {
	projectRoot: "/workspace",
	generatedAt: "now",
	imports: { "/workspace/a.ts": ["/workspace/b.ts"] },
	importedBy: { "/workspace/b.ts": ["/workspace/a.ts"] },
	source: "review-graph" as const,
};

afterEach(() => {
	clearReverseDepsIndexCache();
	vi.useRealTimers();
});

describe("reverse-dependency Tier-2 cache bounds (#1389)", () => {
	it("evicts idle roots and permits equivalent recovery", () => {
		vi.useFakeTimers();
		const previous = process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS;
		process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS = "10";
		try {
			_seedReverseDepsIndexCacheForTests("root-a", index, 1);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual(["root-a"]);
			vi.advanceTimersByTime(11);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual([]);
			_seedReverseDepsIndexCacheForTests("root-a", index, 1);
			expect(_getReverseDepsIndexCacheKeysForTests()).toEqual(["root-a"]);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS;
			else process.env.PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS = previous;
		}
	});
});
