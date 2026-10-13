#!/usr/bin/env node
// Diagnostic candidate only. Never merge; run once on Ubuntu 24.04 / Node 22.23.3.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Instrumenter } from "@stryker-mutator/instrumenter";
import { INSTRUMENTER_CONSTANTS } from "@stryker-mutator/api/core";
import baseConfig from "../../stryker.config.mjs";
import { gitExecFileSync } from "../lib/git-fixture-env.mjs";
import {
	mutationRangePatterns,
	parseChangedLineRanges,
} from "../lib/stryker-diff.mjs";

const BASE = "c0a59115c24093dc198df313e0593811b4dd46f6";
const HEAD = "ce077c285cc785475793bbf5ee0d464437c52b51";
const GUARD = "scripts/hooks/guard-bash.mjs";
const TEST = "tests/scripts/guard-bash-hook.test.ts";
const OUTPUT = resolve(".probe-home/pr24-hook-profile");
const CHILD_BOUND_MS = 180_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) =>
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const git = (...args) =>
	gitExecFileSync(args, {
		encoding: "utf8",
		timeout: 10_000,
		killSignal: "SIGKILL",
		maxBuffer: 4_000_000,
	});
const logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	isDebugEnabled: () => false,
};

// Use the installed core's own range resolver and defaults, not a second
// interpretation of inclusive line ranges. These internal APIs are pinned to 10.0.0.
export async function instrumentGuard(content, diff) {
	const coreRoot = new URL(
		"./",
		import.meta.resolve("@stryker-mutator/core/package.json"),
	);
	// Initialize through the public entry to preserve core's cyclic import order.
	await import("@stryker-mutator/core");
	const { ProjectReader } = await import(
		new URL("dist/src/fs/project-reader.js", coreRoot).href
	);
	const { defaultOptions } = await import(
		new URL("dist/src/config/options-validator.js", coreRoot).href
	);
	for (const name of ["core", "instrumenter"]) {
		const pkg = JSON.parse(
			readFileSync(
				new URL(import.meta.resolve(`@stryker-mutator/${name}/package.json`)),
				"utf8",
			),
		);
		assert.equal(pkg.version, "10.0.0");
	}
	assert.equal(baseConfig.coverageAnalysis, "off");
	assert.equal(baseConfig.disableTypeChecks, false);
	const patterns = mutationRangePatterns([GUARD], parseChangedLineRanges(diff));
	assert.ok(patterns.length > 0, "No fork-relative guard ranges");
	const options = { ...defaultOptions, ...baseConfig, mutate: patterns };
	assert.deepEqual(options.ignorers, []);
	const reader = new ProjectReader({}, logger, options);
	const name = resolve(GUARD);
	const { mutate } = reader.resolveFileDescriptions([name])[name];
	const instrumenterOptions = {
		ignorers: options.ignorers,
		...options.mutator,
	};
	const result = await new Instrumenter(logger).instrument(
		[{ name, content, mutate }],
		instrumenterOptions,
	);
	assert.ok(result.mutants.length > 0, "No guard mutants generated");
	return {
		content: result.files[0].content,
		mutants: result.mutants,
		patterns,
		mutate,
		instrumenterOptions,
	};
}

// Extract the actual test caller, retaining its serialization, pipe and BASE_ENV
// policy. The injected process boundary adds only profile flags and a hard cap.
export function loadRunHook(testSource, spawn, hook, env) {
	const start = testSource.indexOf("function runHook(");
	const end = testSource.indexOf("\n}\n", start) + 3;
	assert.ok(start >= 0 && end > start, "runHook extraction failed");
	const source = testSource.slice(start, end);
	const js = stripTypeScriptTypes(source);
	const runHook = new Function(
		"spawnSync",
		"process",
		"HOOK",
		"BASE_ENV",
		"PAYLOAD_CWD",
		`${js}\nreturn runHook;`,
	)(
		spawn,
		process,
		hook,
		Object.fromEntries(
			Object.entries(env).filter(([key]) => key !== "PI_LENS_HOME"),
		),
		"/home/dev/pi-lens-guard-bash-fixed-cwd",
	);
	return { source, runHook };
}

async function prepare() {
	mkdirSync(OUTPUT, { recursive: true });
	for (const file of ["package-lock.json", "stryker.config.mjs"]) {
		assert.equal(
			readFileSync(file, "utf8"),
			git("show", `${HEAD}:${file}`),
			`${file} differs from PR24`,
		);
	}
	const original = git("show", `${HEAD}:${GUARD}`);
	const testSource = git("show", `${HEAD}:${TEST}`);
	assert.equal(
		readFileSync(GUARD, "utf8"),
		original,
		"Guard differs from PR24",
	);
	assert.equal(
		readFileSync(TEST, "utf8"),
		testSource,
		"Original deadline/caller changed",
	);
	const diff = git(
		"diff",
		"--no-ext-diff",
		"--unified=0",
		`${BASE}..${HEAD}`,
		"--",
		GUARD,
	);
	const instrumented = await instrumentGuard(original, diff);
	const hook = resolve(OUTPUT, "guard-bash.instrumented.mjs");
	writeFileSync(hook, instrumented.content);
	writeFileSync(resolve(OUTPUT, "guard-bash.original.mjs"), original);
	writeFileSync(resolve(OUTPUT, "guard.diff"), diff);
	writeFileSync(resolve(OUTPUT, "guard-bash-hook.test.ts"), testSource);
	writeFileSync(
		resolve(OUTPUT, "stryker.config.mjs"),
		readFileSync("stryker.config.mjs"),
	);
	json(resolve(OUTPUT, "mutants.json"), instrumented.mutants);
	const { source } = loadRunHook(testSource, spawnSync, hook, {});
	writeFileSync(resolve(OUTPUT, "runHook.ts"), source);
	const provenance = {
		base: BASE,
		head: HEAD,
		diagnosticHead: git("rev-parse", "HEAD").trim(),
		guard: GUARD,
		test: TEST,
		originalSha256: sha256(original),
		instrumentedSha256: sha256(instrumented.content),
		callerSha256: sha256(source),
		testSha256: sha256(testSource),
		lockSha256: sha256(readFileSync("package-lock.json")),
		configSha256: sha256(readFileSync("stryker.config.mjs")),
		diffSha256: sha256(diff),
		strykerVersion: "10.0.0",
		coverageAnalysis: "off",
		disableTypeChecks: false,
		instrumenterOptions: instrumented.instrumenterOptions,
		patterns: instrumented.patterns,
		mutate: instrumented.mutate,
		mutantCount: instrumented.mutants.length,
		limitations: [
			"Guard-only IDs start at zero; original six-file ordering/IDs are unknown. Numeric-ID/string-length and coverage-object overhead may differ.",
			"Same Stryker inactive switch/coverage instrumentation, no active mutant. Not byte-identical original campaign instrumentation.",
			"Profile locations reference saved instrumented bytes; mutants.json maps IDs to original locations. Stryker's printer emits no source map.",
			"Scratch hook path, one process, no concurrent 47-file suite. CI-equivalent platform is not definitive original-run attribution.",
		],
	};
	json(resolve(OUTPUT, "provenance.json"), provenance);
	return { hook, testSource, provenance };
}

export function assertInactiveProfile(env, namespace) {
	assert.ok(
		env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE] === undefined,
		"Inherited active mutant",
	);
	assert.ok(env.NODE_OPTIONS === undefined, "Inherited Node preload/options");
	assert.ok(env.NODE_V8_COVERAGE === undefined, "Inherited V8 coverage");
	assert.ok(namespace === undefined, "Inherited Stryker namespace");
}

async function measure() {
	assert.equal(process.platform, "linux");
	assert.equal(process.version, "v22.23.3");
	const osRelease = readFileSync("/etc/os-release", "utf8");
	assert.match(osRelease, /^ID=ubuntu$/m);
	assert.match(osRelease, /^VERSION_ID="24\.04"$/m);
	assertInactiveProfile(process.env, globalThis.__stryker__);
	const { hook, testSource, provenance } = await prepare();
	// Exclusive marker prohibits repeat-until-green in this workspace.
	writeFileSync(
		resolve(OUTPUT, "measurement-started.json"),
		JSON.stringify({
			node: process.version,
			platform: process.platform,
			osRelease,
			activeMutantEnvironmentAbsent: true,
			nodeOptionsAbsent: true,
			nodeV8CoverageAbsent: true,
			childBoundMs: CHILD_BOUND_MS,
			originalTestDeadlineMs: 60_000,
			cpuProfilerIntervalMicros: 1000,
		}),
		{ flag: "wx" },
	);
	const preload = fileURLToPath(
		new URL("./pr24-hook-profile-preload.cjs", import.meta.url),
	);
	let spawnWallMs;
	let payloadBytes;
	let payloadSha256;
	let payloadMetadataMs;
	const { runHook } = loadRunHook(
		testSource,
		(executable, args, options) => {
			const metadataStart = performance.now();
			payloadBytes = Buffer.byteLength(options.input);
			payloadSha256 = sha256(options.input);
			payloadMetadataMs = performance.now() - metadataStart;
			const spawnStart = performance.now();
			const result = spawnSync(
				executable,
				[
					"--cpu-prof",
					"--cpu-prof-interval=1000",
					`--cpu-prof-dir=${OUTPUT}`,
					"--cpu-prof-name=guard.cpuprofile",
					"--require",
					preload,
					...args,
				],
				{ ...options, timeout: CHILD_BOUND_MS, killSignal: "SIGKILL" },
			);
			spawnWallMs = performance.now() - spawnStart;
			return result;
		},
		hook,
		{
			...process.env,
			PI_LENS_HOOK_PROFILE_IO: resolve(OUTPUT, "stdin-cpu.json"),
		},
	);
	const started = performance.now();
	const command = `echo ${"x".repeat(9_000_000)} && git stash`;
	const result = runHook(command);
	const totalWallMs = performance.now() - started;
	writeFileSync(resolve(OUTPUT, "child.stdout"), result.stdout ?? "");
	writeFileSync(resolve(OUTPUT, "child.stderr"), result.stderr ?? "");
	const ioPath = resolve(OUTPUT, "stdin-cpu.json");
	const io = existsSync(ioPath)
		? JSON.parse(readFileSync(ioPath, "utf8"))
		: null;
	const verdict = {
		status: result.status,
		signal: result.signal,
		error: result.error?.code ?? null,
		spawnWallMs,
		totalWallMs,
		payloadBytes,
		payloadSha256,
		payloadMetadataMs,
		commandBytes: Buffer.byteLength(command),
		commandSha256: sha256(command),
		exceedsOriginalTestDeadline: totalWallMs > 60_000,
		originalTestExecuted: false,
		testGreenClaim: false,
		cpuProfilePresent: existsSync(resolve(OUTPUT, "guard.cpuprofile")),
		io,
		childCpuThroughExitMicros:
			io?.phase === "exit"
				? {
						user: io.resourceUsage.userCPUTime,
						system: io.resourceUsage.systemCPUTime,
					}
				: null,
		deniesStash:
			result.status === 2 && result.stderr.toLowerCase().includes("stash"),
		instrumentedSha256: provenance.instrumentedSha256,
		overhead:
			"Times include V8 CPU profiler (1ms sampling), preload and builtin wrappers. wrapperBookkeepingNs excludes checkpoint I/O and cannot quantify V8 profiler overhead; no unprofiled comparison was run. cpuMicros begins at preload; resourceUsage includes startup through exit handler, not final profiler serialization. driver-time.txt includes preparation, driver and child CPU, not child-only CPU. Spawn wall includes startup/shutdown.",
	};
	json(resolve(OUTPUT, "result.json"), verdict);
	console.log(JSON.stringify(verdict));
	assert.equal(sha256(readFileSync(hook)), provenance.instrumentedSha256);
	assert.ok(
		verdict.deniesStash &&
			verdict.cpuProfilePresent &&
			io?.phase === "exit" &&
			io.activeMutantAbsent &&
			io.coveredMutantCount > 0 &&
			io.bytes === payloadBytes &&
			io.recordWriteErrors === 0,
		"Incomplete profile or unexpected child verdict; inspect retained artifacts, do not retry",
	);
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	try {
		assert.ok(
			["--prepare", "--measure"].includes(process.argv[2]),
			"Use --prepare or --measure",
		);
		if (process.argv[2] === "--prepare") await prepare();
		else await measure();
	} catch (error) {
		mkdirSync(OUTPUT, { recursive: true });
		json(resolve(OUTPUT, "failure.json"), {
			name: error.name,
			message: error.message,
		});
		console.error(error);
		process.exitCode = 1;
	}
}
