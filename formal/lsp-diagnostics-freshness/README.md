# Push-diagnostics freshness model

A TLA+ model of whether the diagnostics a touch's wait settles on were
computed for the content that touch sent. It covers one open document, the
LSP client (`clients/lsp/client.ts`) and a push-only server. Every config
starts with an `\* expect:` line (see `formal/file-locks/README.md`), and
the `TLA+ models` CI job checks each one against it.

Issue: #3484.

## What the model covers

- **Touch A** (`LSPService.touchFile`, the pipeline's `lsp_sync` touch):
  - it reads the per-path baseline (`getDiagnosticsVersionForPath`,
    `clients/lsp/index.ts`);
  - then `notify.open` → `handleNotifyOpenOnce` (`clients/lsp/client.ts`). The
    document is open, so in one tick it bumps `documentVersions`, calls
    `clearDiagnosticsForPath` (unless `preserveDiagnostics`) and sends
    `didChange`;
  - `markTouched` runs after the send resolves (`clients/lsp/index.ts` `touchFile`).
- **The waiter**, in one of two forms:
  - `SkippedWait = FALSE`: A itself waits, with `minVersion` set to its
    baseline (`clients/lsp/index.ts` `touchFile`);
  - `SkippedWait = TRUE`: the dispatch runner's touch B, with the same
    content. `shouldSkipNotify` finds A's `markTouched` entry, so B
    sends nothing and waits with no baseline.
- **`clientWaitForDiagnostics`** (`clients/lsp/client.ts`):
  - the early return: fresh, not `isVersionStale`, and a non-empty cache;
  - otherwise it registers a listener. `onDiagnostics` re-checks those
    conditions and (re)arms a quiet-window timer. In `DiagnosticsFreshness.tla`
    the timer resolves the wait without checking again. The code checks again
    when it fires (a pending later receipt, `laterReceiptPending`, and a stored
    answer, `answerStored`); `DependencyAnswer.tla` models both checks;
  - a timeout also resolves the wait;
  - `touchFile` reads `getDiagnostics` later, after more awaits.
- **The `publishDiagnostics` handler** (`clients/lsp/client.ts` `setupIncomingHandlers`):
  - seed-first-push stores the first push at once, with an `isSupersededPush`
    check;
  - otherwise it uses a per-path debounce timer, which checks
    `isSupersededPush` when it fires. A clear cancels that timer.
- **The server** reads client messages in order. It publishes for the content
  it last read, stamped with the version if `VersionedServer`. With
  `AsyncServer` it may also publish for the content before that (an analysis
  started before the latest change). Server-to-client messages are FIFO and
  interleave freely with client steps.

A check and the send in the same tick are one step, and each `await` starts
a new one. The content sent as version *k* is called content *k*. Each
publish carries a ghost `cv`, the content it was computed for, whether or not
the version goes on the wire.

## Invariants

- `FreshResult`: when a wait settles on diagnostics (the early return or the
  quiet window), the diagnostics `touchFile` then reads were computed for
  content 1 (this touch's) or newer. An empty cache is not a result.
- `FreshRead`: the same check, but also for a wait that timed out.
- `NoKnownStaleCached`: after the send, no cached entry has a known version
  older than the document's.
- `NoFreshDropped` (#3484 review): the fence never drops a version-less
  publish computed for the touch's own content. A server that publishes the
  new content once and never again would otherwise leave the touch with no
  answer at all.

`ReplyFirst` is a server property: the server answers a fence before it
publishes for content it read after that fence's `didChange`. With
`ReplyFirst = FALSE` the server may publish the new content first, as
docker-langserver does 2-3 ms after `didChange`.

## Results

`node scripts/check-tla-models.mjs`, TLC 2.19, `-workers 1` (#3517: every config
now runs with a single worker for a deterministic first-violation verdict),
`MaxPubs = 3`. For a violated config, the state count is how far TLC got before
the counterexample.

| Config | Expect | Verdict | Distinct states | s |
|---|---|---|---|---|
| `VersionedBaseline` | pass | pass | 3872 | 2.1 |
| `VersionedSkipped` | pass | pass | 3872 | 2.5 |
| `VersionedSeedSkipped` | pass | pass | 2744 | 2.5 |
| `VersionedPreserve` | pass | pass | 3640 | 2.2 |
| `VersionlessBaseline` | pass (after #3484: fenced, reply-first) | pass | 2736 | 1.2 |
| `VersionlessSkipped` | pass (after #3484: fenced, reply-first) | pass | 2736 | 1.2 |
| `VersionlessSeedSkipped` | pass (after #3484: fenced, reply-first) | pass | 2448 | 1.2 |
| `UnfencedVersionless` | violated FreshResult (residual: unmarked servers) | violated FreshResult | 859 | 1.2 |
| `MutFencePublishFirst` | violated NoFreshDropped | violated NoFreshDropped | 84 | 1.1 |
| `PreserveTimeoutRead` | violated FreshRead | violated FreshRead | 1735 | 2.1 |
| `MutantNoGuards` | violated FreshResult | violated FreshResult | 921 | 1.7 |
| `MutantNoSuperseded` | violated FreshResult | violated FreshResult | 3617 | 2.2 |
| `MutantPreserveNoVersionStale` | violated FreshResult | violated FreshResult | 1689 | 2.1 |
| `FenceSkipped` | pass | pass | 2736 | 1.3 |
| `FenceBaseline` | pass | pass | 2448 | 1.3 |
| `FenceAsyncServer` | violated FreshResult | violated FreshResult | 3048 | 1.2 |
| `FenceNoClear` | violated FreshResult | violated FreshResult | 1444 | 1.3 |
| `FenceLate` | violated FreshResult | violated FreshResult | 1777 | 1.2 |

Every `Fence = TRUE` config sets `ReplyFirst = TRUE`; the others set it
`FALSE` (it only restricts the server, so their verdicts are unchanged).

The versioned passes allow `AsyncServer`: late publishes for older content
are in scope. In the exploration grid, every combination of `SeedFirstPush`
× `SkippedWait` × `AsyncServer` passed for a versioned server and failed for
a version-less one.

## The traces

**`VersionlessSkipped` / `VersionlessBaseline`** (before #3484, with
`Fence = FALSE`: violated in 9 states; `VersionlessSeedSkipped` in 8. #3484
set `Fence = TRUE` in all three):
1. A reads baseline 0. Its runner bumps the version to 1, clears the path,
   and sends `didChange(1)`.
2. The server, still on content 0 (a slow analysis of the previous edit),
   publishes for it with no version.
3. The client receives the publish after the clear. `isSupersededPush`
   returns false because `docVersion === undefined`, so the debounce
   timer is armed and fires. The handler caches the content-0 diagnostics,
   bumps the per-path stamp to 1, and leaves `diagnosticDocVersions` unset.
4. The wait starts. With no baseline, `hasFreshDiagnostics` is trivially
   true. With baseline 0, stamp 1 > 0, because the clear deleted the old
   stamp and any later store beats the baseline. `isVersionStale` is false
   (no cached version), and the cache is non-empty, so the early return
   fires.
5. `touchFile` reads content-0 diagnostics as this touch's answer.

The baseline adds no protection: it proves that *a* publication landed after
the clear, not that it is *about* the new content. `SeedFirstPush` gives the
same result, with the publish stored at receipt (8 states).

**`MutantNoSuperseded`**: `isVersionStale` alone does not protect the
result.
1. A fresh v1 publish is stored.
2. A late v0 publish arrives and arms the handler's timer.
3. The wait early-returns on v1.
4. The v0 timer then fires and overwrites the cache (it is no longer
   dropped).
5. `touchFile` reads v0.

`isVersionStale` gates only the wait, never the later read. With FIFO and no
`AsyncServer`, removing just one of the guards (`noSuperseded`,
`noVersionStale`, `noClear`) still passes: the clear, `isSupersededPush` and
`isVersionStale` each cover for the others when the server is versioned.
Removing both version guards (`MutantNoGuards`) fails in 10 states.

**`PreserveTimeoutRead`**: a `preserveDiagnostics` resync keeps v0's cached
diagnostics.
- `isVersionStale` stops them from *settling* the wait (`VersionedPreserve`
  passes).
- A wait that times out still reads them. This is the "#1095 note" at
  `clients/lsp/client.ts` `handleNotifyOpenOnce`: the binding then reads `boundToCurrentDisk: false`.
- `touchFile`'s own notify never passes `preserveDiagnostics`. The only
  caller that passes `true` is the rename path (`clients/lsp/index.ts` `renameFile`).

## Replay on the real client

A throwaway vitest file (deleted from `tests/` after the run) drives the real client:
- `handleNotifyOpen` runs the open-document branch;
- the `didChange` send is held with `gatedPromise` while a content-0 publish
  is delivered through the real `publishDiagnostics` handler;
- then the send is released, the quiet window passes, and
  `clientWaitForDiagnostics` runs with and without `minVersion`.

```text
[replay] versioned=false skipped=false baseline=0 docVersion=1 waitedMs=0 result=["error computed for content 0 (pre-touch)"]
[replay] versioned=false skipped=true baseline=0 docVersion=1 waitedMs=0 result=["error computed for content 0 (pre-touch)"]
[replay] versioned=true skipped=false baseline=0 docVersion=1 waitedMs=601 result=[]
[replay] versioned=true skipped=true baseline=0 docVersion=1 waitedMs=600 result=[]
      Tests  4 passed (4)
```

A version-less server's stale publish settles both waits at once. The same
publish with `version: 0` is dropped, and the wait runs to its budget.

## The fix (#3484) and its mutations

**Fence** (`Fence = TRUE`, shipped in #3484):
- in the same tick as the `didChange` send, the client also sends a request
  the server must answer in order;
- until the reply arrives, the handler drops version-less publishes for the
  path.

The reply comes after every publish the server sent before reading the
`didChange`.

- It passes (`FenceSkipped`, `FenceBaseline`) when the server publishes only
  for content it has read.
- `FenceNoClear`: the existing clear is still needed. A stale publish
  received *before* the send has already armed the handler's debounce timer;
  without the clear, that timer stores it.
- `FenceLate`: sending and arming the fence after the `didChange` send
  resolves lets a stale publish in between.
- `FenceAsyncServer`: a server that answers the fence and *then* publishes a
  finished analysis of the older content defeats it. The client cannot rule
  that out without a version, so no client-side ordering fix is sound for
  every version-less server.

LSP has no generic no-op request for the fence. The code borrows
`textDocument/documentSymbol`, at one extra round trip per touch.

**Neither order is sound for every server** (#3484 review). A server that
publishes the new content before it answers the fence (docker-langserver)
has that answer dropped, and it never republishes: `MutFencePublishFirst`
violates `NoFreshDropped` in a few states, and against the real server the
touch waited its full budget with no diagnostics on every edit. So the fence
is per server.

How the code realises it (`clients/lsp/client.ts` `sendFenced`,
`armDiagnosticsFence`), and where it is narrower than the model:
- The fence goes out only to a server whose strategy carries the measured
  marker `diagnosticsFence: "reply-first"`
  (`clients/lsp/wait-policy/strategies.ts`): `yaml` and `php` (intelephense).
  `Fence = TRUE, ReplyFirst = TRUE` is that server. A marked server is fenced
  from its first touch; nothing is learned from its publishes.
- Every other server is unfenced (`UnfencedVersionless`, violated): docker
  (measured publish-first), prisma (measured reply-first 23/23, but by only
  1-4 ms, so not marked), and the unmeasured taplo, zls, dart, gleam and
  clojure-lsp. Versioned servers need no fence.
- A marked server that does not advertise `documentSymbolProvider` gets no
  fence; one `lsp_diagnostics_fence` row (`outcome: "no-request"`) per client
  says so.
- The fence lifts on its reply, on an error reply, on a newer fence for the
  path, or after the client's diagnostics wait ceiling
  (`DIAGNOSTICS_WAIT_TIMEOUT_MS`); publishes are then accepted as before and
  the binding stays "unknown". An unanswered or superseded fence's request is
  cancelled (`$/cancelRequest`), and a fence never counts toward `isBusy()`.
  The model's fence always gets its reply.
- Every drop is counted: the `lsp_diagnostics_fence` row that ends a fence
  carries `droppedPublishes` (written on a timeout, and on any end that
  dropped something).
- The fence is armed at the first send after the clear on the open
  document's `didChange`, the first `didOpen`, and the change path's fallback
  `didOpen` and `didChange`. Only the first is modelled. The `reopenOnResync`
  close + reopen is not fenced: only opengrep uses it, and opengrep is not
  marked.

## Scope

Not modelled:
- the pull path;
- the `reopenOnResync` close + reopen branch (opengrep): there, a `didClose`
  send is awaited between the clear and the `didOpen`, so a post-close
  publish lands in that window too;
- the not-yet-open branch (a `pendingOpens` add, then `await access()`
  between the clear and the `didOpen`);
- the #3310 empty-first-publish hold;
- the auxiliary carry-over;
- notify-queue coalescing (A's waiters resolve on a superseding entry's send,
  but `markTouched` records A's content).

Only one content change is sent, and publishes are bounded at 3.

The dispatch touch is only skipped when its `clientScope` key matches the
`lsp_sync` touch (`"primary"`). With auxiliaries it is `"with-auxiliary"`,
so it notifies and takes the baseline path. That path violates the same way.

## Dependency answer (#4782)

`DependencyAnswer.tla` covers which push answer the dispatch takes for a
dependent `a.ts` after one bash command rewrote `a.ts` and the `z.ts` it
imports:
- the primary phase (`resyncHeldPrimaries`, `clients/lsp/index.ts`) sends
  `a.ts`'s change (its clear empties the cache and the pending receipt),
  then `z.ts`'s, on one ordered stream. With `Resend` (#4782 item 1) it then
  sends `a.ts`'s unchanged bytes again (`ClientSend`): that write empties the
  cache and the slot and moves the client's version of `a.ts` on. With `Drain`
  it ends with the drain request; without it (threaded or unmeasured reply
  ordering, every row that declares `resendRecheck: "rechecks"` today) no
  drain request goes out;
- the server publishes `a.ts`'s check against the `z.ts` it holds (ghost
  `zv`): the pre-`z.ts` answer STOPs, the later one is clean;
- the handler keeps one pending receipt per path in its quiet-window slot
  (`pendingDiagnostics`) and stores it when the slot's timer fires. With
  `Versioned`, a publish carries the `a.ts` version the server read, and one
  older than the client's version is dropped as superseded
  (`isSupersededPush`);
- the waiter is the skipped dispatch touch (no baseline). It starts after
  the drain reply, or, without `Drain`, once the phase wrote its last send.

`PendingGuard` is the fix: neither the early return nor the quiet-window
settle takes the cache while the slot holds a later receipt. `Republish`
is a server property: having read `z.ts`'s change, the server publishes
`a.ts`'s re-check before it reads its next message (the fake checker does).

`Clear` (`MaxClears`, #4785 F4) is a clear of `a.ts`'s stored state while its
wait is open: `clearDiagnosticsForPath` (`clients/lsp/client.ts:2169`) empties
the stored answer and cancels the receipt in the slot in one tick. Production
reaches it from a `workspace/diagnostic/refresh`
(`clients/lsp/client.ts:3587`) and from a later `didChange`
(`clients/lsp/client.ts:5050`); `tests/clients/lsp/touch-cleared-deferred-wait-4785.test.ts`
drives it mid-wait. The wait's own state is untouched, so the quiet window
fires on an emptied cache, and the answer guard (`answerStored`,
`clients/lsp/client.ts:4689`) makes it keep waiting instead of resolving. The
touch reads "no answer" only from a wait that ran to its budget, so an early
resolve on an emptied cache reads as a confirmed clean. `MaxClears = 0` is the
model before this action: nothing empties the cache after a store.

Invariants:
- `NewestAtSettle`: when the wait settles, no later receipt is pending.
- `NoPhantomFinding`: a settled read of `a.ts` was computed against `z.ts`'s
  new bytes.
- `SettleNeedsAnswer`: when the wait settles, an answer is stored. In this
  model `Clear` fires only while the wait is open, so a settled wait's cache
  never empties afterwards. The code has no such restriction (see the
  post-settle clear below).
- `NoDroppedAnswer` (`how = "timeout" => ~dropped`): a quiet window that fires
  on a stored answer with no later receipt pending must not leave the wait to
  run out its budget. `dropped` is a ghost, set from the outcome of
  `WaitSettle` (the window fired on a stored answer, nothing was pending, and
  the wait is still open) and cleared by `Clear`. `SettleNeedsAnswer` cannot
  see this: a window that rejects the only answer never settles. In the
  as-built spec the ghost stays FALSE, so only a mutant that changes the
  window's outcome reaches it.
- `NoCanceledStored` (`cache.has => cache.seq # canceled`): the receipt a
  `Clear` takes out of the slot is never stored afterwards. Each receipt has a
  unique `seq`; the ghost `canceled` holds the one the last `Clear` took.

`DependencyFix` is the exhaustive check of all five invariants.
`DependencyLateRepublish` carries them too, but TLC stops at its own expected
`NoPhantomFinding` counterexample, so it explores 287 of its states. With only
the three newest invariants it passes all 874.

| Config | Expect | Verdict | Distinct states | s |
|---|---|---|---|---|
| `DependencyFix` | pass | pass | 590 | 0 |
| `DependencyPreFix` | violated NoPhantomFinding | violated NoPhantomFinding | 196 | 0 |
| `DependencyMutSettleGuard` | violated NewestAtSettle | violated NewestAtSettle | 355 | 0 |
| `DependencyLateRepublish` | violated NoPhantomFinding (residual) | violated NoPhantomFinding | 287 | 0 |
| `DependencyMutAnswerGuard` | violated SettleNeedsAnswer | violated SettleNeedsAnswer | 284 | 0 |
| `DependencyMutAnswerGuardNoClear` | pass (vacuity) | pass | 266 | 0 |
| `DependencyMutDropAnswer` | violated NoDroppedAnswer | violated NoDroppedAnswer | 283 | 0 |
| `DependencyMutDropAnswerBlind` | pass (blindness) | pass | 615 | 0 |
| `DependencyMutWidenGuard` | violated NoDroppedAnswer | violated NoDroppedAnswer | 283 | 0 |
| `DependencyMutRetainSlot` | violated NoCanceledStored | violated NoCanceledStored | 39 | 0 |
| `DependencyMutRetainSlotBlind` | pass (blindness) | pass | 777 | 0 |
| `DependencyResend` | pass | pass | 1647 | 0 |
| `DependencyMutNoResend` | violated NoPhantomFinding | violated NoPhantomFinding | 110 | 0 |
| `DependencyResendVersionless` | violated NoPhantomFinding (residual) | violated NoPhantomFinding | 286 | 0 |

Every config before `DependencyResend` sets `Resend = FALSE`,
`Versioned = FALSE` and `Drain = TRUE`, where the three new variables are
constant, so their counts are the ones they had before the re-send was
modelled.

**`DependencyPreFix`** is the measured trace:
1. The server reads `a.ts`'s change and publishes the pre-`z.ts` STOP.
2. It reads `z.ts`'s change, publishes the clean re-check, then reads the
   drain request and replies.
3. The client stores the STOP when its slot fires. The clean receipt then
   takes the slot, and the drain reply arrives.
4. The wait starts. The cache is non-empty, so the early return takes the
   STOP while the clean answer is still pending.

An instrumented run of `tests/clients/head-move-resync-4493.test.ts` showed
the same order: the STOP stored, the clean receipt, the drain reply within 2 ms
later, then the wait (`pending=true stored=1`).

**`DependencyMutSettleGuard`**: with the guard on the early return only,
the quiet window settles on a stored answer while a later one is pending.
After a drained phase both answers postdate `z.ts`, so the rule breaks but
the read is not a phantom. A wait that starts before the newer receipt does
read the stale one; `tests/clients/lsp/pending-receipt-wait-4782.test.ts`
drives that through the real handler.

**`DependencyLateRepublish`** (residual): a server that answers the drain
request before it republishes `a.ts` (an asynchronous re-check) leaves the
pre-`z.ts` answer as the newest one. No publication names the dependency's
version, so no client-side read can tell. The guard does not help there,
and the model says so.

**`DependencyMutAnswerGuard`**: the answer guard dropped from the quiet
window (`Mutant = "noAnswerGuard"`), 11 states:
1. The server publishes; the client receives the receipt, and the wait starts
   (`listen`).
2. The slot fires: the answer is stored and the window is armed.
3. A clear empties the cache.
4. The window fires on the emptied cache and resolves the wait with
   `how = "settled"` and no stored answer.

**`DependencyMutAnswerGuardNoClear`** is the vacuity ratchet for it: the same
mutant with `MaxClears = 0` passes (266 states, the count the model had before
`Clear`), because nothing ever empties the cache after a store. Before the
clear action, `SettleNeedsAnswer` held for any guard. If this config reds, the
clear no longer reaches the guard and the mutant config above checks nothing.

**`DependencyMutDropAnswer`**: the hand mutant for `NoDroppedAnswer`
(`Mutant = "dropAnswer"`). The quiet window fires on a stored answer with no
later receipt pending and returns to `listen`, so only the deadline can end the
wait. 11 states:
1. The server publishes; the client receives the receipt; the wait starts
   (`listen`).
2. The slot fires: the answer is stored and the window is armed.
3. `WaitSettle` finds the answer and nothing pending, and goes back to
   `listen` (`dropped = TRUE`).
4. `WaitTimeout` ends the wait with `how = "timeout"`.

**`DependencyMutDropAnswerBlind`** is its blindness ratchet: the same mutant
with only the three older invariants passes (615 states), because a wait that
never settles breaks none of them. If it reds, an older invariant now sees the
drop and `NoDroppedAnswer` is no longer the property that catches it. The
property passes trivially only if no run reaches the drop; the mutant config
shows one does. Neutering the ghost (`dropped' = FALSE`) turns the mutant
config green.

**`DependencyMutWidenGuard`**: a second edit that reaches the same outcome.
The answer guard is widened (`AnswerGuarded /\ ~cache.has` becomes
`AnswerGuarded`), so the window also refuses a stored answer. The state graph
equals the hand mutant's (283 states, same counterexample), and the three older
invariants pass it (615 states, the same as `DependencyMutDropAnswerBlind`). It
shows `NoDroppedAnswer` observes a real outcome and not only its own mutant.

**`DependencyMutRetainSlot`**: `Clear` empties the cache but leaves the receipt
in the slot (`Mutant = "retainSlot"`). 6 states:
1. The server publishes the pre-`z.ts` STOP (`seq 0`); the client receives it
   into the slot.
2. `Clear` empties the cache and, in the code, cancels the receipt; here the
   ghost records `canceled = 0` and the slot stays.
3. `SlotFire` stores the receipt: the cache holds `seq 0`, the canceled answer.

**`DependencyMutRetainSlotBlind`** is its blindness ratchet: the same mutant
checked with the four older invariants passes (777 states). The canceled
receipt is a valid answer for the content it was computed for, so no settle or
freshness rule breaks. Neutering the ghost (`canceled' = canceled`) turns the
mutant config green.

The omitted `SlotFire` reset of `dropped` moves no verdict, but it moves the
distinct counts (a probe that resets it changes the blind config's count), so
the counts above belong to this exact spec.

The drop exit (the `PENDING_RECEIPT_DROPPED` listener,
`clients/lsp/client.ts:4742`) carries the same `answerStored` guard and has no
action here: a dropped receipt in a version-less model would have to be limited
to the superseded and refused ones, which it cannot name. The #4785 tests pin
that site.

A clear after the wait resolved (`touchFile` reads a few awaits later) is not
modelled, and `Clear` is restricted to an open wait. In the code the window is
open on a touch with auxiliaries: the primary's wait resolves, the aux waits
run (`clients/lsp/index.ts:5431-5434`), and a refresh handled in that gap
empties the primary's cache before the merge. `SettleNeedsAnswer` cannot
express it, because it needs a read-time ghost on the cache `touchFile` reads.
Unreproduced.

### The re-send (#4782 item 1)

`DependencyLateRepublish` is the residual the drain cannot close: the server
re-checks `a.ts` only on its own timer after `z.ts`'s change, so the answer
computed before it is the newest one at the read, and `a.ts`'s version never
moved. `resyncHeldPrimaries` therefore sends `a.ts` again after `z.ts` to a
server declared to re-check unchanged bytes. The three configs below model the
phase as it runs for those servers: `Republish = FALSE` (a timer, not an
in-order republish) and `Drain = FALSE` (no drain request).

**`DependencyResend`** (pyright: `Versioned = TRUE`) passes all five
invariants over 1647 states. The re-send's write empties `a.ts`'s cache and
slot, so nothing stored before it can be read, and every answer the server
computed before it read the re-send carries version 1 and is dropped as
superseded. The only answer that can be stored is one computed after the
server read `z.ts`.

**`DependencyMutNoResend`** is the same config without the re-send. 7 states:
1. The server reads `a.ts`'s change and publishes the pre-`z.ts` STOP.
2. The client stores it; the phase has written its last send, so the wait
   starts, and the early return takes the stored STOP.

**`DependencyResendVersionless`** (typescript-language-server publishes no
version) is the accepted residual (cell 5): the pre-`z.ts` STOP is published
before the re-send is written and received after it, and with no version
nothing can drop it. 8 states: `ServerRead` (a), `ServerPublish`,
`ClientSend` (the re-send clears), `ClientReceive`, `SlotFire`, `WaitStart`,
`Read`. The 40 typescript-language-server probe runs after the fix never
showed it.

Not modelled here: a publish computed before the server read `a.ts`'s own
change (the #3484 shape above), the slot's unstored exits other than the
superseded drop (config-failure refusal; the unit file pins it),
seed-first-push strategies, and a parallel tool's send of `a.ts` during the
phase (the `#3481` read stamps; `tests/clients/head-move-resync-4493.test.ts`
pins it).
