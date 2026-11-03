import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import piLens from "../index.js";
import { type PiRunner, startPiRunner } from "./support/pi-runner.js";
import { createPiMock, makeCtx, type PiMock } from "./support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { useConfigPath } from "./support/global-config.js";
const setConfigPath = useConfigPath();
const fixture = piSessionFixture();

// Template for #171: a command test driven through the shared harnesses — no
// bespoke ExtensionAPI mock. Run the real entry, then invoke the registered
// command handler and assert captured UI calls.
//
// #4913 moved the "session started with --no-lens" case to tier 2
// (`tests/index-4913-cli-flag-timing.test.ts`): the double applies a flag value
// before the factory runs, and pi applies it after.
//
// #4632 slice 9 moved the REGISTRATION case onto tier 1: the real host's
// loader holds the flags and resolves the commands, so a command that pi drops
// (or a name it prefixes) is a red here, not a value the double recorded.
//
// #4913 L3 moved the TOGGLE case to tier 2 with a recording UI: a real session
// binds a UI context only when `captureUi` is set (without it, pi binds
// `mode: "print"` with `hasUI() === false` and `notifyUi` suppresses the text).
// The two WIDGET cases stay on the double, class `real-ui-harness`: they assert
// the `ctx.ui.setWidget` calls, and the tier-2 recorder captures notifications
// and status lines only. A widget recorder would be a new tier-2 hook, which
// this lane does not build (review F4 on #4702).

const tmpDirs: string[] = [];
let runner: PiRunner;

beforeAll(async () => {
	runner = await startPiRunner();
});

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-toggle-config-"));
	tmpDirs.push(dir);
	setConfigPath(path.join(dir, "missing-config.json"));
});

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

function installLens(): PiMock {
	const pi = createPiMock();
	piLens(pi.asExtensionAPI());
	return pi;
}

describe("lens-toggle command", () => {
	it("registers the single session-level lens toggle command", () => {
		// Tier 1 (#4632 slice 9): the real host's loader and command resolver
		// hold the registration. The claim is the host's registry, not the
		// arguments `index.ts` handed a stand-in.
		expect(runner.getFlags().has("no-lens")).toBe(true);
		const registered = runner
			.getRegisteredCommands()
			.map((command) => command.name);
		expect(registered).toContain("lens-toggle");
		expect(registered).toContain("lens-widget-toggle");
		// The retired single-purpose commands stay gone, so this case fails on a
		// roster that quietly re-adds one.
		for (const retired of [
			"lens-enable",
			"lens-disable",
			"lens-status",
			"lens",
		]) {
			expect(registered).not.toContain(retired);
		}
	});

	it("toggles an enabled session off and back on", async () => {
		// Tier 2 (#4913 L3): `/lens-toggle` runs through pi's own command path in a
		// real session, and the recording UI (`captureUi`) is what `ctx.ui.notify`
		// reaches, so the two notifications are what the host showed.
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "toggle", "proj"),
			captureUi: true,
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});

		await handle.prompt("/lens-toggle");
		await handle.prompt("/lens-toggle");

		expect(handle.notifications).toEqual([
			{
				message:
					"pi-lens disabled for this session. Run /lens-toggle again to resume.",
				type: "warning",
			},
			{
				message: "pi-lens enabled for this session.",
				type: "info",
			},
		]);
		expect(handle.errors).toEqual([]);
	}, 60_000);

	it("toggles the diagnostics widget off and on", async () => {
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);
		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: undefined,
			options: undefined,
		});
		expect(ctx.widgetCalls[1].key).toBe("pi-lens");
		expect(typeof ctx.widgetCalls[1].content).toBe("function");
		expect(ctx.widgetCalls[1].options).toEqual({ placement: "belowEditor" });

		expect(ctx.notifications[0]).toEqual({
			message: "pi-lens widget hidden. Run /lens-widget-toggle to show it.",
			type: "info",
		});
		expect(ctx.notifications[1]).toEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});

	it("starts the diagnostics widget hidden from global config", async () => {
		const configPath = process.env.PI_LENS_CONFIG_PATH;
		expect(configPath).toBeDefined();
		fs.writeFileSync(
			configPath as string,
			JSON.stringify({ widget: { visible: false } }),
			"utf-8",
		);
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: expect.any(Function),
			options: { placement: "belowEditor" },
		});
		expect(ctx.notifications).toContainEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});
});
