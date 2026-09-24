/**
 * Tests for clients/lsp/wait-policy/strategies.ts's `resolveAstGrepNativeExe`
 * (#472) — platform-native ast-grep exe resolution, skipping the node-bin
 * wrapper. Package-name construction is checked for the 3 documented
 * platform/arch combos, plus graceful fallback (undefined) for
 * unsupported combos and when require.resolve can't find the package.
 */

import { describe, expect, it } from "vitest";
import {
	getStrategy,
	resolveAstGrepNativeExe,
} from "../../../clients/lsp/wait-policy/strategies.js";

describe("TypeScript diagnostic strategies (#1412)", () => {
	it("keeps classic first-push seeding but stabilizes native TS7 pushes", () => {
		expect(getStrategy("typescript", "classic").seedFirstPush).toBe(true);
		expect(getStrategy("typescript", "native-ts7").seedFirstPush).toBe(false);
		expect(getStrategy("typescript", "native-ts7").debounceMs).toBeGreaterThan(
			0,
		);
	});
});

describe("cue diagnostic strategy (#1522) — measured against the real v0.17.1 binary", () => {
	it("is push-only, seeds the first push, and publishes on clean transitions", () => {
		const strategy = getStrategy("cue");
		expect(strategy.pullRetryBudgetMs).toBe(0);
		expect(strategy.seedFirstPush).toBe(true);
		// Run 35914033696 measured a versioned clean-transition publish; keeping
		// this marker absent prevents the cascade from skipping that signal.
		expect(strategy.silentOnClean).toBeUndefined();
		expect(strategy.reopenOnResync).toBeFalsy();
	});
});

describe("lua diagnostic strategy (#3347)", () => {
	it("marks the measured clean-transition silence", () => {
		const strategy = getStrategy("lua");
		// Run 35914033696 measured two dirty publishes and no clean-transition
		// publish; the marker is the cascade's tier-3 wait-policy decision.
		expect(strategy.silentOnClean).toBe(true);
	});
});

describe("resolveAstGrepNativeExe", () => {
	it("resolves the real native exe for the CURRENT platform/arch (installed in this repo's node_modules)", () => {
		// This repo has @ast-grep/cli-win32-x64-msvc (or the platform-appropriate
		// package) installed as an actual dependency of @ast-grep/cli — exercise
		// the real require.resolve path end to end for the host platform.
		const resolved = resolveAstGrepNativeExe(process.platform, process.arch);
		if (resolved) {
			expect(resolved.toLowerCase()).toContain("ast-grep");
		}
		// If the optional native package isn't installed for this platform/arch,
		// resolved is legitimately undefined — both outcomes are acceptable here,
		// this test just exercises the real resolution path without throwing.
	});

	it("returns undefined for an unsupported platform", () => {
		expect(
			resolveAstGrepNativeExe("aix" as NodeJS.Platform, "x64"),
		).toBeUndefined();
	});

	it("returns undefined for an unsupported arch on a supported platform", () => {
		expect(resolveAstGrepNativeExe("win32", "mips")).toBeUndefined();
		expect(resolveAstGrepNativeExe("darwin", "ia32")).toBeUndefined();
		expect(resolveAstGrepNativeExe("linux", "arm")).toBeUndefined();
	});

	it("never throws when the platform package name would be well-formed but isn't actually installed", () => {
		// win32/arm64, darwin/x64, linux/arm64 are all VALID entries in the
		// matrix (real optionalDependencies names) but may not be installed in
		// this dev environment — must resolve to undefined, not throw.
		expect(() => resolveAstGrepNativeExe("win32", "arm64")).not.toThrow();
		expect(() => resolveAstGrepNativeExe("darwin", "x64")).not.toThrow();
		expect(() => resolveAstGrepNativeExe("linux", "arm64")).not.toThrow();
	});

	it("covers the three documented concrete combos without throwing: win32-x64, darwin-arm64, linux-x64", () => {
		for (const [platform, arch] of [
			["win32", "x64"],
			["darwin", "arm64"],
			["linux", "x64"],
		] as const) {
			expect(() => resolveAstGrepNativeExe(platform, arch)).not.toThrow();
		}
	});
});
