/**
 * #5014 (shape 10): `unansweredPrimaries` is the one rule every collecting LSP
 * read (touchFile, getDiagnostics) uses to name the primaries that did not
 * answer. Recurrence it prevents: it returned "none missing" whenever ANY
 * non-auxiliary server was acquired, so python-jedi (a `fallbackFor: "python"`
 * alternate) answering beside a trust-refused or failed `python` made the file
 * read "Primary LSP (python): confirmed clean."
 *
 * Pure table: the acquired set and the roots the attempt resolved are the
 * inputs, no process is spawned. The end-to-end rows (real MCP server, real
 * spawn failure, adopted-root refusal) live in tests/mcp/server.smoke.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { registerLSPConfig } from "../../../clients/lsp/config.js";
import { unansweredPrimaries } from "../../../clients/lsp/index.js";
import {
	resetSessionRootsForTests,
	setSessionRootConfig,
} from "../../../clients/lsp/session-roots.js";
import {
	DenoServer,
	LSP_SERVERS,
	OpengrepServer,
	PythonJediServer,
	PythonServer,
} from "../../../clients/lsp/server.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";
import { assertNonEmptyScan } from "../../support/sweep-kit.js";

const FILE = "/proj/pkg/probe.py";
const acquired = (...infos: LSPServerInfo[]) =>
	infos.map((info) => ({ info, client: {} as never }));
const roots = (...ids: string[]) =>
	new Map(ids.map((id) => [id, "/proj"] as const));

afterEach(() => resetSessionRootsForTests());

// The registered alternates: typescript/deno, python/python-jedi, csharp,
// elixir and docker. An empty population must fail, not pass on nothing.
const ALTERNATES = LSP_SERVERS.filter(
	(server) => server.fallbackFor !== undefined,
).map((server) => [server.id, server.fallbackFor as string] as const);
assertNonEmptyScan("registered fallbackFor alternates", ALTERNATES.length, 5);

describe("unansweredPrimaries names the owner a fallback stood in for (#5014)", () => {
	it.each([
		{
			name: "owner rooted and not acquired, fallback acquired: the owner is missing",
			spawned: [PythonJediServer],
			rooted: ["python", "python-jedi"],
			expected: ["python"],
		},
		{
			name: "fallback beside an auxiliary, owner not acquired: still missing",
			spawned: [PythonJediServer, OpengrepServer],
			rooted: ["python", "python-jedi"],
			expected: ["python"],
		},
		{
			// The pre-#5014 rule, kept: an acquired non-alternate primary answers
			// for the file even when another rooted member was never acquired.
			name: "the owner itself acquired: nothing missing",
			spawned: [PythonServer],
			rooted: ["python", "python-jedi"],
			expected: [],
		},
		{
			name: "owner and fallback both acquired: the owner answered",
			spawned: [PythonServer, PythonJediServer],
			rooted: ["python", "python-jedi"],
			expected: [],
		},
		{
			name: "nothing acquired: every rooted primary is missing",
			spawned: [],
			rooted: ["python", "python-jedi"],
			expected: ["python", "python-jedi"],
		},
		{
			name: "only an auxiliary acquired: every rooted primary is missing",
			spawned: [OpengrepServer],
			rooted: ["python", "python-jedi"],
			expected: ["python", "python-jedi"],
		},
		{
			// The deno shape: the owner (typescript) found no root, so it never
			// resolved one and the alternate is the file's only candidate.
			name: "owner resolved no root, fallback acquired: nothing is missing",
			spawned: [DenoServer],
			rooted: ["deno"],
			expected: [],
		},
	])("$name", ({ spawned, rooted, expected }) => {
		expect(
			unansweredPrimaries(acquired(...spawned), roots(...rooted), FILE)
				.serverIds,
		).toEqual(expected);
	});

	// Shape 10 population: every registered `fallbackFor` alternate (deno,
	// python-jedi, the C#, Elixir and Docker alternates), not only python's.
	it.each(ALTERNATES)(
		"%s answering for a rooted owner %s never stands in for it",
		(alternate, owner) => {
			const info = LSP_SERVERS.find((server) => server.id === alternate);
			expect(info).toBeDefined();
			expect(
				unansweredPrimaries(
					acquired(info as LSPServerInfo),
					roots(owner, alternate),
					FILE,
				).serverIds,
			).toEqual([owner]);
		},
	);

	it("carries the unstarted cause for a missing owner a fallback replaced", () => {
		expect(
			unansweredPrimaries(
				acquired(PythonJediServer),
				roots("python", "python-jedi"),
				FILE,
			).cause,
		).toBe("unstarted");
	});

	it("admits a fallback standing in for an owner the operator turned off", () => {
		// The operator chose jedi: its answer is the file's primary answer.
		setSessionRootConfig(
			"/proj",
			registerLSPConfig({ disabledServers: ["python"] }),
		);
		expect(
			unansweredPrimaries(
				acquired(PythonJediServer),
				roots("python-jedi"),
				FILE,
			).serverIds,
		).toEqual([]);
	});

	it("still names a disabled owner whose fallback did not answer either", () => {
		setSessionRootConfig(
			"/proj",
			registerLSPConfig({ disabledServers: ["python"] }),
		);
		const result = unansweredPrimaries(acquired(), roots("python-jedi"), FILE);
		expect(result.serverIds).toEqual(["python-jedi", "python"]);
		expect(result.cause).toBe("disabledFallback");
	});
});
