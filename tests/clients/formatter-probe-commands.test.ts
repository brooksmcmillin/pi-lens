/**
 * #1495 review — pin which binaries each formatter's `detect()` actually probes.
 *
 * The poison guard matches a stalled PATH probe against `command[0]`, the
 * formatter's own binary. That is exact for most formatters and approximate for
 * the few that consult a second binary, so the approximation has to be visible:
 * this test records every `which` a detection performs and fails when a formatter
 * probes something the guard would not recognise and that is not listed here.
 *
 * Two shapes of extra probe, and they are not equally harmless:
 *   * install fallbacks (`rustup`, `dotnet`) run only AFTER the primary answered,
 *     so the primary is already in the transient set when the answer was not real;
 *   * co-equal alternatives (`pwsh`/`powershell`, oxfmt's `vp`) can be the only
 *     thing that stalled, which is the residual tracked with #1539.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
}));
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: vi.fn(),
	getLastLoggedPhase: () => undefined,
}));

import { ALL_FORMATTERS, clearFormatterCache } from "../../clients/formatters.js";

/**
 * Binaries a formatter probes BESIDES its own `command[0]`, with why. Adding a
 * formatter that probes something else fails this test — which is the point: the
 * poison guard in `getFormattersForFile` only sees `command[0]`.
 */
const EXTRA_PROBED_COMMANDS: Record<string, readonly string[]> = {
	// Install fallback: `rustup component add rustfmt`.
	rustfmt: ["rustup"],
	// Install fallback, plus the dotnet-tool form of the same formatter.
	csharpier: ["dotnet"],
	// Co-equal alternatives — either interpreter can satisfy the formatter.
	"psscriptanalyzer-format": ["pwsh", "powershell"],
	// A global `vp` (Vite Plus) provides oxfmt without oxfmt being on PATH.
	oxfmt: ["vp"],
};

const finder = () => (process.platform === "win32" ? "where" : "which");

let cwd: string;

beforeEach(() => {
	safeSpawnAsync.mockReset();
	// Every lookup misses, so detection walks its whole candidate list and every
	// probe it would ever make is recorded.
	safeSpawnAsync.mockResolvedValue({ stdout: "", stderr: "", status: 1 });
	clearFormatterCache();
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-commands-"));
	// A Cargo.toml unlocks rustfmt's install-fallback branch, so the `rustup`
	// probe is genuinely exercised rather than merely declared below.
	fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
});

describe("formatter detection probes only the binaries we account for (#1495)", () => {
	it("every formatter's probed commands are its own plus a declared extra", async () => {
		const unexpected: string[] = [];

		for (const formatter of ALL_FORMATTERS) {
			safeSpawnAsync.mockClear();
			clearFormatterCache();
			try {
				await formatter.detect(cwd);
			} catch {
				// A detection that throws probed whatever it probed before throwing;
				// the recorded calls are still the fact under test.
			}
			const probed = new Set(
				safeSpawnAsync.mock.calls
					.filter((call) => call[0] === finder())
					.map((call) => (call[1] as string[])[0])
					.filter((command): command is string => Boolean(command)),
			);
			const allowed = new Set<string>([
				formatter.command[0] ?? "",
				...(EXTRA_PROBED_COMMANDS[formatter.name] ?? []),
			]);
			for (const command of probed) {
				if (!allowed.has(command)) {
					unexpected.push(`${formatter.name} probes ${command}`);
				}
			}
		}

		expect(
			unexpected,
			[
				"These formatters probe a binary the #1495 poison guard cannot see:",
				"it matches a stalled probe against command[0] only. Either the probe",
				"belongs to the formatter's own binary, or list it in",
				"EXTRA_PROBED_COMMANDS with the reason (install fallback vs co-equal",
				"alternative — the second shape is the residual tracked in #1539).",
			].join(" "),
		).toEqual([]);
	});

	it("the declared extras all belong to real formatters", () => {
		// A stale entry here would quietly widen the allowance for a formatter that
		// no longer exists, or mask a rename.
		const names = new Set(ALL_FORMATTERS.map((f) => f.name));
		const orphans = Object.keys(EXTRA_PROBED_COMMANDS).filter(
			(name) => !names.has(name),
		);
		expect(orphans, "delete these stale EXTRA_PROBED_COMMANDS entries").toEqual(
			[],
		);
	});
});
