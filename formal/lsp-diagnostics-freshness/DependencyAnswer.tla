------------------------- MODULE DependencyAnswer -------------------------
(***************************************************************************)
(* #4782: which push answer for a dependent a.ts the dispatch read takes  *)
(* after one bash command rewrote a.ts and its dependency z.ts.            *)
(*                                                                         *)
(* Actors:                                                                 *)
(*   - the primary phase (resyncHeldPrimaries, clients/lsp/index.ts): it   *)
(*     sends a.ts's didChange (handleNotifyOpenOnce clears a.ts's cache    *)
(*     and pending receipt in that tick, so the model starts with both     *)
(*     empty), then z.ts's, in order on one stream. With `Resend` (#4782   *)
(*     item 1, a server declared `resendRecheck: "rechecks"`) it then      *)
(*     writes a.ts's unchanged bytes again (ClientSend of "a2"): that      *)
(*     write clears a.ts's cache and slot in its tick and moves the        *)
(*     client's version of a.ts to 2. With `Drain` the phase ends with the *)
(*     drain request and the dispatch's wait starts only after its reply   *)
(*     (a drained phase); without it (a threaded or unmeasured client,     *)
(*     which is every row declared `rechecks` today) no drain request goes *)
(*     out and the wait starts once the phase has written its last send;   *)
(*   - the server: reads its input in order; once it has read a.ts's     *)
(*     change it may publish a.ts's check, computed against the z.ts it    *)
(*     holds (ghost `zv`); the answer before z.ts's change STOPs           *)
(*     (non-empty), the one after it is clean. With `Versioned` a publish  *)
(*     carries the a.ts version the server last read (pyright); without    *)
(*     it, none (TLS). Republish: having read z.ts's change, it publishes  *)
(*     a.ts's                                                              *)
(*     re-check before it reads its next message (the fake checker's       *)
(*     synchronous republish). Server-to-client messages are FIFO;         *)
(*   - the publishDiagnostics handler (client.ts, setupIncomingHandlers):  *)
(*     a versioned publish older than the client's version of a.ts is      *)
(*     dropped as superseded (isSupersededPush); any other receipt         *)
(*     replaces the pending one in the quiet-window slot                   *)
(*     (`pendingDiagnostics`); the slot's timer stores it and emits;       *)
(*   - the waiter, the skipped dispatch touch (no baseline):               *)
(*     clientWaitForDiagnostics's early return (a non-empty cache), else a *)
(*     listener whose quiet window settles on the cache; a timeout also    *)
(*     resolves it; touchFile then reads the cache.                        *)
(*                                                                         *)
(* PendingGuard (the fix): neither the early return nor the quiet-window   *)
(* settle takes the cache while the slot holds a later receipt; the        *)
(* slot's store re-arms the window. Each receipt carries a ghost `seq`, its*)
(* receive order.                                                          *)
(*                                                                         *)
(* The answer guard (#4785 F4, always on in the as-built model): the quiet *)
(* window resolves the wait only while an answer for the path is stored    *)
(* (`answerStored`, clientWaitForDiagnostics, clients/lsp/client.ts). A    *)
(* clear (`Clear`, MaxClears > 0) empties the cache and cancels the slot's *)
(* receipt in one tick: clearDiagnosticsForPath (client.ts:2169), reached  *)
(* from a workspace/diagnostic/refresh (client.ts:3587) or a later         *)
(* didChange (client.ts:5050). The touch reads "no answer" only from a wait*)
(* that ran to its budget, so a settle on the emptied cache read as a      *)
(* confirmed clean. The window then keeps waiting for the next store.      *)
(* Mutant "noAnswerGuard" drops the guard; with MaxClears = 0 nothing ever *)
(* empties the cache after a store, so the guard is vacuous.               *)
(*                                                                         *)
(* No-drop (NoDroppedAnswer): the same guard must not reject the only      *)
(* stored answer. A ghost `dropped` is set when the window fires on a      *)
(* stored answer with no later receipt pending and the wait stays open; it *)
(* clears with the answer (Clear). Mutant "dropAnswer" does that, so the   *)
(* wait can only end by timeout. Mutant "widenAnswerGuard" reaches the    *)
(* same outcome by a different edit, a guard that also refuses a stored    *)
(* answer: the ghost observes a real outcome, not only its own mutant.     *)
(*                                                                         *)
(* Cancel (NoCanceledStored): Clear cancels the slot's receipt. A ghost    *)
(* `canceled` holds the seq of the receipt the last Clear took out of the  *)
(* slot; the invariant says the cache never holds it. Mutant "retainSlot"  *)
(* leaves the receipt in the slot, so its timer stores it.                 *)
(*                                                                         *)
(* Not modelled: a publish computed before the server read a.ts's own      *)
(* change (that is DiagnosticsFreshness's #3484 shape: the server here     *)
(* publishes only after reading it); the unstored exits of the slot other  *)
(* than the superseded drop (config-failure refusal, a clear that cancels  *)
(* it), so the drop exit (the PENDING_RECEIPT_DROPPED listener, which      *)
(* carries the same answerStored guard, client.ts:4742) has no action; a   *)
(* clear after the wait resolved (the touch reads a few awaits later);     *)
(* seed-first-push strategies, whose store cancels the slot (#4785 F1), so *)
(* a receipt in the slot is always the later one; all pinned by the        *)
(* #4782/#4785 tests under tests/clients/lsp/; a parallel tool's send of   *)
(* a.ts during the phase (the #3481 read stamps, pinned by                 *)
(* tests/clients/head-move-resync-4493.test.ts).                           *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    PendingGuard, \* the fix (#4782): a pending later receipt outranks the cache
    Republish,    \* the server republishes a.ts as it reads z.ts's change
    MaxPubs,      \* bound on server publishes
    MaxClears,    \* bound on clears of a.ts's stored state while its wait is open
    Resend,       \* #4782 item 1: the phase re-sends a.ts after z.ts
    Versioned,    \* publishes carry the a.ts version the server read
    Drain,        \* the phase ends with the drain request (an ordered client)
    Mutant        \* "none" | "noSettleGuard" (the guard on the early return only)
                  \* | "noAnswerGuard" (the quiet window settles on an emptied cache)
                  \* | "dropAnswer" (the quiet window rejects the only stored answer)
                  \* | "widenAnswerGuard" (the answer guard refuses a stored answer too)
                  \* | "retainSlot" (Clear leaves the receipt in the quiet-window slot)

NONE == -1

VARIABLES
    wire,     \* client -> server messages not yet read
    srvA,     \* the server has read a.ts's change
    srvZ,     \* the z.ts version the server holds (0 old, 1 new)
    owed,     \* Republish: a.ts's re-check is owed before the next read
    pubs,     \* server -> client messages not yet handled (FIFO)
    npubs,
    rx,       \* receipts handled so far (the next receipt's seq)
    cache,    \* pushDiagnostics: [has, zv, ne, seq]
    slot,     \* pendingDiagnostics: [on, zv, ne, seq]
    drained,  \* the drain reply arrived
    w,        \* "idle" | "listen" | "armed" | "deferred" | "resolved" | "read"
    how,      \* "none" | "settled" | "timeout"
    newest,   \* ghost: at the settle, the cache held the newest receipt
    result,   \* the cache touchFile read
    clears,   \* clears landed so far
    dropped,  \* ghost: a quiet window rejected the answer stored now (no clear
              \* since)
    canceled, \* ghost: the seq of the receipt the last Clear took out of the slot
    sendQ,    \* the phase's sends not yet written
    docVer,   \* the client's version of a.ts
    srvVer    \* the a.ts version the server has read (0: none yet)

vars == <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot, drained, w,
          how, newest, result, clears, dropped, canceled, sendQ, docVer, srvVer>>

\* Without Resend every send is written at the start, as in the original
\* model; with it, the re-send (and the drain after it) are written by
\* ClientSend, so a receipt can land before or after the re-send's clear.
DrainMsg == IF Drain THEN << "drain" >> ELSE << >>

Empty == [has |-> FALSE, zv |-> NONE, ne |-> FALSE, seq |-> NONE]
Off == [on |-> FALSE, zv |-> NONE, ne |-> FALSE, seq |-> NONE]

Init ==
    /\ wire = << "a", "z" >> \o (IF Resend THEN << >> ELSE DrainMsg)
    /\ sendQ = IF Resend THEN << "a2" >> \o DrainMsg ELSE << >>
    /\ docVer = 1
    /\ srvVer = 0
    /\ srvA = FALSE
    /\ srvZ = 0
    /\ owed = FALSE
    /\ pubs = << >>
    /\ npubs = 0
    /\ rx = 0
    /\ cache = Empty
    /\ slot = Off
    /\ drained = FALSE
    /\ w = "idle"
    /\ how = "none"
    /\ newest = TRUE
    /\ result = Empty
    /\ clears = 0
    /\ dropped = FALSE
    /\ canceled = NONE

\* The guard at each site. The early return keeps it under every mutant.
StartGuarded == PendingGuard
SettleGuarded == PendingGuard /\ Mutant # "noSettleGuard"
\* The answer guard at the quiet-window settle (#4785 F4).
AnswerGuarded == Mutant # "noAnswerGuard"

-----------------------------------------------------------------------------
\* The server.

ServerRead ==
    /\ wire # << >>
    /\ ~owed
    /\ LET m == Head(wire) IN
         /\ srvA' = (srvA \/ m \in {"a", "a2"})
         /\ srvVer' = CASE m = "a" -> 1 [] m = "a2" -> 2 [] OTHER -> srvVer
         /\ srvZ' = IF m = "z" THEN 1 ELSE srvZ
         /\ owed' = (Republish /\ m = "z")
         /\ pubs' = IF m = "drain"
                      THEN Append(pubs, [k |-> "reply", zv |-> NONE, ne |-> FALSE,
                                         ver |-> NONE])
                      ELSE pubs
    /\ wire' = Tail(wire)
    /\ UNCHANGED <<npubs, rx, cache, slot, drained, w, how, newest, result,
                   clears, dropped, canceled, sendQ, docVer>>

ServerPublish ==
    /\ srvA
    /\ npubs < MaxPubs
    /\ pubs' = Append(pubs, [k |-> "pub", zv |-> srvZ, ne |-> (srvZ = 0),
                              ver |-> srvVer])
    /\ npubs' = npubs + 1
    /\ owed' = FALSE
    /\ UNCHANGED <<wire, srvA, srvZ, rx, cache, slot, drained, w, how, newest,
                   result, clears, dropped, canceled, sendQ, docVer, srvVer>>

-----------------------------------------------------------------------------
\* The publishDiagnostics handler and its quiet-window slot (client.ts).

ClientReceive ==
    /\ pubs # << >>
    /\ pubs' = Tail(pubs)
    /\ LET p == Head(pubs) IN
       IF p.k = "reply"
         THEN /\ drained' = TRUE
              /\ UNCHANGED <<rx, slot>>
         ELSE IF Versioned /\ p.ver < docVer
         \* isSupersededPush: an answer for an older version never reaches the slot.
         THEN UNCHANGED <<rx, slot, drained>>
         ELSE /\ slot' = [on |-> TRUE, zv |-> p.zv, ne |-> p.ne, seq |-> rx]
              /\ rx' = rx + 1
              /\ UNCHANGED drained
    /\ UNCHANGED <<wire, srvA, srvZ, owed, npubs, cache, w, how, newest, result,
                   clears, dropped, canceled, sendQ, docVer, srvVer>>

\* The slot's timer stores the receipt and emits; a listening, armed or
\* deferred waiter (re)arms its quiet window.
SlotFire ==
    /\ slot.on
    /\ cache' = [has |-> TRUE, zv |-> slot.zv, ne |-> slot.ne, seq |-> slot.seq]
    /\ slot' = Off
    /\ w' = IF w \in {"listen", "armed", "deferred"} THEN "armed" ELSE w
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, drained, how,
                   newest, result, clears, dropped, canceled, sendQ, docVer,
                   srvVer>>

-----------------------------------------------------------------------------
\* The phase's later sends (Resend only). The re-send of a.ts goes through
\* handleNotifyOpenOnce: in the tick it is written, a.ts's stored answer and the
\* receipt in its slot are cleared, and the client's version moves on.
ClientSend ==
    /\ sendQ # << >>
    /\ LET m == Head(sendQ) IN
         /\ wire' = Append(wire, m)
         /\ IF m = "a2"
              THEN /\ docVer' = 2
                   /\ cache' = Empty
                   /\ slot' = Off
                   /\ canceled' = IF slot.on THEN slot.seq ELSE canceled
              ELSE UNCHANGED <<docVer, cache, slot, canceled>>
    /\ sendQ' = Tail(sendQ)
    /\ UNCHANGED <<srvA, srvZ, owed, pubs, npubs, rx, drained, w, how, newest,
                   result, clears, dropped, srvVer>>

-----------------------------------------------------------------------------
\* The waiter: the skipped dispatch touch, after the drain reply.

\* A drained phase starts the wait at the drain reply; an undrained one once the
\* phase has written its last send (resyncHeldPrimaries returns).
PhaseDone == IF Drain THEN drained ELSE sendQ = << >>

WaitStart ==
    /\ w = "idle"
    /\ PhaseDone
    /\ IF cache.has /\ cache.ne /\ ~(StartGuarded /\ slot.on)
         THEN /\ w' = "resolved"
              /\ how' = "settled"
              /\ newest' = ~slot.on
         ELSE /\ w' = "listen"
              /\ UNCHANGED <<how, newest>>
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, result, clears, dropped, canceled, sendQ, docVer,
                   srvVer>>

WaitSettle ==
    /\ w = "armed"
    /\ IF SettleGuarded /\ slot.on
         THEN /\ w' = "deferred"
              /\ UNCHANGED <<how, newest>>
         ELSE IF Mutant = "dropAnswer" /\ cache.has
         \* The hand mutant: the window fires on a stored answer with no later
         \* receipt pending and gives it up; only a deadline can end the wait.
         THEN /\ w' = "listen"
              /\ UNCHANGED <<how, newest>>
         ELSE IF AnswerGuarded /\ (~cache.has \/ Mutant = "widenAnswerGuard")
         \* #4785 F4: a clear emptied the store this window was armed for;
         \* the wait keeps waiting for the next store, or its deadline.
         THEN /\ w' = "listen"
              /\ UNCHANGED <<how, newest>>
         ELSE /\ w' = "resolved"
              /\ how' = "settled"
              /\ newest' = ~slot.on
    \* Ghost, derived from the outcome and not from any branch: this window fired
    \* on a stored answer with no later receipt pending, and the wait is still
    \* open.
    /\ dropped' = (cache.has /\ ~slot.on /\ w' # "resolved")
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, result, clears, canceled, sendQ, docVer, srvVer>>

WaitTimeout ==
    /\ w \in {"listen", "armed", "deferred"}
    /\ w' = "resolved"
    /\ how' = "timeout"
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, newest, result, clears, dropped, canceled, sendQ,
                   docVer, srvVer>>

\* clearDiagnosticsForPath (client.ts:2169) while the wait is open: the stored
\* answer and the receipt in the quiet-window slot go in one tick. The wait's
\* own state is untouched; only a later store re-arms its window.
Clear ==
    /\ clears < MaxClears
    /\ w \in {"idle", "listen", "armed", "deferred"}
    /\ cache.has \/ slot.on
    /\ cache' = Empty
    /\ slot' = IF Mutant = "retainSlot" THEN slot ELSE Off
    /\ canceled' = IF slot.on THEN slot.seq ELSE canceled
    /\ clears' = clears + 1
    /\ dropped' = FALSE \* the rejected answer is gone
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, drained, w, how,
                   newest, result, sendQ, docVer, srvVer>>

Read ==
    /\ w = "resolved"
    /\ w' = "read"
    /\ result' = cache
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, how, newest, clears, dropped, canceled, sendQ, docVer,
                   srvVer>>

Next == ServerRead \/ ServerPublish \/ ClientReceive \/ SlotFire \/ ClientSend
        \/ WaitStart \/ WaitSettle \/ WaitTimeout \/ Clear \/ Read

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* The rule: a wait settles only on the newest receipt it holds; no later
\* receipt sits in the quiet-window slot at that moment.
NewestAtSettle == how = "settled" => newest

\* #4785 F4: a wait resolves early only while an answer for the path is stored.
\* The touch reads "no answer" only from a wait that ran to its budget, so a
\* settle on an emptied cache reads as a confirmed clean. In this model `Clear`
\* fires only while the wait is open, so a settled wait's cache never empties
\* afterwards. The code has no such restriction (see the README).
SettleNeedsAnswer == how = "settled" => cache.has

\* The no-drop side of the same guard: a quiet window that fires on a stored
\* answer with no later receipt pending must not leave the wait to run out its
\* budget. `SettleNeedsAnswer` cannot see that: a window that rejects the only
\* answer never settles. `dropped` clears with the answer (`Clear`).
NoDroppedAnswer == how = "timeout" => ~dropped

\* #4785 F1: a clear cancels the receipt in the slot, so it must never be stored
\* afterwards. Every receipt has a unique `seq` (its receive order), and
\* `canceled` names the one the last clear took. Without the cancel the slot's
\* timer stores the canceled answer, which an old STOP can be.
NoCanceledStored == cache.has => cache.seq # canceled

\* Its consequence for the bash write: a settled read of a.ts was computed
\* against z.ts's new bytes (#4782's phantom STOP is a read with zv = 0).
NoPhantomFinding == (w = "read" /\ how = "settled" /\ result.has) => result.zv = 1
=============================================================================
