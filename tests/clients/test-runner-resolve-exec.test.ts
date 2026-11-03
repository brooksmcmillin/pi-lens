// flake-shape: real-process-spawn — the global-bin and fallback arms of resolveExec must run the real package-manager lookup, which spawns the real `which` and executable stand-in managers; a doubled `findGlobalBinary` is what this matrix used to assert on.
/**
 * `TestRunnerClient.resolveExec` argv-preservation matrix (#1098), moved out of
 * `test-runner-client.test.ts` (#4709 slice 3b): that file mocked
 * `clients/package-manager.js` for this one matrix, and the matrix is the only
 * place a pi-lens-owned lookup answer decides the assertion. The lookup is now
 * REAL; its host boundary (PATH, the package managers) is the PATH-probe stub's
 * stand-ins.
 *
 * lane: ubuntu and every other POSIX box. The stub is POSIX-only
 * (`tests/support/path-probe-stub.ts` "Windows"); this matrix never ran in the
 * Windows lane (the source file has no platform gate), and the win32 spelling
 * of the global-bin lookup (`.cmd`, `.exe`) is `tests/clients/package-manager.test.ts`'s.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetPackageManagerCache } from "../../clients/package-manager.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";
import {
	installPathProbeStub,
	PATH_PROBE_STUB_SUPPORTED,
	type PathProbeStub,
} from "../support/path-probe-stub.js";
import { setupTestEnvironment } from "./test-utils.js";

beforeEach(() => setProjectTrustState("trusted"));

/**
 * Regression matrix for #1098: `resolveExec` used to drop
 * `config.args(testFile, cwd)[0]` UNCONDITIONALLY whenever local-bin or
 * global-bin resolution succeeded — an npx-wrapper-convention assumption
 * (arg 0 names the binary, like `npx vitest run …`) that only holds for
 * wrapper-style runners (vitest/jest/pytest). For direct runners whose
 * args() leads with a REAL subcommand (`cargo test --no-fail-fast`,
 * `go test -run . ./pkg`, `dotnet test --no-build`, `mvn test -q`,
 * `mix test <file>`), the same unconditional `.slice(1)` silently ate the
 * subcommand — e.g. `cargo test --no-fail-fast` became the argv-invalid
 * `cargo --no-fail-fast` (a clap usage error), which the runner then
 * misreported as "1/1 failed" at turn-end.
 *
 * The fix (`stripWrapperArgs` in clients/test-runner-client.ts) only drops
 * the leading arg(s) when they actually NAME the resolved binary — either
 * `[binName, ...]` (vitest/jest) or `["-m", binName, ...]` (pytest) — and
 * leaves everything else untouched.
 *
 * This asserts the invariant generically by iterating the EXPORTED
 * `RUNNERS` config table (not a hand-copied runner list), across every
 * resolution path `resolveExec` can take:
 *   - local-bin hit  (a real file dropped in node_modules/.bin, or
 *                      vendor/bin for phpunit's Composer convention)
 *   - global-bin hit (a binary planted in a stand-in npm's global bin dir,
 *                      found by the REAL `findGlobalBinary`, #4709 slice 3b)
 *   - fallback       (neither resolves; config.command is used verbatim)
 * so a future runner added to RUNNERS is automatically covered.
 *
 * The expected argv for each case is computed independently of the
 * production `stripWrapperArgs` helper (a local re-statement of the same
 * contract), so a regression that reintroduces unconditional stripping (or
 * any other over/under-stripping) fails this test rather than trivially
 * agreeing with whatever the implementation currently does.
 */
describe.skipIf(!PATH_PROBE_STUB_SUPPORTED)(
	"resolveExec argv preservation matrix (#1098)",
	() => {
		const resolveCleanups: Array<() => void> = [];

		let stub: PathProbeStub;
		let stubEnv: ReturnType<typeof setupTestEnvironment>;

		beforeEach(() => {
			// Hermetic world: no package manager is installed unless a case plants
			// one, so the fallback arm cannot be satisfied by the maintainer's box.
			_resetPackageManagerCache();
			stubEnv = setupTestEnvironment("pi-lens-resolve-exec-stub-");
			stub = installPathProbeStub(stubEnv.tmpDir);
		});

		afterEach(() => {
			for (const c of resolveCleanups.splice(0)) c();
			stub.restore();
			_resetPackageManagerCache();
			stubEnv.cleanup();
		});

		function expectedStrippedArgs(binName: string, args: string[]): string[] {
			if (args[0] === binName) return args.slice(1);
			if (args[0] === "-m" && args[1] === binName) return args.slice(2);
			return args;
		}

		function binSuffix(): string {
			return process.platform === "win32" ? ".cmd" : "";
		}

		for (const [runnerKey, config] of Object.entries(RUNNERS)) {
			const binName = config.binName ?? runnerKey;

			describe(`runner: ${runnerKey}`, () => {
				it("preserves argv on local-bin resolution", () => {
					const { tmpDir, cleanup } = setupTestEnvironment(
						"pi-lens-resolve-exec-",
					);
					resolveCleanups.push(cleanup);
					const client = new TestRunnerClient(false) as any;

					let localBinPath: string;
					if (runnerKey === "phpunit") {
						const phpSuffix = process.platform === "win32" ? ".bat" : "";
						localBinPath = path.join(
							tmpDir,
							"vendor",
							"bin",
							`phpunit${phpSuffix}`,
						);
					} else {
						localBinPath = path.join(
							tmpDir,
							"node_modules",
							".bin",
							`${binName}${binSuffix()}`,
						);
					}
					fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
					fs.writeFileSync(localBinPath, "");

					const testFile = path.join(
						tmpDir,
						`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
					);
					const rawArgs = config.args(testFile, tmpDir);

					return client
						.resolveExec(runnerKey, config, testFile, tmpDir)
						.then((resolved: { command: string; args: string[] }) => {
							expect(resolved.command).toBe(localBinPath);
							// phpunit's local (vendor/bin) resolution never strips —
							// see the dedicated branch in resolveExec.
							const expected =
								runnerKey === "phpunit"
									? rawArgs
									: expectedStrippedArgs(binName, rawArgs);
							expect(resolved.args).toEqual(expected);
						});
				});

				if (runnerKey !== "phpunit") {
					// phpunit has no separate global-bin resolution step — its
					// non-local branch falls straight through to the fallback
					// (`command: "phpunit"`), so it's covered by the fallback case
					// below instead of duplicated here.
					it("preserves argv on global-bin resolution", () => {
						const { tmpDir, cleanup } = setupTestEnvironment(
							"pi-lens-resolve-exec-",
						);
						resolveCleanups.push(cleanup);
						const client = new TestRunnerClient(false) as any;

						stub.plantManager("npm");
						const globalBinPath = stub.plantGlobalBinary("npm", binName);

						const testFile = path.join(
							tmpDir,
							`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
						);
						const rawArgs = config.args(testFile, tmpDir);

						return client
							.resolveExec(runnerKey, config, testFile, tmpDir)
							.then((resolved: { command: string; args: string[] }) => {
								expect(resolved.command).toBe(globalBinPath);
								expect(resolved.args).toEqual(
									expectedStrippedArgs(binName, rawArgs),
								);
							});
					});
				}

				it("preserves argv verbatim on fallback (no local/global bin)", () => {
					const { tmpDir, cleanup } = setupTestEnvironment(
						"pi-lens-resolve-exec-",
					);
					resolveCleanups.push(cleanup);
					const client = new TestRunnerClient(false) as any;

					const testFile = path.join(
						tmpDir,
						`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
					);
					const rawArgs = config.args(testFile, tmpDir);

					return client
						.resolveExec(runnerKey, config, testFile, tmpDir)
						.then((resolved: { command: string; args: string[] }) => {
							expect(resolved.command).toBe(
								runnerKey === "phpunit" ? "phpunit" : config.command,
							);
							// Fallback never resolves a binary to become the command, so
							// there is nothing to strip — args() is used verbatim.
							expect(resolved.args).toEqual(rawArgs);
						});
				});
			});
		}

		it("cargo's subcommand survives local-bin resolution (the reported #1098 case)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
			resolveCleanups.push(cleanup);
			const client = new TestRunnerClient(false) as any;

			const localBinPath = path.join(
				tmpDir,
				"node_modules",
				".bin",
				`cargo${binSuffix()}`,
			);
			fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
			fs.writeFileSync(localBinPath, "");

			const testFile = path.join(tmpDir, "src", "lib.rs");

			return client
				.resolveExec("cargo", RUNNERS.cargo, testFile, tmpDir)
				.then((resolved: { command: string; args: string[] }) => {
					expect(resolved.command).toBe(localBinPath);
					// Pre-fix, this was ["--no-fail-fast"] (the "test" subcommand was
					// eaten), producing a clap usage error at spawn time.
					expect(resolved.args).toEqual(["test", "--no-fail-fast"]);
				});
		});

		it("rspec resolves the real binary name (bundle), not the runner key", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
			resolveCleanups.push(cleanup);
			const client = new TestRunnerClient(false) as any;

			stub.plantManager("npm");
			// Planted under the BINARY's name only: a lookup by the runner key
			// ("rspec") would find nothing and fall through to the fallback.
			const bundleBinPath = stub.plantGlobalBinary("npm", "bundle");

			const testFile = path.join(tmpDir, "spec", "foo_spec.rb");

			return client
				.resolveExec("rspec", RUNNERS.rspec, testFile, tmpDir)
				.then((resolved: { command: string; args: string[] }) => {
					expect(resolved.command).toBe(bundleBinPath);
					// "exec" is a real bundle subcommand, not the binary name — must
					// survive intact so `bundle exec rspec <file>` reaches bundle.
					expect(resolved.args).toEqual(["exec", "rspec", testFile]);
					// The lookup ran through the manager rather than being short-circuited.
					expect(stub.queries()).toEqual(["config get prefix"]);
				});
		});
	},
);
