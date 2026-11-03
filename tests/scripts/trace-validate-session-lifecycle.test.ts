import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyTraceOutput,
	extractTraces,
	firstUnmatchedEvent,
	loadTraces,
	readJsonRecords,
	renderTraceConfig,
	renderTraceModule,
	runCli,
	unsupportedReason,
	type TraceEvent,
} from "../../scripts/trace-validate-session-lifecycle.mjs";

// The JVM half (TLC deciding producible / not-producible) is measured in the
// PR body and docs/adr/0010; it needs the pinned jar, which the Unit tests lane
// does not carry. Everything below is the part that decides WHAT TLC is asked.

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fixtures = path.join(
	root,
	"tests/fixtures/trace-validation/session-lifecycle",
);
const read = (name: string) =>
	fs.readFileSync(path.join(fixtures, name), "utf8");
type Row = {
	phase: string;
	pid: number;
	metadata: Record<string, unknown>;
};
const recorded = () =>
	readJsonRecords(read("lifecycle-drive.rows.json")) as Row[];

describe("trace validation, session-lifecycle pilot (#3533)", () => {
	// Recurrence prevented: the extractor reading a `logScopeTransition` field
	// that was renamed would turn every real run into an empty, trivially
	// "valid" trace. The fixture is the real lifecycle witness's two processes
	// (tests/real-harness/lifecycle.test.ts); the expected events are written
	// from that test's `expectedTransitions`, not from the extractor.
	it("turns the recorded real lifecycle run into its two processes' events", () => {
		const traces = extractTraces(recorded());
		expect(traces.map((t) => t.rejected)).toEqual([[], []]);
		expect(traces.map((t) => t.events)).toEqual([
			[
				{ a: "retire", k: "reload", scope: 1 },
				{
					a: "begin",
					k: "reload",
					scope: 2,
					role: "primary",
					parent: 1,
					src: "slot",
					sameAs: [1],
				},
				{ a: "retire", k: "new", scope: 2 },
				{
					a: "begin",
					k: "new",
					scope: 3,
					role: "primary",
					parent: 2,
					src: "other",
					sameAs: [],
				},
				{ a: "retire", k: "quit", scope: 3 },
			],
			[
				{ a: "retire", k: "fork", scope: 1 },
				{
					a: "begin",
					k: "fork",
					scope: 2,
					role: "primary",
					parent: 1,
					src: "slot",
					sameAs: [],
				},
				{ a: "retire", k: "quit", scope: 2 },
			],
		]);
	});

	// Recurrence prevented: a gate that lists the spellings it knows to refuse
	// (principles §1, "Gates fail closed"). Every row form the pilot does not
	// model must refuse the trace, not be skipped, or a run with a /tree or a
	// subagent in it would be "checked" with the interesting rows missing.
	// Each case also asserts the gate that refuses it. A start row built from the
	// shutdown row below lacks `handoffSource`, so without valid later-stage
	// fields every start case is refused by the hand-off gate and the case
	// still passes with its own gate deleted (PR #4824 review, CodeRabbit).
	const validStart = {
		transition: "start",
		scopeId: 3,
		parentScopeId: 2,
		handoffSource: "none",
	};
	it.each([
		[
			"a /tree move",
			{ transition: "tree", reason: "tree" },
			/row form is not admitted/,
		],
		[
			"a secondary scope",
			{ role: "secondary" },
			/role secondary is not modelled/,
		],
		[
			"a started scope ended without a shutdown",
			{ transition: "end", reason: "superseded", scopeId: 2 },
			/a started scope ended without a shutdown/,
		],
		[
			"a start with no session id",
			{ ...validStart, reason: "reload", sessionId: undefined },
			/start without a session id, or after a branch move/,
		],
		[
			"a start after a branch move",
			{ ...validStart, reason: "reload", branchEpoch: 1 },
			/start without a session id, or after a branch move/,
		],
		[
			"a start reason the pilot does not model",
			{ ...validStart, reason: "clone" },
			/start reason is not modelled/,
		],
		[
			"a shutdown reason the pilot does not model",
			{ transition: "shutdown", reason: "idle" },
			/shutdown reason or scope is not modelled/,
		],
	])("refuses %s instead of dropping the row", (_name, patch, gate) => {
		const rows = recorded();
		// Row 2 is the first process's shutdown:reload of scope 2.
		rows[2] = {
			...rows[2],
			metadata: { ...rows[2].metadata, ...patch },
		};
		expect(extractTraces(rows)[0]?.rejected.join(" ")).toMatch(gate);
	});

	// Control: the valid start fields alone are admitted, so the cases above are
	// refused for the field they change and not for the shared fixture.
	it("admits the shared start fields the refusal cases build on", () => {
		const rows = recorded();
		rows[2] = {
			...rows[2],
			metadata: { ...rows[2].metadata, ...validStart, reason: "reload" },
		};
		expect(extractTraces(rows)[0]?.rejected).toEqual([]);
	});

	// Recurrence prevented: pi's jiti load re-creates the coordinator on
	// /reload, so the successor's `parentScopeId` is its own construction scope
	// (bridge-reload-ts shape, probed 2026-10-24), never the predecessor's
	// ticket. Checking it as a lineage edge would reject every such run.
	it("leaves a re-created coordinator's construction scope out of the lineage", () => {
		const row = (m: Record<string, unknown>) => ({
			phase: "session_scope_transition",
			pid: 7,
			metadata: { role: "primary", branchEpoch: 0, ...m },
		});
		const [trace] = extractTraces([
			row({ transition: "end", reason: "superseded", scopeId: 1 }),
			row({
				transition: "start",
				reason: "startup",
				scopeId: 2,
				parentScopeId: 1,
				sessionId: "s",
				handoffSource: "none",
			}),
			row({ transition: "shutdown", reason: "reload", scopeId: 2 }),
			row({ transition: "end", reason: "superseded", scopeId: 3 }),
			row({
				transition: "start",
				reason: "reload",
				scopeId: 4,
				parentScopeId: 3,
				sessionId: "s",
				handoffSource: "slot",
			}),
		]);
		expect(trace?.rejected).toEqual([]);
		expect(trace?.events[1]).toMatchObject({ a: "begin", scope: 2, parent: 0 });
	});

	// Recurrence prevented: RetireOk's `k \notin used` bound. A second /reload
	// is outside the model's language for a reason that is not drift, and TLC
	// would report it as "not producible"; the pilot says why instead.
	it("names the model bound a repeated retire reason runs into", () => {
		const reload = { a: "retire", k: "reload", scope: 1 } as const;
		expect(unsupportedReason([reload, { ...reload, scope: 2 }])).toMatch(
			/once per behaviour/,
		);
		expect(unsupportedReason([reload])).toBeUndefined();
		expect(unsupportedReason([])).toBe("no events");
	});

	// Recurrence prevented: a value from a row reaching the TLA+ text. The
	// module is built only from validated fields.
	it("renders only validated fields into the TLA+ module", () => {
		const events = extractTraces(recorded())[0]?.events as TraceEvent[];
		const text = renderTraceModule(events);
		expect(text).toContain(
			'[a |-> "begin", k |-> "reload", scope |-> 2, role |-> "primary", parent |-> 1, src |-> "slot", sameAs |-> {1}]',
		);
		expect(() =>
			renderTraceModule([
				{ a: "retire", k: 'reload"], x |-> [', scope: 1 },
			] as TraceEvent[]),
		).toThrow(/bad retire event/);
		// The #4815 continuation renders as an event but the module has no
		// disjunct that can match it: the model has no action for it.
		expect(text).not.toContain('ev.a = "continue"');
	});

	// Recurrence prevented: a second copy of the as-built constants drifting
	// from switch-pins.json. The config is Merged.cfg's own text.
	it("derives the trace config from Merged.cfg", () => {
		const base = fs.readFileSync(
			path.join(root, "formal/session-lifecycle/Merged.cfg"),
			"utf8",
		);
		const config = renderTraceConfig(base, 5);
		const fixParts = base.split("\n").find((l) => l.includes("FixParts ="));
		expect(config).toContain(fixParts as string);
		expect(config).toContain("    MaxSteps = 5");
		expect(config).toContain("    Writers = {}");
		expect(config).toContain("SPECIFICATION TSpec\nINVARIANT NotDone\n");
		expect(config).not.toMatch(/INVARIANTS|\* expect/);
		expect(() =>
			renderTraceConfig(base.replace("expect: pass", "expect: violated X"), 5),
		).toThrow(/no longer expects pass/);
	});

	// Recurrence prevented: reading TLC's inverted verdict the wrong way round.
	// The strings are the literal lines of the 2026-10-24 measured runs.
	it("reads NotDone violated as producible and a clean finish as not", () => {
		expect(
			classifyTraceOutput(
				"Error: Invariant NotDone is violated.\nThe behavior up to this point is:",
			),
		).toEqual({ status: "producible" });
		expect(
			classifyTraceOutput(
				"Model checking completed. No error has been found.\nThe depth of the complete state graph search is 3.\n",
			),
		).toEqual({ status: "not-producible", searchDepth: 3 });
		expect(classifyTraceOutput("Error: parsing failed")).toMatchObject({
			status: "error",
		});
	});

	// Recurrence prevented: the unobserved session_before_fork level. Reading
	// the raw depth named event 3 (retire quit) for a drift at event 2.
	it("places the first unmatched event past the hidden before-fork level", () => {
		const events = extractTraces(recorded())[1]?.events as TraceEvent[];
		expect(firstUnmatchedEvent(events, 3)).toBe(2);
		expect(firstUnmatchedEvent(events, 4)).toBe(3);
		const reload = extractTraces(recorded())[0]?.events as TraceEvent[];
		expect(firstUnmatchedEvent(reload, 2)).toBe(2);
	});

	// The acceptance case of #3533: the #4815 interleaving as events.
	it("ships the #4815 shapes as the two event fixtures", () => {
		const transitions = JSON.parse(read("reload-no-continuation.events.json"));
		const withContinuation = JSON.parse(
			read("reload-ctx-continuation-4815.events.json"),
		);
		expect(withContinuation.slice(0, transitions.length)).toEqual(transitions);
		expect(withContinuation.at(-1)).toEqual({
			a: "continue",
			scope: 1,
			effect: "ctx-read",
		});
	});
});

describe("trace validation inputs fail closed (#3533 round 2)", () => {
	const startRow = (m: Record<string, unknown>): Row => ({
		phase: "session_scope_transition",
		pid: 9,
		metadata: { role: "primary", branchEpoch: 0, sessionId: "s", ...m },
	});
	// The second recorded process: startup, then a /fork. Row 3 is the fork start.
	const forkProcess = () => recorded().filter((r) => r.pid === 1475275);
	const withForkStart = (patch: Record<string, unknown>) => {
		const rows = forkProcess();
		rows[3] = { ...rows[3], metadata: { ...rows[3].metadata, ...patch } };
		return rows;
	};
	const without = (field: string) => {
		const rows = forkProcess();
		const metadata = { ...rows[3].metadata };
		delete metadata[field];
		rows[3] = { ...rows[3], metadata };
		return rows;
	};

	// Recurrence prevented: F1 of the PR #4824 review. `--rows` over an empty
	// file, another phase, or a renamed phase literal produced zero traces and
	// the CLI printed nothing and exited 0, also under `--expect not-producible`.
	it.each([
		["an empty array", "[]"],
		["rows of another phase", JSON.stringify([{ phase: "other", pid: 1 }])],
		[
			"rows whose phase literal was renamed",
			JSON.stringify(recorded().map((r) => ({ ...r, phase: "scope_move" }))),
		],
	])("refuses %s as an empty trace population, naming the file", (_n, text) => {
		expect(() =>
			loadTraces(text, { kind: "rows", file: "x.rows.json" }),
		).toThrow(/x\.rows\.json: no session_scope_transition rows/);
	});
	it("refuses an empty event list too", () => {
		expect(() => loadTraces("[]", { kind: "events", file: "e.json" })).toThrow(
			/e\.json: no events/,
		);
	});

	// Recurrence prevented: F6 / CR4. Unparseable JSON and an unknown event
	// kind escaped `main()` as an uncaught error and exit 1, the code that
	// means "not producible".
	it("names unparseable JSON with the file instead of a bare SyntaxError", () => {
		expect(() =>
			loadTraces("{not json", { kind: "rows", file: "bad.json" }),
		).toThrow(/bad\.json: unparseable JSON/);
	});
	it("refuses an unknown event kind as an unchecked trace", () => {
		const [trace] = loadTraces('[{"a":"bogus"}]', {
			kind: "events",
			file: "e.json",
		});
		expect(trace?.rejected.join(" ")).toMatch(/unknown event kind/);
	});

	// Recurrence prevented: F1 and F6 at the exit-code level. The CLI exited 0
	// for an empty population and 1 (the "not producible" code) for unparseable
	// input. None of these paths reaches the JVM, so no jar is needed.
	describe("the CLI exits 2 before any JVM is started", () => {
		const run = async (text: string | undefined, ...flags: string[]) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-trace-cli-"));
			try {
				const file = path.join(dir, "input.json");
				if (text !== undefined) fs.writeFileSync(file, text);
				const lines: string[] = [];
				const code = await runCli(["--rows", file, ...flags], (l) =>
					lines.push(l),
				);
				return { code, out: lines.join("\n").replaceAll(dir, "<dir>") };
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		};
		it.each([
			["producible", "[]"],
			["not-producible", "[]"],
			["not-producible", JSON.stringify([{ phase: "other", pid: 1 }])],
		])("--expect %s over zero traces: %s", async (expectation, text) => {
			const { code, out } = await run(text, "--expect", expectation);
			expect(code).toBe(2);
			expect(out).toBe(
				"UNCHECKED <dir>/input.json: no session_scope_transition rows",
			);
		});
		it("unparseable JSON and a missing file are unchecked, not an uncaught error", async () => {
			expect((await run("{not json")).code).toBe(2);
			expect((await run(undefined)).out).toMatch(/^UNCHECKED .*ENOENT/);
		});
		it("an unknown flag is a usage error", async () => {
			const lines: string[] = [];
			expect(await runCli(["--bogus"], (l) => lines.push(l))).toBe(2);
			expect(lines.join("\n")).toMatch(/usage: --rows/);
		});
	});

	// Recurrence prevented: F3 / CR2. A start row that lost `handoffSource` or
	// `parentScopeId` was coerced to `other` / parent 0 and then compared.
	it.each([
		["handoffSource is absent", () => without("handoffSource")],
		[
			"handoffSource is a value the pilot does not know",
			() => withForkStart({ handoffSource: "weird" }),
		],
		["parentScopeId is absent", () => without("parentScopeId")],
		[
			"parentScopeId is not an integer",
			() => withForkStart({ parentScopeId: "1" }),
		],
		[
			"parentScopeId names a scope that never started",
			() => withForkStart({ parentScopeId: 77 }),
		],
	])("refuses a start row whose %s", (_name, build) => {
		expect(extractTraces(build())[0]?.rejected).not.toEqual([]);
	});
	// Recurrence prevented: a membership check alone admits a parent id that
	// is not an integer when the construction row carried the same value.
	it("refuses a non-integer parentScopeId even when a construction row carried it", () => {
		const rows = forkProcess().map((r) => ({
			...r,
			metadata: { ...r.metadata },
		}));
		rows[0].metadata.scopeId = "x";
		rows[1].metadata.parentScopeId = "x";
		rows[1].metadata.scopeId = "y";
		rows[2].metadata.scopeId = "y";
		rows[3].metadata.parentScopeId = "y";
		const trace = extractTraces(rows)[0];
		expect(trace?.rejected.join(" ")).toMatch(/parentScopeId/);
	});
	it.each([
		["slot", "slot"],
		["own-sidecar", "other"],
		["parent-sidecar", "other"],
		["none", "other"],
	])("admits handoffSource %s as src %s", (source, src) => {
		const [trace] = extractTraces(withForkStart({ handoffSource: source }));
		expect(trace?.rejected).toEqual([]);
		expect(trace?.events[1]).toMatchObject({ a: "begin", src });
	});

	// Recurrence prevented: F9. A refused start left its scope without a ticket,
	// so the same scope's shutdown was reported as "not modelled": a false second
	// reason beside the real one.
	it("reports one reason for a refused start, not a second for its shutdown", () => {
		const rejected = extractTraces(without("parentScopeId"))[0]?.rejected;
		expect(rejected).toHaveLength(1);
		expect(rejected?.[0]).toMatch(/start:fork scope 3: parentScopeId/);
	});

	// Recurrence prevented: F4. RetireOk("resume") needs `sess[primary] # "A"`
	// and Begin("resume") sets `sess` to "A", the startup session. A resume of
	// a session that is not the startup one is outside the model. The extractor
	// maps session ids to earlier tickets: a previously unseen session has an
	// empty sameAs, a non-startup session seen earlier in the process has that
	// scope's ticket and not 1. TLC cannot match either.
	it("maps a resume of a non-startup session to its own tickets, not the startup one", () => {
		const prefix = [
			startRow({ transition: "end", reason: "superseded", scopeId: 1 }),
			startRow({
				transition: "start",
				reason: "startup",
				scopeId: 2,
				parentScopeId: 1,
				handoffSource: "none",
			}),
			startRow({ transition: "shutdown", reason: "new", scopeId: 2 }),
			startRow({
				transition: "start",
				reason: "new",
				scopeId: 3,
				parentScopeId: 2,
				sessionId: "n",
				handoffSource: "none",
			}),
			startRow({ transition: "shutdown", reason: "resume", scopeId: 3 }),
		];
		const resume = (sessionId: string) =>
			extractTraces([
				...prefix,
				startRow({
					transition: "start",
					reason: "resume",
					scopeId: 4,
					parentScopeId: 3,
					sessionId,
					handoffSource: "none",
				}),
			])[0]?.events.at(-1);
		expect(resume("s")).toMatchObject({ k: "resume", sameAs: [1] });
		expect(resume("foreign")).toMatchObject({ k: "resume", sameAs: [] });
		expect(resume("n")).toMatchObject({ k: "resume", sameAs: [2] });
	});
});

describe("the generated Obs and TNext carry every conjunct (#3533 round 2)", () => {
	// Recurrence prevented: F2. The verdict path (Obs, TNext) had no JVM-free
	// pin, so deleting a conjunct left the suite green and only widened what
	// TLC accepts. Comment lines are blanked first so a comment cannot satisfy
	// a requirement.
	const moduleText = () => {
		const events = extractTraces(recorded())[0]?.events as TraceEvent[];
		return renderTraceModule(events)
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("\\*"))
			.map((line) => line.replace(/\s+/g, " ").trim())
			.join("\n");
	};
	// Recurrence prevented: F7. Presence pins cannot see an ADDED disjunct: a
	// planted `\/ TRUE` in Obs left every pin green and made the planted code
	// drift check pass. The whole block is compared, so any edit reds.
	it("is exactly this Obs, TNext, TSpec and NotDone block", () => {
		const text = moduleText();
		const block = text.slice(
			text.indexOf("Obs(ev) =="),
			text.indexOf("====") === -1 ? undefined : text.indexOf("===="),
		);
		expect(block).toBe(
			[
				String.raw`Obs(ev) ==`,
				String.raw`\/ /\ ev.a = "retire"`,
				String.raw`/\ primary = ev.scope /\ primary' = 0`,
				String.raw`/\ pend'.k = ev.k /\ why'[ev.scope] = ev.k`,
				String.raw`\/ /\ ev.a = "begin"`,
				String.raw`/\ primary = 0 /\ pend.k = ev.k`,
				String.raw`/\ primary' = ev.scope /\ role'[ev.scope] = ev.role`,
				String.raw`/\ (ev.parent = 0 \/ predOf'[ev.scope] = ev.parent)`,
				String.raw`/\ (taken' # taken) <=> (ev.src = "slot")`,
				String.raw`/\ \A u \in 1..(ev.scope - 1) : (sess'[u] = sess'[ev.scope]) <=> (u \in ev.sameAs)`,
				String.raw`TNext ==`,
				String.raw`\/ /\ ti < Len(TR) /\ Next /\ Obs(TR[ti + 1]) /\ ti' = ti + 1`,
				String.raw`\/ /\ ti < Len(TR) /\ TR[ti + 1].a = "retire" /\ TR[ti + 1].k \in {"fork", "clone"}`,
				String.raw`/\ forking = "no" /\ Next /\ forking' # "no" /\ ti' = ti`,
				String.raw`TSpec == (Init /\ ti = 0) /\ [][TNext]_<<vars, ti>>`,
				String.raw`NotDone == ti < Len(TR)`,
				"",
			].join("\n"),
		);
	});
	it("pins the hand-off-source conjunct on the verdict path", () => {
		expect(moduleText()).toContain(
			String.raw`/\ (taken' # taken) <=> (ev.src = "slot")`,
		);
	});
});
