// D9 candidate: process-boundary doubles avoid spending the one 9 MB profile.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import {
	instrumentGuard,
	loadRunHook,
	assertInactiveProfile,
} from "../../scripts/diagnostics/pr24-hook-profile.mjs";

test(
	"D9 instruments only exact ranges with inactive Stryker switches",
	{ timeout: 20_000 },
	async () => {
		const source =
			"globalThis.answer = 1 + 2;\nglobalThis.untouched = 3 + 4;\n";
		const diff = "+++ b/scripts/hooks/guard-bash.mjs\n@@ -1 +1 @@\n";
		const result = await instrumentGuard(source, diff);
		assert.deepEqual(result.patterns, ["scripts/hooks/guard-bash.mjs:1-1"]);
		assert.ok(
			result.mutants.every((mutant) => mutant.location.start.line === 0),
		);
		assert.equal(result.mutate[0].end.column, Number.MAX_SAFE_INTEGER);
		const context = vm.createContext({});
		vm.runInContext(result.content, context, { timeout: 1000 });
		assert.equal(context.answer, 3);
		assert.equal(context.untouched, 7);
		assert.equal(context.__stryker__.activeMutant, undefined);
		assert.ok(
			Object.keys(context.__stryker__.mutantCoverage.static).length > 0,
		);
		await assert.rejects(
			instrumentGuard(source, ""),
			/No fork-relative guard ranges/,
		);
	},
);

test("D9 rejects inherited instrumentation without disclosing environment values", () => {
	assertInactiveProfile({}, undefined);
	const secret = "fixture-private-value";
	for (const [env, namespace] of [
		[{ __STRYKER_ACTIVE_MUTANT__: secret }, undefined],
		[{ NODE_OPTIONS: secret }, undefined],
		[{ NODE_V8_COVERAGE: secret }, undefined],
		[{}, { activeMutant: secret }],
	]) {
		assert.throws(
			() => assertInactiveProfile(env, namespace),
			(error) => {
				assert.match(error.message, /Inherited/);
				assert.ok(!String(error).includes(secret));
				assert.ok(!JSON.stringify(error).includes(secret));
				return true;
			},
		);
	}
});

test("D9 retains the original runHook JSON, synchronous pipe and environment policy", () => {
	const source = readFileSync(
		new URL("./guard-bash-hook.test.ts", import.meta.url),
		"utf8",
	);
	let calls = 0;
	const expected = { status: 2, stderr: "stash" };
	const { runHook } = loadRunHook(
		source,
		(executable, args, options) => {
			calls++;
			assert.equal(executable, process.execPath);
			assert.deepEqual(args, ["/scratch/guard.mjs"]);
			assert.equal(options.encoding, "utf8");
			assert.deepEqual(options.env, {
				HOME: "/private",
				PILENS_DATA_DIR: "/private/data",
			});
			assert.deepEqual(JSON.parse(options.input), {
				session_id: "test",
				cwd: "/home/dev/pi-lens-guard-bash-fixed-cwd",
				permission_mode: "default",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: `echo ${"x".repeat(9_000_000)} && git stash` },
			});
			return expected;
		},
		"/scratch/guard.mjs",
		{
			HOME: "/private",
			PI_LENS_HOME: "/removed",
			PILENS_DATA_DIR: "/private/data",
		},
	);
	assert.equal(runHook(`echo ${"x".repeat(9_000_000)} && git stash`), expected);
	assert.equal(calls, 1);
	assert.throws(() => loadRunHook("", () => {}, "", {}), /extraction failed/);
});

test("D9 preload preserves read errors, bytes and wait returns and saves bounded counters", () => {
	const source = readFileSync(
		new URL(
			"../../scripts/diagnostics/pr24-hook-profile-preload.cjs",
			import.meta.url,
		),
		"utf8",
	);
	const eagain = Object.assign(new Error("not ready"), { code: "EAGAIN" });
	const ebadf = Object.assign(new Error("closed"), { code: "EBADF" });
	const reads = [eagain, 5, 0, ebadf];
	const records = [];
	let tick = 0n;
	let exit;
	let synced = false;
	const fs = {
		readSync: (fd, buffer) => {
			assert.equal(fd, 0);
			assert.equal(buffer, "unchanged buffer");
			const next = reads.shift();
			if (next instanceof Error) throw next;
			return next;
		},
		writeFileSync: (path, contents) => {
			assert.equal(path, "/private/io.json");
			records.push(JSON.parse(contents));
		},
	};
	const atomics = {
		wait: (...args) => {
			assert.deepEqual(args, ["buffer", 0, 0, 5]);
			return "timed-out";
		},
	};
	vm.runInNewContext(
		source,
		{
			require: (name) =>
				name === "node:fs"
					? fs
					: {
							syncBuiltinESMExports: () => {
								synced = true;
							},
						},
			Atomics: atomics,
			process: {
				hrtime: { bigint: () => ++tick },
				cpuUsage: () => ({ user: 1, system: 2 }),
				resourceUsage: () => ({ userCPUTime: 3, systemCPUTime: 4 }),
				env: { PI_LENS_HOOK_PROFILE_IO: "/private/io.json" },
				on: (_event, cb) => {
					exit = cb;
				},
			},
		},
		{ timeout: 1000 },
	);
	assert.ok(synced);
	assert.throws(
		() => fs.readSync(0, "unchanged buffer"),
		(error) => error === eagain,
	);
	assert.equal(atomics.wait("buffer", 0, 0, 5), "timed-out");
	assert.equal(fs.readSync(0, "unchanged buffer"), 5);
	assert.equal(fs.readSync(0, "unchanged buffer"), 0);
	assert.throws(
		() => fs.readSync(0, "unchanged buffer"),
		(error) => error === ebadf,
	);
	exit();
	assert.equal(records.length, 2);
	assert.equal(records[0].phase, "stdin-eof");
	assert.equal(records[1].phase, "exit");
	assert.equal(records[1].reads, 4);
	assert.equal(records[1].bytes, 5);
	assert.equal(records[1].eagain, 1);
	assert.equal(records[1].otherReadErrors, 1);
	assert.equal(records[1].parkCalls, 1);
	assert.ok(records[1].parkNs > 0);
	assert.ok(records[1].readCallNs > 0);
	assert.ok(records[1].stdinWallNs > 0);
	assert.equal(records[1].activeMutantAbsent, true);
	assert.equal(records[1].resourceUsage.userCPUTime, 3);
	assert.ok(records[1].checkpointWriteNs > 0);
	// An unwritable diagnostic sink must not change the observed hook verdict.
	fs.writeFileSync = () => {
		throw new Error("unwritable observer sink");
	};
	exit();
	fs.writeFileSync = (_path, contents) => records.push(JSON.parse(contents));
	exit();
	assert.equal(records.at(-1).recordWriteErrors, 1);
});
