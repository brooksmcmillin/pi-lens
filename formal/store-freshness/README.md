# Store freshness model

A TLA+ model of one cached result about one input file X, and the gate that
later decides whether to serve it. It covers the stores that use the
freshness kernel (`clients/freshness.ts`, #1739). X is the file whose bytes
the result was computed from: the diagnosed file (own axis) or a file it
imports (dependency axis). The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #3503, #3504, #3505, #3573, #3574, #4620, #4625.

`StoreRetire.tla` extends the model with what the widget store keeps once
the gate has demoted a result (see Retirement below). The base module and its
configs are unchanged.

## What the model covers

- **The writer.** External or concurrent writes of X. Each write sets
  `mtime = trunc_Gran(clock + lead)`, where the lead is `0..Skew`. The lead
  is the #1710 Windows skew: an mtime can lead `Date.now()`.
- **The computation.** `Start`, then `Read` (the bytes the result is
  computed from), then `Record` (the store write). Time can pass between
  steps. `ServerLag` lets the read come before `Start`, like a pull server
  answering from a model it loaded earlier.
- **The store.** The reference timestamp: `Stamp = "start"` (before the
  read) or `"end"` (at record). For `eq`, it also keeps the recorded stat
  (`StatAt` before or after the read) and a content hash (`BindingAt`: the
  bytes read, or the disk at record).
- **The gate:**
  - `mtime`: `freshnessFromMtime`;
  - `content`: size, then sha256 of the bytes read;
  - `sizeMtime`: `detectSelfDrift`; `ForceHash` models it without its old
    mtime fast path;
  - `eq`: `isEntryFresh` own-file equality, plus the #1095 binding;
  - `none`: a mutant with no gate.

  The gate can run several times. `Latch` makes a demotion permanent.

The clock is explicit, one tick is about 25 ms, and events can share a tick.
`mtimeId` makes two writes compare unequal on a fine filesystem
(`Gran = 1`), where `mtimeMs` has sub-ms digits.

## Invariants

- `NoStaleServe`: a served result was computed on the bytes on disk when
  the gate ran.
- `NoStaleServeBeyondTol`: the same, except for the admitted window. A stale
  serve is excused only when the first write after the read landed at or
  after the reference instant, and within `Tol + Gran` of it.
- `NoSpuriousDemotion`: if nothing was written since the reference instant,
  the result is not demoted. This is the reason the tolerance exists
  (`FixReadStampNoTol`). It cannot see a stamp taken too early: see Scope and
  limits.
- `NoRepromotion`: a demoted result is not served again unless the bytes
  match.

## Store map

| Store | Reference | Taken relative to the read | Gate | Config |
|---|---|---|---|---|
| widget-state own file, per entry (`reconcileStaleWidgetFiles`) | `observedAt` = the pipeline's `analysisReadAtMs`, passed to `recordDiagnostics` (#3503); `lsp_diagnostics`' fresh row: its `scannedAt` (#3505); `lens_diagnostics mode=full`'s fresh sweep row: the sweep's per-file read stamp, kept through the correlated commit (#3573); `pilens_analyze`: a stamp before its LSP warm-up (#3573); a confirmed active cascade touch: a stamp before the neighbor's read (#3573) | before | mtime | `WidgetOwnLateStamp`: pass. Mutant `MutWidgetOwnLateStamp` (record-time stamp): violated |
| widget-state own file, after a stale verdict (`reconcileStaleWidgetFiles`: what the record becomes) | not a stamp: the record the verdict leaves (#4625) | | | `WidgetOwnRetain`: pass (`Retire = "retain"`). Mutants `MutWidgetOwnDropOnce` (586dd00fd) and `MutWidgetOwnDrop` (the code before #4625): violated `NoCleanAfterDemotion` |
| widget-state dependency axis (`reconcileStaleWidgetDependencyBlockers`, and the turn-end sweep's widget rows via `getWidgetBlockingFilesForSweep`) | same `observedAt` | before | mtime | same shape as `BlockerDepLateStamp` |
| inline blocker, import axis (`detectDrift`) | `recordedAtMs` = the pipeline's `analysisReadAtMs`, threaded through `recordInlineBlockers` (#3503) | before | mtime, latched | `BlockerDepLateStamp`: pass. Mutant `MutBlockerDepLateStamp`: violated |
| inline blocker, own file, all-LSP | size+sha256 of the raw bytes the pipeline analysed (#3574: not of a decoded-then-re-encoded string) | at the read | content | `BlockerLspOwn`: pass, mtime regress included |
| inline blocker, own file, non-LSP | size+sha256, with no mtime fast path (#3504) | at the read | content | `BlockerNonLspOwnFastPath`: pass. Mutant `MutBlockerNonLspOwnFastPath` (late stamp + fast path): violated; `FixBlockerReadStampStrict` (read stamp, fast path kept): violated |
| workspace-diagnostics cache, own file, per-file sweep | stat mtime+size, taken before the pre-open read or `processFile`'s own read (#3505) | before | eq | `WorkspaceOwnStatAfterRead`: pass. Mutant `MutWorkspaceOwnStatAfterRead`: violated |
| workspace-diagnostics cache, own file, pull | stat after the answer, and the hash of the content pi-lens sent (an open document at the reported version); an answer without that binding is not cached (#3505 b) | after the server answered; the binding at the server's read | eq | `WorkspaceOwnPullPostHocHash`: pass. Mutant `MutWorkspaceOwnPullPostHocHash` (a disk hash taken after the answer): violated; `WorkspaceOwnPullStatBeforeLag` (a stat before the request, no binding): violated |
| workspace-diagnostics cache, own file, `lsp_diagnostics` | stat before its read | before | eq | the shape `WorkspaceOwnStatAfterRead` now models |
| workspace-diagnostics cache, own file, coarse mtime | (mtime, size) inside one coarse granule | | eq | `WorkspaceOwnCoarseSameSize`: violated, admitted (#2300) |
| workspace-diagnostics cache, dependency axis | per-file `scannedAt`, taken before the file's read (a pull: before its request; `lsp_diagnostics`: before its stat) (#3505) | before | mtime | the same unlatched mtime gate as the widget row: `WidgetOwnLateStamp` / `MutWidgetOwnLateStamp` |
| project-diagnostics snapshot | size+sha256 per file; `scannedAt` after the loop only for rows without a fingerprint. A fresh scan is checked too before its rows reach the widget (#3573) | at the read | content | not committed (see below) |
| advisory-provenance (gitleaks/trivy/opengrep/govulncheck `scannedAt`) | `new Date()` at `runScan` entry | before the spawn | mtime | not committed (see below) |
| analyzer lane rows (knip, jscpd, madge, dead-code, gitleaks/trivy/opengrep/govulncheck) through `pilens_analyze` and the project-diagnostics fresh fetch | the lane's own `scannedAt`, stamped at the top of the client's run body, or the run's `startMs` when it carries none; a caller that joins an in-flight run inherits the initiator's stamp (#3600, #3690) | before the lane's read | mtime | same shape as `BlockerDepLateStamp` (`NoStaleServeBeyondTol`); the lanes are not separately configured |
| late-aux drain | `markedAtMs` | see `formal/late-aux-drain` | | |
| freshness-cadence | a TTL, not a reference stamp | | | not modelled |

The investigation behind these issues also checked the stores this change
does not touch: the project-diagnostics snapshot (`ProjectDiagContent` pass,
957k states; its pre-#2154 mtime-only and size-only mutants violated), the
advisory stamp (`AdvisoryStartStamp` pass), the coarse-mtime and mtime-regress
assumptions, and the #1095 and #2300 workspace bindings. Those configs are not
committed: the `TLA+ models` job already takes 352 s of its 10 minute cap on
master (run 36249982514), and they would add about two minutes for stores
with no change here. The configs below are the ones these fixes flip, their
mutants, and the non-vacuity and tolerance checks the flips rest on.
## Code map

The fixed code each passing config models, and the replay that pins it
(`tests/clients/store-freshness-formal.test.ts`,
`tests/clients/lsp/workspace-diagnostics-store-freshness.test.ts`,
`tests/tools/lsp-diagnostics-cache.test.ts`).

- `Stamp = "start"` for the pipeline stores: `clients/pipeline.ts`
  `analysisReadAtMs`, taken before the first read, re-taken before the
  post-format read (`runFormatPhase`'s `fileReadAtMs`) and the post-autofix
  re-read, so pi-lens' own writes land before it. It is passed to
  `recordDiagnostics` and returned as `PipelineResult.analysisReadAtMs`, which
  `clients/runtime-tool-result.ts` threads into `recordInlineBlockers`.
- `ForceHash = TRUE`: `clients/blocker-freshness.ts` `detectSelfDrift` has no
  mtime tier; a matching size goes straight to the hash budget and the hash.
- `StatAt = "before"` and `Stamp = "start"` for the sweep:
  `clients/lsp/index.ts` `noteScanStat`, called before the pre-open read and
  before `processFile`'s own read; a pull stamps `pullStartedAt` before its
  request. `record()` takes the stamp as its `scannedAt`
  (`clients/lsp/workspace-diagnostics-cache.ts`). `tools/lsp-diagnostics.ts`
  stamps before its stat and passes the same stamp as its fresh widget
  row's `observedAt` (review round 1); its single-file mode stamps the row
  before its touch (review round 2).
- `Stamp = "start"` for the other widget writers (#3573):
  `runWorkspaceDiagnosticsSwept` returns each fresh result with its
  `scannedAt` as `observedAt`, and `tools/lens-diagnostics.ts` carries it
  through the correlated commit; `clients/mcp/analyze.ts` stamps before its
  LSP warm-up; `clients/dispatch/integration.ts` stamps the active cascade
  touch before the neighbor's read (`tests/tools/lens-diagnostics-read-stamp.test.ts`,
  `tests/clients/mcp/analyze.test.ts`, `tests/clients/cascade-compute.test.ts`).
- `Binding = TRUE`, `BindingAt = "read"` for the pull path (#3505 b):
  `clients/lsp/client.ts` `clientRequestWorkspaceDiagnostics` binds a full
  item to `documentContentHashes` for an open document at the reported
  version, and `runWorkspaceDiagnosticsSwept` records a pull answer only with
  that binding (`forget()` drops the entry an unbound answer supersedes).

## Results

TLC 1.7.4, `-workers auto`, 4 cores. The state count is distinct states. For
a violated config, the count is where the first counterexample was found, and
it varies with worker scheduling.

| Config | Expect | States | s |
|---|---|---|---|
| `WidgetOwnLateStamp` | pass | 36,071 | 2.3 |
| `BlockerDepLateStamp` | pass | 36,071 | 4.6 |
| `FixReadStampWide` (the read stamp, three writes, latched) | pass | 823,973 | 12.1 |
| `MutWidgetOwnLateStamp` (record-time stamp) | violated NoStaleServeBeyondTol | 1,901 | 2.0 |
| `MutBlockerDepLateStamp` (record-time stamp) | violated NoStaleServeBeyondTol | 2,128 | 2.2 |
| `LateStampNoGate` (mutant: no gate) | violated NoStaleServeBeyondTol | 2,683 | 2.5 |
| `FixReadStampNoTol` (mutant: tolerance 0) | violated NoSpuriousDemotion | 991 | 2.0 |
| `SanityServes` | violated NeverServes | 798 | 1.5 |
| `ToleranceWindow` | violated NoStaleServe (admitted) | 960 | 1.8 |
| `BlockerNonLspOwnFastPath` | pass | 11,543 | 3.4 |
| `BlockerLspOwn` | pass | 80,185 | 6.5 |
| `MutBlockerNonLspOwnFastPath` (late stamp + fast path) | violated NoStaleServeBeyondTol | 1,067 | 2.0 |
| `FixBlockerReadStampStrict` (read stamp, fast path kept) | violated NoStaleServe | 695 | 2.0 |
| `WorkspaceOwnStatAfterRead` | pass | 156,415 | 4.0 |
| `MutWorkspaceOwnStatAfterRead` (stat after the read) | violated NoStaleServe | 1,583 | 1.8 |
| `WorkspaceOwnPullPostHocHash` (pull path, #3505 b) | pass | 206,290 | 5.1 |
| `MutWorkspaceOwnPullPostHocHash` (disk hash after the answer) | violated NoStaleServe | 863 | 2.5 |
| `WorkspaceOwnPullStatBeforeLag` (fix mutant: stat before the request, no binding) | violated NoStaleServe | 2,813 | 2.6 |
| `WorkspaceOwnCoarseSameSize` | violated NoStaleServe (admitted, #2300) | 688 | 1.6 |
| `WidgetOwnRetain` (`StoreRetire`, #4625) | pass | 68,215 | 2.9 |
| `MutWidgetOwnDropOnce` (`StoreRetire`: deleted, the sweeping call told once) | violated NoCleanAfterDemotion | 6,011 | 2.3 |
| `MutWidgetOwnDrop` (`StoreRetire`: deleted, nobody told) | violated NoCleanAfterDemotion | 2,892 | 2.5 |

The three `StoreRetire` rows ran with `-workers 1`, as
`scripts/check-tla-models.mjs` runs every config (#3517).

Times are from a shared 4-core host at load average 11 (review round 1); the three pull-path rows were re-run for #3505 b at load average 6.

## Traces

**Late record stamp** (`MutWidgetOwnLateStamp`, `MutBlockerDepLateStamp`;
`MutBlockerNonLspOwnFastPath` has the same trace with an equal-size write):

1. Start.
2. Read v1 at t=0.
3. A write lands at t=0 with mtime 0.
4. Tick.
5. Record at t=1 stamps `ref = 1`.
6. The gate computes `0 > 1 + Tol` = false and serves v1 while disk holds v2.

The offending write is before the reference, so the tolerance does not
excuse it.

**Stat after read** (`MutWorkspaceOwnStatAfterRead`):

1. Read v1.
2. A write lands v2.
3. Record stats v2's mtime and size.
4. The gate finds the stat equal to disk and serves v1.

## Retirement (`StoreRetire`, #4625)

`lens_diagnostics` reads the widget store, and the store's stale gate
(`reconcileStaleWidgetFiles`) used to delete a record whose file changed
after it was read. The model adds the record (`live`, `unfinished` or
`gone`), two actors that run the gate over it, and a reader.

- The tool's sweep runs inside a read. An observer hands that one call the
  files the sweep just invalidated.
- The footer's sweep (`scheduleStaleReconcile`) runs the same gate with no
  observer, at any time between reads.
- The reader reports only what the record says: `served` for a live
  record, `inconclusive` for an unfinished one. A record that is gone has
  nothing to flag, so the file reads `clean`. The `unverified` rule covers
  a file the request names; a directory scope, or a sibling's final
  snapshot, still prints the check mark.

`Retire` is what a stale verdict leaves behind:

| `Retire` | The code | Config |
|---|---|---|
| `"drop"` | deleted, nobody told: the code before #4625 | `MutWidgetOwnDrop` |
| `"dropOnce"` | deleted, the sweeping call told through its observer: #4625 at 586dd00fd | `MutWidgetOwnDropOnce` |
| `"retain"` | kept as unfinished evidence: `hasFinalDiagnosticsSnapshot = false`, only the findings still current stay, `touchedAt` moved to the sweep and never before the file's mtime | `WidgetOwnRetain` |

`NoCleanAfterDemotion`: once the gate has demoted the result, no read says
`clean`. `WidgetOwnRetain` also checks `NoStaleServeBeyondTol`, so the
extension keeps the base module's promise. The two mutants are the
non-vacuity witnesses: the same gate constants reach a demotion, and only the
retained record keeps it from reading clean.

**One read only** (`MutWidgetOwnDropOnce`, the shortest trace TLC finds):

1. Start, a write lands after the reference, Read, Record.
2. The tool's sweep demotes the result and deletes the record. Its observer
   makes this one read answer `inconclusive`.
3. A second read finds no record and answers `clean`.

**Footer first** (`MutWidgetOwnDropOnce`, the same depth): the footer's sweep
takes step 2, with no observer, so the first read never hears of the change
and answers `clean`. TLC reaches `rec = "gone"` with no report through
`FooterSweep` alone.

Replays: `tests/tools/lens-diagnostics-session-evidence.test.ts` ("stays
inconclusive on a second read that rescans nothing" and "stays inconclusive
when the footer's observer-less sweep ran first") drive both traces through
the built tool and the real widget store; `tests/clients/widget-state.test.ts`
("keeps the record unfinished, reports it once, ...") drives the record.
`formal/switch-pins.json` pins `Retire = "retain"` to those tests.

## Scope and limits

- `StoreRetire`: a run has one computation, so the two ends of an
  unfinished record are not modelled. A fresh snapshot (`commitDiagnostics`
  sets the final flag again) is pinned by the vitest case "stays inconclusive
  until a fresh final snapshot replaces the evidence". The store's idle
  eviction (a record idle for 30 minutes, once the store holds more than
  1,024 file records) retires the mark too: that is the store's existing rule, no timer was
  added for it, and the vitest case "is retired by idle eviction counted
  from the sweep" pins that the idle window starts at the sweep. A retained
  record that still holds errors or warnings is the exception: like a final
  snapshot's findings it stays, and the footer draws it, so the findings the
  header counts stay visible ("keeps a retained record that holds findings
  through idle eviction", "draws the findings a partial prune kept, ...").
- `StoreRetire`: a file that is gone from disk still drops its record,
  which the model does not reach (X is only written). `dropStaleFiles`
  (resume) deletes a persisted record whose file changed between sessions;
  that file reads `unverified` when the request names it, and a directory
  scope reads it like any file the session never diagnosed (an accepted
  residual of #4625).

- One input file per config. A result with many dependencies is the union
  of per-dependency configs, because the gates check each file
  independently.
- For the dependency axis, `Read` means "the analysis consumed the
  dependency's bytes". For an LSP verdict that point is not observable. A
  server answering from an older in-memory view of the dependency reads
  before any stamp pi-lens can take, which is `ServerLag`. The read-stamp fix
  closes the pi-lens-side window, not server lag.
- The model cannot catch a stamp taken too early. `NoSpuriousDemotion`
  only says a result is not demoted when nothing was written after its
  reference; a reference pinned far in the past satisfies it whenever any
  write happened. A scratch mutant with `ref' = 0` in `Start` passes
  `BlockerDepLateStamp`, `WidgetOwnLateStamp` and `FixReadStampWide`. The
  too-early direction (a verdict demoted by pi-lens' own format or autofix
  write, or by a write before the read) is pinned by the vitest cases
  instead: `FixReadStamp no-drop (#3503)` and `FixReadStamp control (#3503)`
  in `tests/clients/store-freshness-formal.test.ts` (mutations M3, M4, M5),
  the `FixReadStamp no-drop (#3505)` cases for the sweep (W3, W5, W7), and
  the `lsp_diagnostics` widget-row cases in
  `tests/tools/lsp-diagnostics-cache.test.ts` (R1b, R2b).
  Modelling the read instant separately from the stamp would close this.
- A runner that reads the file from disk itself during the dispatch reads
  after the stamp. That is the safe direction: a write between the stamp and
  that runner's read can demote a result computed on the new bytes, but can
  never leave a stale one served.
- There is no ABA (content returning to earlier bytes), no `touch` (mtime
  moving without content), and no deletion. Every write changes the bytes.
- Ordering between two computations of the same file is not modelled
  (`formal/dispatch-pipeline` covers the inline record's write order).
- The tick scale is coarse: `Tol = 2` is 50 ms with one tick at 25 ms.
- Assumptions, not bugs: an mtime restored to an older value by `cp -p`, tar
  or `rsync -t`, and an mtime granularity coarser than 50 ms
  (`WorkspaceOwnCoarseSameSize`, #2300).
- `BlockerLspOwn` runs with two writes in six ticks (three in eight in the
  investigation, 957k states) to fit the CI budget.

## #4541 mtime-only drift

`WorkspaceOwnTouchBound.cfg` models the current pull binding with `Gate =
"eqTouch"`: size still gates, and mtime drift is waived only by a matching
hash bound to the diagnosed text. `WorkspaceOwnTouchUnbound.cfg` models the
per-file path with no binding: mtime drift still refuses it.
`MutWorkspaceOwnTouchPostHocHash.cfg` replaces the sent-text binding with a
post-answer disk hash and must violate `NoStaleServe`. These three configs
have not been run in the round-3 sandbox (Java is absent); their expected
results are obligations for the host, not measured results.

The writer is `recordSentContent` in `clients/lsp/client.ts`; the full pull
answer accepts its hash only when the reported version matches. The sweep
threads that hash into `record`, never a post-answer disk hash. Existing
`eq` configs remain as the historical strict-stat gate and its counterexamples.
