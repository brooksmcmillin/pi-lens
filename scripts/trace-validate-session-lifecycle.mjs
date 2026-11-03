#!/usr/bin/env node
/**
 * Trace validation pilot for formal/session-lifecycle (#3533,
 * docs/adr/0010-trace-validation-session-lifecycle.md).
 *
 * A real run's `session_scope_transition` rows (clients/session-scope.ts
 * `logScopeTransition`, read from latency.log) become an event sequence. TLC
 * then checks that SessionLifecycle's own `Next` relation can produce it:
 * the generated module EXTENDS SessionLifecycle, steps `Next` once per event
 * and keeps only the successors an `Obs` predicate accepts. The trace is
 * producible exactly when TLC reports `NotDone` violated, and the invariant
 * is the only thing that decides the verdict (an eval error is never a pass).
 *
 * Fail closed on rows (principles, "Gates fail closed"): a row is admitted
 * only in the short list of forms below; any other row, and any trace whose
 * shape the model's bounds cannot express, is reported and refuses the whole
 * trace. The model's constants are copied from formal/session-lifecycle/
 * Merged.cfg (the as-built config that switch-pins.json pins), never restated.
 *
 * Usage:
 *   node scripts/trace-validate-session-lifecycle.mjs --rows <rows.json> [--jar <tla2tools.jar>] [--expect producible|not-producible]
 *   node scripts/trace-validate-session-lifecycle.mjs --events <events.json> ...
 * `--rows` is a JSON array (or NDJSON) of latency rows; `--events` is a JSON
 * array of already-extracted events (a hand-written negative case).
 * Exit 0 when every trace meets --expect, 1 when one does not, 2 on a usage
 * error, unreadable input, no traces at all, or an unchecked trace.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/is-main-module.mjs";
import { buildJavaArgs, ensureJar } from "./check-tla-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY_DIR = path.join(ROOT, "formal", "session-lifecycle");
const BASE_CONFIG = "Merged.cfg";
const MODEL = "SessionLifecycle";

const START_REASONS = new Set(["new", "resume", "fork", "reload"]);
const RETIRE_REASONS = new Set(["new", "resume", "fork", "reload", "quit"]);
/** `StartSource` of clients/session-scope.ts: the hand-off sources a start row may carry. */
const HANDOFF_SOURCES = new Set([
	"slot",
	"own-sidecar",
	"parent-sidecar",
	"none",
]);

/**
 * Rows -> traces. One trace per process id. Admitted forms, everything else
 * is a `rejected` entry that refuses the trace:
 *   end:superseded   a scope with no start row (a coordinator's construction
 *                    scope); admitted only when no start of that scope exists.
 *   start:startup    the process's first primary start; it is the model's Init.
 *   start:<r>        a later primary start, r in new|resume|fork|reload.
 *   shutdown:<r>     the live primary's shutdown, r in new|resume|fork|reload|quit.
 * A start row must carry a safe-integer `parentScopeId` that names a started
 * scope or a construction scope already seen as `end:superseded`, and a
 * `handoffSource` from HANDOFF_SOURCES; an absent or unknown value is refused,
 * never coerced.
 * Not admitted (the model needs state the rows do not carry): tree, demote,
 * secondary scopes, an end of a started scope, a startup after the first.
 * After a refused start, later rows of that scope add no second reason.
 *
 * @param {Array<Record<string, any>>} rows latency rows, in file order
 * @returns {Array<{ pid: number, events: object[], rejected: string[] }>}
 */
export function extractTraces(rows) {
	const byPid = new Map();
	for (const row of rows) {
		if (row?.phase !== "session_scope_transition") continue;
		const list = byPid.get(row.pid) ?? [];
		list.push(row);
		byPid.set(row.pid, list);
	}
	return [...byPid.entries()].map(([pid, list]) => extractOne(pid, list));
}

function extractOne(pid, rows) {
	const events = [];
	const rejected = [];
	/** real scopeId -> model ticket, in order of start */
	const ticket = new Map();
	/** model ticket -> sessionId */
	const sessionOf = [];
	/** scope ids seen as `end:superseded` with no start: construction scopes */
	const constructed = new Set();
	/** scope ids whose start row was refused: later rows of that scope add no second reason */
	const refused = new Set();
	const reject = (row, why) =>
		rejected.push(
			`${row.metadata?.transition}:${row.metadata?.reason} scope ${row.metadata?.scopeId}: ${why}`,
		);
	for (const row of rows) {
		const m = row.metadata ?? {};
		const kind = `${m.transition}:${m.reason}`;
		if (refused.has(m.scopeId)) continue;
		const before = rejected.length;
		if (m.role !== "primary") {
			reject(row, `role ${m.role} is not modelled by the pilot`);
		} else if (kind === "end:superseded") {
			if (ticket.has(m.scopeId))
				reject(row, "a started scope ended without a shutdown");
			else constructed.add(m.scopeId);
		} else if (m.transition === "start") {
			if (typeof m.sessionId !== "string" || m.branchEpoch !== 0)
				reject(row, "start without a session id, or after a branch move");
			else if (ticket.size === 0) {
				if (m.reason !== "startup") reject(row, "first start is not startup");
				else {
					ticket.set(m.scopeId, 1);
					sessionOf[1] = m.sessionId;
				}
			} else if (!START_REASONS.has(m.reason)) {
				reject(row, "start reason is not modelled");
			} else if (!HANDOFF_SOURCES.has(m.handoffSource)) {
				reject(row, "handoffSource is absent or not a known source");
			} else if (
				!Number.isSafeInteger(m.parentScopeId) ||
				!(ticket.has(m.parentScopeId) || constructed.has(m.parentScopeId))
			) {
				reject(
					row,
					"parentScopeId is not a started scope or a seen construction scope",
				);
			} else {
				const scope = ticket.size + 1;
				ticket.set(m.scopeId, scope);
				sessionOf[scope] = m.sessionId;
				events.push({
					a: "begin",
					k: m.reason,
					scope,
					role: "primary",
					// parentScopeId is coordinator-local: a re-created coordinator's
					// parent is its construction scope (checked above), which has no
					// ticket (0).
					parent: ticket.get(m.parentScopeId) ?? 0,
					src: m.handoffSource === "slot" ? "slot" : "other",
					sameAs: sessionOf
						.map((id, t) => (t < scope && id === m.sessionId ? t : 0))
						.filter((t) => t > 0),
				});
			}
		} else if (m.transition === "shutdown") {
			if (!RETIRE_REASONS.has(m.reason) || !ticket.has(m.scopeId))
				reject(row, "shutdown reason or scope is not modelled");
			else
				events.push({
					a: "retire",
					k: m.reason,
					scope: ticket.get(m.scopeId),
				});
		} else {
			reject(row, "row form is not admitted");
		}
		if (
			m.transition === "start" &&
			rejected.length > before &&
			m.scopeId !== undefined
		)
			refused.add(m.scopeId);
	}
	return { pid, events, rejected };
}

/**
 * Why a trace cannot be checked at all, or undefined. The model bounds each
 * retire reason to once per behaviour (`k \notin used` in RetireOk), so a
 * second /reload is outside its language for a reason that is not drift.
 */
export function unsupportedReason(events) {
	const seen = new Set();
	for (const event of events) {
		if (event.a !== "retire") continue;
		if (seen.has(event.k))
			return `repeated retire reason "${event.k}": the model allows each reason once per behaviour (k \\notin used)`;
		seen.add(event.k);
	}
	return events.length === 0 ? "no events" : undefined;
}

const isInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** One event as a TLA+ record. Every field is validated; nothing is quoted from a row. */
function renderEvent(event) {
	if (event.a === "retire") {
		if (!RETIRE_REASONS.has(event.k) || !isInt(event.scope))
			throw new Error(`bad retire event ${JSON.stringify(event)}`);
		return `[a |-> "retire", k |-> "${event.k}", scope |-> ${event.scope}]`;
	}
	if (event.a === "begin") {
		if (
			!START_REASONS.has(event.k) ||
			!isInt(event.scope) ||
			event.role !== "primary" ||
			!isInt(event.parent) ||
			!["slot", "other"].includes(event.src) ||
			!Array.isArray(event.sameAs) ||
			!event.sameAs.every(isInt)
		)
			throw new Error(`bad begin event ${JSON.stringify(event)}`);
		return `[a |-> "begin", k |-> "${event.k}", scope |-> ${event.scope}, role |-> "primary", parent |-> ${event.parent}, src |-> "${event.src}", sameAs |-> {${event.sameAs.join(", ")}}]`;
	}
	if (event.a === "continue") {
		// An async continuation reading the host ctx (#4815). The model has no
		// action for it, so Obs has no disjunct and the trace is refused.
		if (!isInt(event.scope) || event.effect !== "ctx-read")
			throw new Error(`bad continue event ${JSON.stringify(event)}`);
		return `[a |-> "continue", scope |-> ${event.scope}, effect |-> "ctx-read"]`;
	}
	throw new Error(`unknown event kind ${JSON.stringify(event)}`);
}

/** The generated trace module: SessionLifecycle's Next, one step per event. */
export function renderTraceModule(events) {
	return `---- MODULE Trace${MODEL} ----
EXTENDS ${MODEL}, Sequences
VARIABLE ti
TR == <<
${events.map((e) => `  ${renderEvent(e)}`).join(",\n")}
>>
\\* Each event is checked against the state change one Next step makes. A
\\* retire is the primary leaving; a begin is a primary start whose parent,
\\* hand-off source (slot taken or not) and session identity equal the row's.
Obs(ev) ==
  \\/ /\\ ev.a = "retire"
     /\\ primary = ev.scope /\\ primary' = 0
     /\\ pend'.k = ev.k /\\ why'[ev.scope] = ev.k
  \\/ /\\ ev.a = "begin"
     /\\ primary = 0 /\\ pend.k = ev.k
     /\\ primary' = ev.scope /\\ role'[ev.scope] = ev.role
     /\\ (ev.parent = 0 \\/ predOf'[ev.scope] = ev.parent)
     /\\ (taken' # taken) <=> (ev.src = "slot")
     /\\ \\A u \\in 1..(ev.scope - 1) : (sess'[u] = sess'[ev.scope]) <=> (u \\in ev.sameAs)
\\* session_before_fork is not a row: it may precede a fork/clone retire unseen.
TNext ==
  \\/ /\\ ti < Len(TR) /\\ Next /\\ Obs(TR[ti + 1]) /\\ ti' = ti + 1
  \\/ /\\ ti < Len(TR) /\\ TR[ti + 1].a = "retire" /\\ TR[ti + 1].k \\in {"fork", "clone"}
     /\\ forking = "no" /\\ Next /\\ forking' # "no" /\\ ti' = ti
TSpec == (Init /\\ ti = 0) /\\ [][TNext]_<<vars, ti>>
NotDone == ti < Len(TR)
====
`;
}

/**
 * The trace config: Merged.cfg's constants with no writers, MaxSteps sized to
 * the trace, and the trace's own spec and invariant.
 */
export function renderTraceConfig(baseConfig, retires) {
	if (!/^\\\*\s*expect:\s*pass\s*$/m.test(baseConfig))
		throw new Error(`${BASE_CONFIG} no longer expects pass`);
	const lines = baseConfig
		.split("\n")
		.filter(
			(line) =>
				line.trim() !== "" &&
				!line.startsWith("\\*") &&
				!/^(SPECIFICATION|INVARIANTS|CHECK_DEADLOCK)\b/.test(line),
		);
	const swap = (name, value) => {
		const at = lines.findIndex((line) =>
			new RegExp(`^\\s*${name} =`).test(line),
		);
		if (at < 0) throw new Error(`${BASE_CONFIG} has no ${name} line`);
		lines[at] = `    ${name} = ${value}`;
	};
	swap("Writers", "{}");
	swap("MaxSteps", String(Math.max(1, retires)));
	return `${[...lines, "SPECIFICATION TSpec", "INVARIANT NotDone", "CHECK_DEADLOCK FALSE"].join("\n")}\n`;
}

/**
 * TLC's verdict on a trace module. `NotDone` violated = the trace is
 * producible; a clean completion = it is not, and `searchDepth` (the initial
 * state is depth 1) locates the first event the model could not match, see
 * {@link firstUnmatchedEvent}.
 */
export function classifyTraceOutput(output) {
	if (/Error: Invariant NotDone is violated/.test(output))
		return { status: "producible" };
	if (/Model checking completed\. No error has been found\./.test(output)) {
		const depth = /The depth of the complete state graph search is (\d+)/.exec(
			output,
		);
		return {
			status: "not-producible",
			searchDepth: depth ? Number(depth[1]) : undefined,
		};
	}
	const detail = output.split("\n").find((l) => /Error|Exception/.test(l));
	return { status: "error", detail: detail?.trim() ?? "no verdict" };
}

const isForkRetire = (e) =>
	e.a === "retire" && (e.k === "fork" || e.k === "clone");

/**
 * The 1-based index of the first event TLC could not match, from the search
 * depth. A matched event is one level; so is the unobserved
 * `session_before_fork` step that precedes every fork or clone retire.
 */
export function firstUnmatchedEvent(events, searchDepth) {
	let hidden = 0;
	for (let at = 1; at <= events.length; at += 1) {
		const next = isForkRetire(events[at - 1]) ? 1 : 0;
		if (at + hidden + next === searchDepth) return at;
		hidden += next;
	}
	return undefined;
}

/** Run TLC on one trace; returns the verdict and the wall seconds. */
export async function checkTrace(events, { jar }) {
	const unsupported = unsupportedReason(events);
	if (unsupported) return { status: "error", detail: unsupported, seconds: 0 };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tlc-"));
	try {
		fs.copyFileSync(
			path.join(FAMILY_DIR, `${MODEL}.tla`),
			path.join(dir, `${MODEL}.tla`),
		);
		fs.writeFileSync(
			path.join(dir, `Trace${MODEL}.tla`),
			renderTraceModule(events),
		);
		const retires = events.filter((e) => e.a === "retire").length;
		fs.writeFileSync(
			path.join(dir, `Trace${MODEL}.cfg`),
			renderTraceConfig(
				fs.readFileSync(path.join(FAMILY_DIR, BASE_CONFIG), "utf8"),
				retires,
			),
		);
		const metadir = path.join(dir, "meta");
		fs.mkdirSync(metadir);
		const args = buildJavaArgs(
			jar,
			metadir,
			`Trace${MODEL}.cfg`,
			`Trace${MODEL}.tla`,
		);
		const started = Date.now();
		const output = await new Promise((resolve, reject) => {
			const child = spawn("java", args, { cwd: dir });
			let text = "";
			child.stdout.on("data", (chunk) => (text += chunk));
			child.stderr.on("data", (chunk) => (text += chunk));
			child.on("error", reject);
			child.on("close", () => resolve(text));
		});
		return {
			...classifyTraceOutput(output),
			seconds: (Date.now() - started) / 1000,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** A JSON array, or NDJSON, of rows or events. */
export function readJsonRecords(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith("[")) return JSON.parse(trimmed);
	return trimmed
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Text -> traces, or an Error naming the file. A population of zero traces is
 * refused: an empty file, rows of another phase or a renamed phase literal
 * must not pass as "nothing to check" (principles: gates fail closed).
 *
 * @param {string} text file contents
 * @param {{ kind: "rows" | "events", file: string }} source
 */
export function loadTraces(text, { kind, file }) {
	let records;
	try {
		records = readJsonRecords(text);
	} catch (error) {
		throw new Error(`${file}: unparseable JSON (${error.message})`);
	}
	const traces =
		kind === "rows"
			? extractTraces(records)
			: [{ pid: 0, events: records, rejected: [] }];
	if (kind === "rows" && traces.length === 0)
		throw new Error(`${file}: no session_scope_transition rows`);
	if (kind === "events" && records.length === 0)
		throw new Error(`${file}: no events`);
	for (const trace of traces) {
		for (const event of trace.events) {
			try {
				renderEvent(event);
			} catch (error) {
				trace.rejected.push(error.message);
			}
		}
	}
	return traces;
}

const USAGE =
	"usage: --rows <file> | --events <file> [--jar <jar>] [--expect producible|not-producible]";

/**
 * The CLI as a function: prints through `log`, returns the exit code
 * (0 as expected, 1 a trace is not as expected, 2 unchecked, unreadable or
 * unusable input).
 *
 * @param {string[]} argv
 * @param {(line: string) => void} log
 */
export async function runCli(argv, log = console.log) {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				rows: { type: "string" },
				events: { type: "string" },
				jar: { type: "string" },
				expect: { type: "string", default: "producible" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		log(`${error.message}\n${USAGE}`);
		return 2;
	}
	if (
		!values.rows === !values.events ||
		!["producible", "not-producible"].includes(values.expect)
	) {
		log(USAGE);
		return 2;
	}
	const file = values.rows ?? values.events;
	let traces;
	try {
		traces = loadTraces(fs.readFileSync(file, "utf8"), {
			kind: values.rows ? "rows" : "events",
			file,
		});
	} catch (error) {
		log(`UNCHECKED ${error.message}`);
		return 2;
	}
	let exit = 0;
	let jar;
	for (const trace of traces) {
		const label = `${file} pid ${trace.pid}`;
		if (trace.rejected.length > 0) {
			log(`UNCHECKED ${label}: ${trace.rejected.join("; ")}`);
			exit = 2;
			continue;
		}
		let verdict;
		try {
			jar ??= await ensureJar(values.jar, ROOT);
			verdict = await checkTrace(trace.events, { jar });
		} catch (error) {
			log(`UNCHECKED ${label}: ${error.message}`);
			exit = 2;
			continue;
		}
		const stuck =
			verdict.status === "not-producible"
				? firstUnmatchedEvent(trace.events, verdict.searchDepth)
				: undefined;
		const detail =
			verdict.status === "not-producible"
				? ` (first unmatched event: ${stuck}, ${JSON.stringify(trace.events[stuck - 1])})`
				: verdict.status === "error"
					? ` (${verdict.detail})`
					: "";
		const met = verdict.status === values.expect;
		log(
			`${met ? "ok" : "FAIL"} ${label}: ${verdict.status}${detail}, ${trace.events.length} events, ${verdict.seconds.toFixed(2)}s`,
		);
		if (verdict.status === "error") exit = 2;
		else if (!met && exit === 0) exit = 1;
	}
	return exit;
}

if (isMainModule(import.meta.url))
	process.exit(await runCli(process.argv.slice(2)));
