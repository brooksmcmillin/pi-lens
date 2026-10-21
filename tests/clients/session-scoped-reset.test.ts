import { afterEach, expect, it, vi } from "vitest";

// #4546: a fresh graph must not inherit the preceding cell's global cooldown.
afterEach(async () => {
	const { resetSpawnTimeoutCooldowns } =
		await import("../../clients/spawn-timeout-cooldown.js");
	resetSpawnTimeoutCooldowns();
});

it("a fresh module graph re-arms a prior cell's timeout through the session reset", async () => {
	const prior = await import("../../clients/spawn-timeout-cooldown.js");
	prior.noteSpawnTimeout({
		tool: "markdownlint",
		command: "markdownlint-cli2",
		phase: "availability",
	});
	vi.resetModules();
	const later = await import("../../clients/spawn-timeout-cooldown.js");
	expect(later).not.toBe(prior);
	expect(later.isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(true);
	const { resetSessionScopedState } =
		await import("../../clients/runtime-session.js");
	resetSessionScopedState();
	expect(later.isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(false);
	expect(prior.isInSpawnTimeoutCooldown("markdownlint-cli2")).toBe(false);
});
