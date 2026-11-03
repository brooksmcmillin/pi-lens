/**
 * #4687 item 7: `tools.lazy` takes true | "auto" | false, default true (the
 * maintainer's 2026-10-21 decision; "auto" and false are opt-in).
 *
 * One fixture per form a config file can hold (`tests/fixtures/tools-lazy-config/`),
 * each parsed by the real global loader and resolved through the real flag
 * registry. Every form an older release wrote (`true`, `false`, absent) must
 * keep its meaning: `false` is still `--no-lazy-tools`, and `true` is still
 * the lazy posture on every model.
 *
 * Recurrences:
 * - widening a boolean registry row silently re-reads an old config (an old
 *   `false` that no longer turns the flag on, or an old `true` or an absent
 *   key that now follows the model, as #4723 r1's "auto" default did);
 * - a malformed value that falls back to the default with no record (the
 *   silent-default shape this loader's `warnInvalid` exists for);
 * - "auto" in a project file honored, or dropped without the global-only note.
 *
 * Reports are read from the real degradation ledger, which every
 * `warnIgnoredConfigOnce` writes before its warn-once latch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
} from "../../clients/lens-config.js";
import { readLazyToolsSetting } from "../../clients/lens-flag-registry.js";
import { loadPiLensProjectConfig } from "../../clients/project-lens-config.js";
import {
	lazyToolsApply,
	type LazyToolsMode,
	resolveLazyToolsMode,
} from "../../clients/tool-set-policy.js";
import { removeTempDirSync } from "./test-utils.js";

const FIXTURES = path.resolve(
	import.meta.dirname,
	"../fixtures/tools-lazy-config",
);

/** Every `config-ignored` reason the ledger holds. */
function ignoredReasons(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "config-ignored")
		.flatMap((group) => group.latestReasons.map((entry) => entry.reason));
}

beforeEach(() => {
	resetDegradationLedger();
	resetIgnoredConfigWarnCache();
});

describe("tools.lazy config forms (#4687 item 7)", () => {
	it.each([
		// fixture, parsed value, --no-lazy-tools, mode
		["lazy-true.json", true, false, "on"],
		["lazy-false.json", false, true, "off"],
		["lazy-auto.json", "auto", false, "auto"],
		["lazy-absent.json", undefined, false, "on"],
	] as const)(
		"%s parses to %s and resolves --no-lazy-tools=%s, mode %s",
		(fixture, parsed, noLazyTools, mode) => {
			const config = loadPiLensGlobalConfig(path.join(FIXTURES, fixture));
			expect(readLazyToolsSetting(config)).toBe(parsed);
			const flag = resolvePiLensFlag("no-lazy-tools", undefined, config);
			expect(flag).toBe(noLazyTools);
			expect(
				resolveLazyToolsMode(flag === true, readLazyToolsSetting(config)),
			).toBe(mode);
			expect(ignoredReasons()).toEqual([]);
		},
	);

	it("a malformed value is reported and the default (on) applies", () => {
		const config = loadPiLensGlobalConfig(
			path.join(FIXTURES, "lazy-malformed.json"),
		);
		expect(readLazyToolsSetting(config)).toBeUndefined();
		expect(resolvePiLensFlag("no-lazy-tools", undefined, config)).toBe(false);
		expect(resolveLazyToolsMode(false, readLazyToolsSetting(config))).toBe(
			"on",
		);
		expect(ignoredReasons()).toEqual([
			'tools.lazy must be "auto", true, or false',
		]);
	});

	it("the CLI flag outranks every config form", () => {
		for (const fixture of ["lazy-true.json", "lazy-auto.json"]) {
			const config = loadPiLensGlobalConfig(path.join(FIXTURES, fixture));
			const flag = resolvePiLensFlag("no-lazy-tools", true, config);
			expect(flag, fixture).toBe(true);
			expect(
				resolveLazyToolsMode(flag === true, readLazyToolsSetting(config)),
				fixture,
			).toBe("off");
		}
	});
});

describe("tools.lazy in a project file (#4687 item 7)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tools-lazy-"));
	});
	afterEach(() => removeTempDirSync(tmpDir));

	it('"auto" is reported as global-only and never honored', () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ tools: { lazy: "auto" } }),
		);
		const project = loadPiLensProjectConfig(tmpDir);
		expect(
			ignoredReasons().some((reason) =>
				reason.includes('"tools.lazy" is a global-only'),
			),
		).toBe(true);
		expect(
			resolvePiLensFlag("no-lazy-tools", undefined, undefined, project),
		).toBe(false);
	});
});

describe("lazyToolsApply decides per model only under auto (#4687 item 7)", () => {
	const midConvo = { compat: { supportsMidConvoSystemMessages: true } };
	it.each([
		["auto", midConvo, true],
		["auto", { compat: { supportsMidConvoSystemMessages: false } }, false],
		// A missing fact is false: every tool active.
		["auto", { compat: {} }, false],
		["auto", {}, false],
		// #4723 F1: NO resolved model is not a model without the fact. Nothing
		// is known, so the configured default (lazy) holds until a model_select
		// re-decides; r1 made it eager, and every driver naming no model (the
		// fork-tree witness on CI) saw every tool active.
		["auto", undefined, true],
		["auto", null, true],
		// Only the boolean `true` counts, never a truthy spelling.
		["auto", { compat: { supportsMidConvoSystemMessages: "true" } }, false],
		["on", undefined, true],
		["on", {}, true],
		["off", midConvo, false],
	] as const)("mode %s with model %j is lazy=%s", (mode, model, lazy) => {
		expect(
			lazyToolsApply(
				mode as LazyToolsMode,
				model as Parameters<typeof lazyToolsApply>[1],
			),
		).toBe(lazy);
	});
});
