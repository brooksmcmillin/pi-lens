# ADR 0010: trace validation for the session-lifecycle model (pilot)

## Status

Accepted — 2026-10-25 (maintainer). The rollout is #4834: the CI job starts advisory and becomes required after a clean window; later slices follow section 11.

## Context

Nothing binds a TLA+ model to the TypeScript it models. `TLA+ models` runs only
when a diff touches `formal/` or the checker (`.github/workflows/ci.yml:250`),
and `tests/clients/dispatch-pipeline-formal.test.ts` replays old counterexamples
only. Two drifts surfaced in one week, both found by a human:

- #4782's model never emptied its cache, so #4785's `answerStored` guard was
  vacuous in the spec (fixed in PR #4820).
- #4815: a detached startup continuation read a stale host ctx after a reload.
  The session models had no step in which work outlives its session and then
  touches the host (fixed in PR #4818).

#3533 asks for the one mechanism that can catch this class: check what a real
run did against the spec. The scope fixed on the issue (2026-10-21): pick one
pilot family, choose between recording real sequences and generating tests from
TLC traces, state the per-PR and nightly cost, and measure it.

Related: #4632 (the real-pi harness lifecycle tests), #4709 (removing the
in-process mocks of seam-backed modules), #4815, #4782.

## Decision

### 1. Pilot family: `formal/session-lifecycle`

It is the most churned identity seam (132 configs; the other session families
compose onto it), its as-built config is `Merged.cfg`, and its host transitions
are already logged by production code. `SessionLifecycle.tla` is 2 088 lines
with a 40-disjunct `Next`.

### 2. Direction: record real sequences, check them against `Next`

Not "generate tests from TLC traces". Measured on `Merged.cfg` (the smallest
as-built config that covers every host transition): 11 116 distinct states,
17 379 generated transitions, search depth 11, 2.1 s of TLC. Covering the
transitions with generated real-pi scenarios needs at least 17 379 / 11 = 1 580
scenarios (arithmetic, not a measurement), at 3.3 to 4.6 s per scenario of the
real lifecycle witness: 1.4 hours at the lower bound, before the driver exists.
Of `Next`'s 40 disjuncts the RPC harness can drive about five (new, resume,
clone, reload, quit); the rest (interrupted starts, marker expiry, duplicate
starts, writer landings) have no RPC. Generation also tests the model against
itself: it adds no evidence about what the code does between the steps.

Recording needs no driver: the real tests already do the interesting
sequences, and the check says whether the model could have produced them.
Its limit is the corpus: it covers what tests do, not what the model allows.
That limit is the right split. The model checker owns "all behaviours satisfy
the invariants"; trace validation owns "the real behaviours are among them".

### 3. Trace source and the mock rule

Record only from tests that do not mock the modelled seam. A trace taken
through a `vi.mock` records the mock. For the pilot:

| Test | Seam unmocked? | Use |
|---|---|---|
| `tests/real-harness/lifecycle.test.ts` "drives startup, reload, new, resume, fork, and quit" | yes: real pi, built extension | recorded (fixture below) |
| `tests/real-harness/bridge-reload.test.ts`, `bridge-reload-ts.test.ts` | yes | reload-only traces; the recorder is one call, not wired (no new evidence) |
| `tests/clients/runtime-session-stale-ctx-scans-4815.test.ts` | no: the host ctx and the bootstrap seam are doubled | not recorded. A trace from it records the double. Listed for #4709: a real-pi test that holds the analyzer bootstrap await open while a reload lands needs a gate in product code, which is the hook cost in section 11 |

Other in-process session tests (tier 2, `index-*.test.ts`) were not audited.

### 4. Event schema

One event per spec action, from the rows production already writes.
`logScopeTransition` (`clients/session-scope.ts:306`) logs a
`session_scope_transition` row per scope start, retire, branch move, supersede
and demote, with `transition`, `reason`, `scopeId`, `parentScopeId`, `role`,
`branchEpoch`, `sessionId`, `coordinatorId` and `handoffSource`. The pilot needs
**no production hook**; the test-only recorder (`tests/support/trace-recorder.ts`,
off unless `REAL_PI_HARNESS_TRACE_DIR` is set) writes `{phase, pid, metadata}`
of those rows, without the cwd path a raw row carries.

| Row | Event | Spec action | What the check compares |
|---|---|---|---|
| `end:superseded` of a scope with no start row | none | outside the model | admitted only when no start of that scope exists; the scope id is then a known construction scope |
| first `start:startup` | none | `Init` (scope 1, primary, file `A`) | role primary, epoch 0 |
| `shutdown:<r>` primary | `retire(r, scope)` | `Retire(r)` | the live primary is that scope; `pend.k = r`; `why[scope] = r` |
| `start:<r>` primary | `begin(r, scope, parent, src, sameAs)` | `Begin` | the row carries a `handoffSource` in `slot`, `own-sidecar`, `parent-sidecar`, `none` and a safe-integer `parentScopeId` naming a started scope or a seen construction scope (otherwise the trace is refused); role; `predOf` equals the parent when it is a started scope; `handoffSource = slot` iff the step took the slot (`taken` grew); `sess` equal to a prior scope's iff the session ids are equal |
| anything else | refuses the trace | none | `tree`, `demote`, any secondary, an end of a started scope, a second startup, an unknown reason |

Real scope ids map to model tickets in order of start. `parentScopeId` is
coordinator-local: pi's jiti load re-creates the coordinator on `/reload`, and
the successor's parent is then its own construction scope (probed with
`bridge-reload-ts`'s entry, 2026-10-24), so a parent that is a seen construction scope checks nothing; any other unstarted or absent parent is refused.
`session_before_fork` is not a row; the generated module lets one hidden
`BeforeFork` step precede a fork or clone retire. pi sends `fork` for `/clone`,
so `clone` never appears in rows.

### 5. Checker: TLC with the trace as a constraint

The generated `TraceSessionLifecycle` module `EXTENDS SessionLifecycle` and
steps the unchanged `Next` once per event, keeping only successors the
observation predicate `Obs` accepts. The trace is producible exactly when TLC
reports the invariant `NotDone == ti < Len(TR)` violated. `Obs` is the only
per-family TLA+ (15 lines); the extractor is the only per-family JS. Constants
are `Merged.cfg`'s own text with `Writers = {}` and `MaxSteps` sized to the
trace, so `formal/switch-pins.json` and its pin test cover them and no second
copy of the as-built switches exists.
`Writers = {}` is a consequence of the design, not a convenience. `Obs` is
checked against `Next` per event with no interleaving: between two events the
model can only stutter or take the hidden before-fork step. That makes the check
tight per event, and it means store writers are not merely unavailable. A
writer step between two events is a transition no row accounts for, so the
pilot cannot model one until rows carry writes (section 11).

Rejected: a per-spec JS replayer. It is a second implementation of a 40-way
next-state relation over 60 variables; every model edit would need the same
edit there, and its own drift from the spec is the problem being solved,
moved. TLC reuses `Next` as is. The price is a JVM per trace (section 9) and
that the job needs Java; the checker already pins and checksums `tla2tools.jar`
(`ensureJar`, now exported from `scripts/check-tla-models.mjs`).

### 6. How a non-producible trace fails CI

`node scripts/trace-validate-session-lifecycle.mjs --rows <file>` prints one
line per process and exits non-zero on any of:

- `FAIL … not-producible (first unmatched event: N, <event>)`, exit 1: the
  model has no step matching event N;
- `UNCHECKED … <row>: <why>`, exit 2: a row outside the admitted forms, never
  skipped (principles: gates fail closed);
- `UNCHECKED <file>: <why>`, exit 2: the file holds no `session_scope_transition`
  rows (empty, another phase, a renamed phase literal), no events, or
  unparseable JSON. An empty population never passes, also under
  `--expect not-producible`; an unknown event kind is an `UNCHECKED` trace;
- `UNCHECKED <label>: <why>`, exit 2, when the jar is missing or fails its
  checksum (round 1 exited 1 with a stack for both). All output, the usage line
  included, goes to stdout;
- `error (<why>)`, exit 2: TLC did not decide, or the trace is outside the
  model's bounds. `RetireOk` allows each retire reason once per behaviour
  (`k \notin used`, `SessionLifecycle.tla:646`), so a second `/reload` is
  reported as unsupported, not as drift.

The remedy has two branches and no third: fix the code, or extend the model
under the TLA+ rule in `AGENTS.md`. There is no allowlist; an exemption would
be the next finding. During the pilot the job should be advisory, like the
`Hot-path latency (advisory)` lane, and become required after a clean window
(a rollout decision).

### 7. State table: the identities of the seam

Read from `clients/session-scope.ts`, `clients/runtime-coordinator.ts` and
`clients/session-event-guard.ts`.

| Identity | Minted by | Valid for | Ends at | In the rows | In the model |
|---|---|---|---|---|---|
| session id | pi's session manager | one conversation file; unchanged by `/reload`; new on `/new` and fork; `resume` returns an old one | never | `sessionId` | `sess[t]` (file letter) |
| scope ticket = generation | `beginScope` from the process counter, at coordinator construction and at each `resetForSession` | the process; never reused | `retireScope` at shutdown or when the coordinator begins the next scope | `scopeId`, `parentScopeId`, `coordinatorId` | `st[t]`, `predOf[t]`, `nxt`, `primary`, `last` |
| branch epoch | `moveBranch` on `/tree` | one scope | `/tree` | `branchEpoch` | `ep[t]` |
| ctx liveness | the pi SDK: a captured ctx is valid until `newSession`, `fork`, `switchSession` or `reload` replaces the session | one host binding | the host's replacement, which can precede the successor's scope | no row; `extension-ctx-stale` appears only on the skip path | none (`LastMemberOwnership.tla` reads it for sibling teardown only) |

`sessionGeneration` is the scope ticket (`clients/runtime-coordinator.ts:1446`);
`isCurrentSession(generation)` is ticket equality and scope liveness
(`:1464`). It never reads ctx liveness, and ctx staleness is found by message
(`isStaleExtensionCtxError`), not by comparing identities. PR #4818's review
probes record the two as independent in reachable interleavings: P3 (stale ctx,
generation not bumped) and P4 (live ctx, bumped generation). That is why a
continuation step needs its own ctx-liveness variable and cannot be derived
from `st[t]`.

Writers by axis (who, which identity, when):

| Actor | Identity it holds | Timing | Modelled |
|---|---|---|---|
| `session_start` handler | the new scope, drawn by `resetForSession` | sync reset, then awaits | `Begin` |
| `session_shutdown` handler | the live primary | sync | `Retire` |
| store writer | a `LineageHandle` captured at hook entry | lands at any later step | `WriterBegin`, `Land*` (fenced) |
| detached continuation (`void (async …)`, timers) | a captured scope, plus the ctx it closes over | after one or more awaits; can outlive both | **no action** |
| pi host | invalidates the ctx | at replacement | not a variable |

The last two rows are the #4815 gap: the model has writers that outlive their
scope but no step that reads the host after the scope is gone.

### 8. Acceptance case: the #4815 interleaving

Checked 2026-10-24 (fixtures `reload-no-continuation.events.json` and
`reload-ctx-continuation-4815.events.json`, transcript in the appendix):

- Transitions only (start, `shutdown:reload`, `start:reload`): **producible**.
  The spec reaches the interleaving; `InterruptAt` already models a reload that
  lands while a start is in flight. The rows of the buggy and the fixed code are
  identical. The model did not forbid #4815; it had nowhere to say it.
- With the continuation event (`a: continue`, effect `ctx-read`, on the retired
  scope): **not producible, first unmatched event 3**. `Obs` has no disjunct for
  it because `SessionLifecycle` has no action that reads host ctx, so the
  refusal is by vocabulary. That is the point of one event per spec action: an
  event the spec cannot name is a missing step, not a pass.

This trace is **hand-authored in the event schema, not recorded**. A reload
cannot be landed deterministically inside the analyzer bootstrap await from the
real harness (the window is one await wide), and the in-process #4815 test
doubles the very seam under test. Closing the gap is model work for the
rollout: add a `Continue` action with a ctx-liveness variable and the invariant
that a continuation on a retired scope skips and records, then the same trace is
producible for the fixed code and refused for the pre-#4818 behaviour.

### 9. Measured cost

Host: 32 cores, load average 17 to 31 from other lanes; wall seconds, not
isolated. TLC 1.7.4, JRE 21.0.12, one worker. Raw output is in the appendix.

| Quantity | Result |
|---|---|
| One trace, check only (n = 10) | 0.79 to 0.98 s wall; 1.05 to 1.31 s in later runs at load 31 |
| JVM + SANY floor (trivial module, n = 3) | 0.69 to 0.78 s |
| 3 events vs 9 events | no difference (0.88 to 0.99 s for 9): the JVM is the cost |
| The CLI, two traces in sequence | 1.81 s wall, 4.27 s user, 323 MB max RSS |
| The real lifecycle witness (existing test) | 3.6 to 4.6 s wall. Recording adds one JSON write: on 3.58 to 4.00 s (n = 3) against off 4.57 s (n = 1); at load 31, off 7.2 to 8.6 s (n = 3) against on 6.1 to 6.3 s (n = 3), so the spread is host noise, not the recorder |
| Whole real-harness suites registered in the pre-push route | 105 s of CI time (`scripts/pre-push-targeted-tests.mjs`) |
| Existing `TLA+ models` shards, run only on a `formal/` diff | 274 to 599 s per shard, 4 shards (run 40129286694) |
| Existing `Unit tests` shards | 392 to 514 s |

Per-PR versus nightly:

- **Per PR, advisory first.** The pilot's whole check is about 2 s of TLC for
  the two recorded processes, about 4 s if the two reload-only bridge tests are
  wired too.
  It needs a recorded-rows artifact from the `Unit tests` shard that holds
  `lifecycle.test.ts` and a small job with Java; the plumbing, not the TLC time,
  is the cost. Gate it on the same classification that gates `TLA+ models`,
  extended to the coverage-map rows of the family
  (`clients/session-scope.ts`, `index.ts` lifecycle handlers).
- **Nightly** for the full real-harness corpus and for any family added later,
  where traces are longer and more numerous. One JVM per trace is wasteful at
  that point; check a set of traces per JVM then.
- The test lane stays hermetic. It does not carry the jar, so the TLC verdict
  is not asserted in a vitest file; `tests/scripts/trace-validate-session-lifecycle.test.ts`
  covers what decides WHAT TLC is asked (extraction, fail-closed rows, rendering,
  config derivation, verdict parsing).

### 10. Planted drift: the check goes red

| Plant | Existing behaviour witness | Trace check |
|---|---|---|
| Code: `SOURCES.fork` in `clients/session-scope.ts` loses `"slot"` (a fork adopts the parent sidecar only) | `lifecycle.test.ts` **passes** (1 passed): sidecar and slot carry equal state there | `FAIL … pid …: not-producible (first unmatched event: 2, begin fork … src other)`, exit 1 |
| Spec: `SlotReasons == {"fork"}` (the model stops handing off on `/reload`) | not applicable | `FAIL … not-producible (first unmatched event: 2, begin reload … src slot)` on the reload process; the fork process stays `ok` |
| Events: the reload start's `src` flipped to `other` (probe edit, not committed) | not applicable | `not-producible (first unmatched event: 2, begin reload)` |
| A second `/reload` in one trace | not applicable | `error (repeated retire reason "reload": the model allows each reason once per behaviour)` |

Both drifts are restored; the transcripts are in the appendix.

### 11. What the pilot does not do (the rollout issue's scope)

Named, not built (principles: speculative robustness needs buy-in):

- **The CI job**, its artifact hand-off, its path gate and the advisory-to-
  required decision.
- **Batching** several traces per JVM.
- **The full hook.** Rows carry transitions only. Not observed: store writers
  landing (53 `guardedWrite(` call sites in 10 files, so a hook there is a
  per-site edit or one choke point in `generation-guard.ts`), `session_before_fork`,
  `/tree` with its branch contents (`Tree` needs a two-entry branch the rows do
  not carry), subagent and secondary scopes, `Dup`/`Interrupt`, and detached
  continuations (12 `void (async` sites). Each is a production emit behind a
  bounded record, and needs its spec action first.
- **Bound relaxation.** `used` and `steps < MaxSteps` are state-space devices;
  traces of production length need a trace-mode switch in the spec.
- **More families.** Each family needs its own extractor and `Obs`.
- **A model `Continue` step** for #4815 (section 8).
- **Resume of a non-startup session.** The model hardcodes `resume -> "A"`
  (`TargetOf`, `SessionLifecycle.tla:642`; `Init` has `sess[1] = "A"`), and
  `RetireOk` refuses a resume from a primary already in `A`. A recorded resume
  is therefore checked only against the process's startup session. The
  extractor maps the resumed session id to the earlier scopes with the same
  id (`sameAs`): the startup scope's ticket for the startup session, which the
  model can produce; no ticket for a session not seen before in the process
  (empty `sameAs`); and that scope's own ticket, not the startup one, for a
  non-startup session seen earlier. The model cannot produce the last two.
  Pinned in `tests/scripts/trace-validate-session-lifecycle.test.ts`;
  extending the model to resume arbitrary sessions is the rollout issue's call.
- **Store content.** `Obs` compares role, lineage, hand-off source and session
  identity. It does not compare facts in the read guard, the turn counter, or
  the advisory queue; content drift stays with the invariants and unit tests.

## Consequences

- Drift in the transition structure of `session-lifecycle` (who hands off to
  whom, which session continues which) is caught from tests that already run,
  for about one second per trace and no production behaviour change.
- The check is only as wide as the event vocabulary. A step the spec cannot
  name is refused, which turns each "the model had no word for it" finding into
  a loud red instead of a human verify. It also means the first rollout PRs
  are model PRs.
- The corpus decides coverage. A transition no test drives is never checked.
- The pilot adds one JS module (`scripts/trace-validate-session-lifecycle.mjs`
  with its `.d.mts`), one test-only recorder (`tests/support/trace-recorder.ts`),
  an `export` on `ensureJar` and one recorder call in `lifecycle.test.ts`; no
  product file changes.

## Links

- Issue: #3533 (maintainer scope, 2026-10-21).
- Evidence for the premise: #4782, #4785, PR #4820, #4815, PR #4818.
- Real-harness lane: #4632, `docs/real-harness.md`. Mock removal: #4709.
- Model: `formal/session-lifecycle/` (`README.md`, `Merged.cfg`),
  `formal/switch-pins.json`.
- Code: `clients/session-scope.ts` (`logScopeTransition`),
  `clients/runtime-coordinator.ts` (`isCurrentSession`),
  `clients/session-event-guard.ts` (`isStaleExtensionCtxError`).
- Pilot: `scripts/trace-validate-session-lifecycle.mjs`,
  `tests/support/trace-recorder.ts`, `tests/fixtures/trace-validation/session-lifecycle/`.

## Appendix: raw output (2026-10-24)

Record one trace (the existing witness, recorder on):

```text
$ REAL_PI_HARNESS_TRACE_DIR=<dir> vitest run tests/real-harness/lifecycle.test.ts --project real-harness -t "drives startup"
record run 1: 4.00 s wall, 5.33 s user
record run 2: 3.58 s wall, 4.86 s user
record run 3: 3.69 s wall, 4.92 s user
```

Check it (five runs, two processes each):

```text
$ node scripts/trace-validate-session-lifecycle.mjs --rows lifecycle-drive.rows.json --jar tla2tools.jar
ok …/lifecycle-drive.rows.json pid 1444401: producible, 5 events, 0.94s
ok …/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.95s
ok …/lifecycle-drive.rows.json pid 1444401: producible, 5 events, 0.98s
ok …/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.89s
ok …/lifecycle-drive.rows.json pid 1444401: producible, 5 events, 0.88s
ok …/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.86s
ok …/lifecycle-drive.rows.json pid 1444401: producible, 5 events, 0.85s
ok …/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.90s
ok …/lifecycle-drive.rows.json pid 1444401: producible, 5 events, 0.83s
ok …/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.79s
whole CLI, 2 traces: 1.81 s wall, 4.27 s user, 323 MB max RSS
```

JVM + SANY floor, and a nine-event trace (`reload, new, resume, fork, quit`).
The nine-event file is a hand-written `--events` file used for timing; it is not
what the rows path would emit for a resume, which needs a `sameAs` that contains
the startup ticket:

```text
JVM+SANY floor (trivial module) run 1: 0.71 s wall
JVM+SANY floor (trivial module) run 2: 0.78 s wall
JVM+SANY floor (trivial module) run 3: 0.69 s wall
ok probe/events-long.json pid 0: producible, 9 events, 0.99s
ok probe/events-long.json pid 0: producible, 9 events, 0.91s
ok probe/events-long.json pid 0: producible, 9 events, 0.88s
```

`Merged.cfg` on the same host:

```text
Model checking completed. No error has been found.
17379 states generated, 11116 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 11.
Merged.cfg: 2.10 s wall, 4.88 s user, 921304 KB
```

Planted code drift (witness stays green, the trace check reds):

```text
$ sed -i … clients/session-scope.ts   # SOURCES.fork: ["slot","parent-sidecar"] -> ["parent-sidecar"]
$ vitest run tests/real-harness/lifecycle.test.ts -t "drives startup"
 Test Files  1 passed (1)
      Tests  1 passed | 2 skipped (3)
$ node scripts/trace-validate-session-lifecycle.mjs --rows <recorded rows>
ok rec-drift2/lifecycle-drive.rows.json pid 1545878: producible, 5 events, 1.05s
FAIL rec-drift2/lifecycle-drive.rows.json pid 1546208: not-producible (first unmatched event: 2, {"a":"begin","k":"fork","scope":2,"role":"primary","parent":1,"src":"other","sameAs":[]}), 3 events, 1.05s
exit 1
```

Planted spec drift (`SlotReasons == {"fork"}`):

```text
FAIL rec-clean/lifecycle-drive.rows.json pid 1444401: not-producible (first unmatched event: 2, {"a":"begin","k":"reload","scope":2,"role":"primary","parent":1,"src":"slot","sameAs":[1]}), 5 events, 0.89s
ok rec-clean/lifecycle-drive.rows.json pid 1444894: producible, 3 events, 0.86s
exit 1
```

The #4815 interleaving:

```text
$ … --events reload-no-continuation.events.json
ok …/reload-no-continuation.events.json pid 0: producible, 2 events, 1.31s
$ … --events reload-ctx-continuation-4815.events.json
FAIL …/reload-ctx-continuation-4815.events.json pid 0: not-producible (first unmatched event: 3, {"a":"continue","scope":1,"effect":"ctx-read"}), 3 events, 1.16s
exit 1
```
