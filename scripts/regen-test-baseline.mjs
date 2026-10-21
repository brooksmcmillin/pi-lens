import { spawnSync } from "node:child_process";

/**
 * One entry per regenerable baseline sweep: the test file to run and the env
 * flag that switches it from "assert the baseline" to "write the baseline".
 */
const TARGETS = {
	"vi-mock": {
		file: "tests/config/vi-mock-export-sweep.test.ts",
		regenEnv: "VI_MOCK_EXPORT_REGEN",
	},
	"test-env-restore": {
		file: "tests/config/test-env-restore-sweep.test.ts",
		regenEnv: "TEST_ENV_RESTORE_REGEN",
	},
	"test-server-teardown": {
		file: "tests/config/test-server-teardown-sweep.test.ts",
		regenEnv: "TEST_SERVER_TEARDOWN_REGEN",
	},
};

const target = TARGETS[process.argv[2]];
if (!target) {
	console.error(
		`Usage: npm run test:regen -- <${Object.keys(TARGETS).join("|")}>`,
	);
	process.exit(2);
}
const result = spawnSync(
	process.execPath,
	[
		"scripts/with-test-lock.mjs",
		"--shared",
		"--",
		"node_modules/.bin/vitest",
		"run",
		target.file,
		"--configLoader",
		"runner",
	],
	{ env: { ...process.env, [target.regenEnv]: "1" }, stdio: "inherit" },
);
process.exit(result.status ?? 1);
