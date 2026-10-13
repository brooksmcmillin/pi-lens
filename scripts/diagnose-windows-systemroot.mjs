#!/usr/bin/env node
// Diagnostic branch only: compare one fixed cmd payload across child environments.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const EXPECTED = JSON.stringify(["safe & literal"]);

export function observe(label, command, args, env, windowsVerbatimArguments) {
	const started = performance.now();
	const result = spawnSync(command, args, {
		env,
		encoding: "utf8",
		shell: false,
		windowsVerbatimArguments,
		timeout: 5000,
		maxBuffer: 16 * 1024,
	});
	return {
		label,
		durationMs: Math.round(performance.now() - started),
		status: result.status,
		signal: result.signal,
		error: result.error
			? {
					code: result.error.code ?? null,
					message: result.error.message.slice(0, 4096),
				}
			: null,
		stdout: (result.stdout ?? "").slice(0, 4096),
		stderr: (result.stderr ?? "").slice(0, 4096),
		stdoutOmitted: Math.max(0, (result.stdout ?? "").length - 4096),
		stderrOmitted: Math.max(0, (result.stderr ?? "").length - 4096),
	};
}

export function checkLiteralArgument(observation) {
	return {
		label: observation.label,
		passed:
			observation.error === null &&
			observation.status === 0 &&
			observation.signal === null &&
			observation.stdoutOmitted === 0 &&
			observation.stderrOmitted === 0 &&
			observation.stdout === EXPECTED,
	};
}

export async function main() {
	if (process.platform !== "win32") {
		console.error(
			"REFUSED: native Windows is required; no diagnostic executed.",
		);
		return 2;
	}
	const originalSystemRoot = process.env.SystemRoot;
	if (!originalSystemRoot) {
		console.error(
			"REFUSED: original SystemRoot is missing; no valid control environment.",
		);
		return 2;
	}
	const originalEnv = { ...process.env };
	const { buildWindowsShellCommand } = await import("../clients/safe-spawn.js");
	const fixtureDir = mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-systemroot-diagnostic-"),
	);
	try {
		const fixture = path.join(fixtureDir, "echo-args.js");
		const shim = path.join(fixtureDir, "echo-args.cmd");
		writeFileSync(
			fixture,
			"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
		);
		writeFileSync(
			shim,
			`@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
		);
		const invalidSystemRoot = path.join(fixtureDir, "missing & root");
		let payload;
		try {
			process.env.SystemRoot = invalidSystemRoot;
			payload = buildWindowsShellCommand(shim, ["safe & literal"]);
		} finally {
			process.env.SystemRoot = originalSystemRoot;
		}
		// Windows env names are case-insensitive: never send duplicate root spellings.
		const childEnv = { ...originalEnv };
		for (const key of Object.keys(childEnv)) {
			if (key.toLowerCase() === "systemroot") delete childEnv[key];
		}
		const invalidEnv = { ...childEnv, SystemRoot: invalidSystemRoot };
		const validEnv = { ...childEnv, SystemRoot: originalSystemRoot };
		const interpreter = `${originalSystemRoot}\\System32\\cmd.exe`;
		const cmdArgs = ["/d", "/s", "/c", payload];
		const nodeArgs = [fixture, "safe & literal"];
		const observations = [
			observe("cmd-invalid-root", interpreter, cmdArgs, invalidEnv, true),
			observe("cmd-valid-root", interpreter, cmdArgs, validEnv, true),
			observe(
				"node-invalid-root",
				process.execPath,
				nodeArgs,
				invalidEnv,
				false,
			),
			observe("node-valid-root", process.execPath, nodeArgs, validEnv, false),
		];
		const checks = observations.map(checkLiteralArgument);
		console.log(
			JSON.stringify({
				baseCommit: "f317b2657bebddf7885e4d5a8d26f0fecdb2e420",
				node: process.version,
				platform: process.platform,
				osRelease: os.release(),
				originalSystemRoot,
				invalidSystemRoot,
				interpreter,
				payload,
				builderSourceSha256: createHash("sha256")
					.update(
						readFileSync(new URL("../clients/safe-spawn.ts", import.meta.url)),
					)
					.digest("hex"),
				observations,
				checks,
			}),
		);
		// Emit every observation before judging: an invalid-root failure is not hidden.
		return checks.every((check) => check.passed) ? 0 : 1;
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(`Diagnostic failed: ${String(error).slice(0, 4096)}`);
			process.exitCode = 2;
		});
}
