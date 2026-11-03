import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { withRealPi } from "../support/real-pi-harness.js";

function documentedToolBaselines(): { active: string[]; lazy: string[] } {
	const docs = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../docs/agent-tools.md",
		),
		"utf8",
	);
	const lazyStart = docs.indexOf("Five situational tools");
	const section = docs.slice(
		lazyStart,
		docs.indexOf("are registered", lazyStart),
	);
	// #4906: the count in the heading changes with the roster ("Five" became
	// "Seven"), and a stale literal made indexOf -1, an empty baseline and a
	// roster check that passed vacuously. Anchor on the count-free phrase and
	// refuse an empty parse.
	const activeSection = docs.slice(
		docs.search(/\w+ tools stay always-active/),
		lazyStart,
	);
	const active = [...activeSection.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
		(match) => match[1],
	);
	const lazy = [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
		(match) => match[1],
	);
	if (lazyStart < 0 || active.length === 0 || lazy.length === 0) {
		throw new Error(
			"docs/agent-tools.md: the always-active or situational tool list was not found",
		);
	}
	// A tool the doc omits is also filtered out of the observed roster, so the
	// roster check alone cannot see it missing: pin both lists to the registry.
	// The loader tool is documented in its own sentence, outside both lists.
	const piTools = TOOL_REGISTRY.filter(
		(tool) => tool.piName && tool.piName !== "pi_lens_activate_tools",
	);
	expect([...active].sort()).toEqual(
		piTools
			.filter((tool) => !("situational" in tool))
			.map((tool) => tool.piName)
			.sort(),
	);
	expect([...lazy].sort()).toEqual(
		piTools
			.filter((tool) => "situational" in tool)
			.map((tool) => tool.piName)
			.sort(),
	);
	return { active, lazy };
}

// The provider observation's tools are wire objects ({ name, ...bytes }); the
// roster assertion compares NAMES.
function observedRoster(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []).flatMap((tool) =>
		typeof (tool as { name?: unknown }).name === "string"
			? [(tool as { name: string }).name]
			: [],
	);
}

// flake-shape: real-process-spawn — the real host must load the built extension and preserve its tool roster across turns
describe("real pi harness: load and tool-set restore", () => {
	it("loads commands and restores the baseline across a second turn", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json" },
			async (pi) => {
				const baseline = documentedToolBaselines();
				await pi.newSession();
				await pi.prompt("run the scripted turn");
				await pi.awaitAssistantTurn();
				// release-qa's codemode row reads the user text a request carried to
				// witness an injected turn_end check; the provider must record it.
				expect(
					JSON.stringify(pi.providerObservations().at(-1)?.userMessages),
				).toContain("run the scripted turn");
				const active = observedRoster(pi);
				expect(
					active
						.filter((name) =>
							[...baseline.active, ...baseline.lazy].includes(name),
						)
						.sort(),
				).toEqual([...baseline.active].sort());
				await pi.prompt("run the second scripted turn");
				await pi.awaitAssistantTurn();
				expect(pi.toolResults()).toEqual([]);
				const second = observedRoster(pi);
				expect(second).toEqual(active);
			},
		);
	}, 60_000);
});
