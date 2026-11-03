import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiLensGlobalConfigPath } from "../../clients/lens-config.js";
import {
	_resetRunnerTimeoutFloorCacheForTests,
	getRunnerTimeoutFloorMs,
} from "../../clients/runtime-config.js";
import { removeTempDirSync } from "./test-utils.js";
import { useConfigPath } from "../support/global-config.js";

const tmpDirs: string[] = [];
const setConfigPath = useConfigPath();
let previousFloor: string | undefined;

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-runtime-config-"));
	tmpDirs.push(dir);
	return dir;
}

beforeEach(() => {
	previousFloor = process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	setConfigPath(undefined);
	delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	_resetRunnerTimeoutFloorCacheForTests();
});

afterEach(() => {
	if (previousFloor === undefined)
		delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	else process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = previousFloor;
	_resetRunnerTimeoutFloorCacheForTests();
	for (const dir of tmpDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

describe("getRunnerTimeoutFloorMs", () => {
	it("returns 0 when neither config nor env is set", () => {
		const home = makeTempHome();
		// No config file written under this home.
		setConfigPath(getPiLensGlobalConfigPath(home));
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("returns 0 — not NaN — when the env var is unset (regression: NaN poisoning Math.max)", () => {
		const home = makeTempHome();
		setConfigPath(getPiLensGlobalConfigPath(home));
		const floor = getRunnerTimeoutFloorMs();
		expect(Number.isNaN(floor)).toBe(false);
		expect(floor).toBe(0);
	});

	it("reads from the env var when set", () => {
		const home = makeTempHome();
		setConfigPath(getPiLensGlobalConfigPath(home));
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "60000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);
	});

	it("rejects a non-numeric env var and returns 0", () => {
		const home = makeTempHome();
		setConfigPath(getPiLensGlobalConfigPath(home));
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "not-a-number";
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("rejects a negative env var and returns 0", () => {
		const home = makeTempHome();
		setConfigPath(getPiLensGlobalConfigPath(home));
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "-1000";
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("reads from the config file when set", () => {
		const home = makeTempHome();
		setConfigPath(
			getPiLensGlobalConfigPath(home),
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 90000 } }),
		);
		expect(getRunnerTimeoutFloorMs()).toBe(90000);
	});

	it("takes the maximum across config and env when both are set", () => {
		const home = makeTempHome();
		setConfigPath(
			getPiLensGlobalConfigPath(home),
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 90000 } }),
		);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "180000";
		expect(getRunnerTimeoutFloorMs()).toBe(180000);
	});

	it("memoizes — second call does not re-read the env var", () => {
		const home = makeTempHome();
		setConfigPath(getPiLensGlobalConfigPath(home));
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "60000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);

		// Mutate after first read; cache should hold the original value until reset.
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "120000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);

		_resetRunnerTimeoutFloorCacheForTests();
		expect(getRunnerTimeoutFloorMs()).toBe(120000);
	});
});
