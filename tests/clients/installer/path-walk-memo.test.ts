import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	statSync: statSyncMock,
}));

import {
	isSpawnableCommand,
	resetPathWalkMemo,
} from "../../../clients/installer/index.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";

const savedPath = process.env.PATH;

describe("bare-command PATH availability memo", () => {
	beforeEach(() => {
		// #4530: the walk's trust judgment reads the filesystem too (this file
		// counts statSync calls); the memo is the axis here, so the session's
		// trust is adopted. The judgment is pinned in session-repository-trust-4530.
		setProjectTrustState("trusted");
		process.env.PATH = "memo-path";
		resetPathWalkMemo();
		statSyncMock.mockReset();
		statSyncMock.mockReturnValue({ isFile: () => true, size: 1 });
	});

	afterEach(() => {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		resetPathWalkMemo();
		resetProjectTrust();
	});

	it("memoizes PATH walk: N hits = 1 statSync call", async () => {
		for (let i = 0; i < 5; i += 1) {
			expect(await isSpawnableCommand("memo-tool")).toBe(true);
		}
		expect(statSyncMock).toHaveBeenCalledOnce();

		resetPathWalkMemo();
		expect(await isSpawnableCommand("memo-tool")).toBe(true);
		expect(statSyncMock).toHaveBeenCalledTimes(2);
	});
});
