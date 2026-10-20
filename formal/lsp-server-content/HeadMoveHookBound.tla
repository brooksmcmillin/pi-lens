-------------------------- MODULE HeadMoveHookBound --------------------------
(***************************************************************************)
(* The hook bound around a HEAD-move resync (#4493 review r1 F1). Where    *)
(* HeadMoveResync checks freshness only once every look has returned, this *)
(* module lets a hook return at its bound while the look runs on, and asks *)
(* what the next tool sees.                                                *)
(*                                                                         *)
(* One session runs two tool calls of one message in parallel, as pi does: *)
(* a bash call B whose command moves HEAD (a checkout rewriting both held  *)
(* documents) and a call E that reads the primary server's view (a read or *)
(* an edit, whose dispatch reads it). Each document is held by a primary   *)
(* server (view P) and an auxiliary scanner (view X).                      *)
(*                                                                         *)
(* A look (lookAtHead in clients/runtime-tool-result.ts, run under         *)
(* serializeHeadLook) reads HEAD and compares it with the record in one   *)
(* step (the read is a file read with no await before the compare). On a   *)
(* move it owes sends: `lookQ` is what the hooks waiting on the look wait  *)
(* for, `tailQ` runs after the look, detached. PrimaryFirst TRUE (the fix, *)
(* resyncHeldPrimaries then resyncGitChangedFiles): lookQ is the primary   *)
(* sends, tailQ the auxiliary sends. FALSE (round 1): lookQ is every send, *)
(* per document, primary then auxiliary (the drift resync's clientScope    *)
(* "all").                                                                 *)
(*                                                                         *)
(* The bound. An auxiliary send can stall (the #1714 pacing barrier waits  *)
(* for a busy scanner, up to 2 s); a primary send cannot (primaries are    *)
(* not paced). A hook waiting on a look may return at its bound only while *)
(* the look's next send is an auxiliary one. Model assumption: the primary *)
(* sends of one look fit in the bound. On a bash tool_result the bound is  *)
(* the 10 s edit budget: the 500 ms read-only bound did not hold (#4528 r4,*)
(* a slow primary with 24 live clients took 1163 ms). On a tool_call the   *)
(* bound stays 500 ms; a primary phase past either bound is disclosed by   *)
(* the hook-await-exceeded row and the head_moved counts, not modelled.    *)
(*                                                                         *)
(* Join TRUE (the fix): every tool_call looks, so E joins a look in flight *)
(* and, once it ends, reads HEAD again (the trailing look). FALSE (round   *)
(* 1): E's tool_call skips the look when B's tool_call already looked in   *)
(* this turn (headObservedInTurn).                                         *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    PrimaryFirst,   \* TRUE: the look sends to primaries; auxiliaries after it
    Join            \* TRUE: every tool_call looks and joins a look in flight

Docs == <<"d1", "d2">>
DocSet == {"d1", "d2"}

VARIABLES
    head,       \* 0 before the move, 1 after
    disk,       \* per document: the version on disk
    P,          \* per document: the version the primary holds
    X,          \* per document: the version the auxiliary holds
    rec,        \* the HEAD the session last observed
    lookQ,      \* sends the running look owes before its waiters return
    tailQ,      \* sends owed after the look, detached
    pcB,        \* the bash call's phase
    pcE,        \* the other call's phase
    bLooked,    \* B's tool_call has looked (the turn is marked)
    eAfterMove, \* E's tool_call started after the move ran
    staleEdit   \* E ran against a stale primary although it began after the move

vars == <<head, disk, P, X, rec, lookQ, tailQ, pcB, pcE, bLooked, eAfterMove,
          staleEdit>>

Sends(server) == [i \in 1..2 |-> <<server, Docs[i]>>]
Interleaved == <<<<"P", "d1">>, <<"X", "d1">>, <<"P", "d2">>, <<"X", "d2">>>>

Init ==
    /\ head = 0
    /\ disk = [d \in DocSet |-> 0]
    /\ P = [d \in DocSet |-> 0]
    /\ X = [d \in DocSet |-> 0]
    /\ rec = 0
    /\ lookQ = <<>>
    /\ tailQ = <<>>
    /\ pcB = "tc"
    /\ pcE = "tc"
    /\ bLooked = FALSE
    /\ eAfterMove = FALSE
    /\ staleEdit = FALSE

Busy == lookQ # <<>>

(* Read HEAD and compare in one step; a move fills the queues. *)
ReadAndCompare ==
    IF head # rec
    THEN /\ rec' = head
         /\ lookQ' = IF PrimaryFirst THEN Sends("P") ELSE Interleaved
         /\ tailQ' = IF PrimaryFirst THEN tailQ \o Sends("X") ELSE tailQ
    ELSE UNCHANGED <<rec, lookQ, tailQ>>

(* A hook's look: start one when none runs, else wait on the running one. *)
(* `next` is where the hook goes once the look needs nothing more.          *)
LookStep(pc, at, wait, next) ==
    /\ pc = at
    /\ IF Busy
       THEN /\ pc' = wait
            /\ UNCHANGED <<rec, lookQ, tailQ>>
       ELSE /\ ReadAndCompare
            /\ pc' = IF head # rec THEN wait ELSE next

(* The look ended: the waiter reads HEAD again (the trailing look). *)
Release(pc, wait, at) ==
    /\ pc = wait
    /\ ~Busy
    /\ pc' = at

(* The bound: only while the look is stalled at an auxiliary send. *)
Bound(pc, wait, next) ==
    /\ pc = wait
    /\ Busy
    /\ Head(lookQ)[1] = "X"
    /\ pc' = next

BTc ==
    \/ /\ LookStep(pcB, "tc", "tcWait", "run")
       /\ bLooked' = TRUE
       /\ UNCHANGED <<head, disk, P, X, pcE, eAfterMove, staleEdit>>
    \/ /\ \/ Release(pcB, "tcWait", "tc")
          \/ Bound(pcB, "tcWait", "run")
       /\ UNCHANGED <<head, disk, P, X, rec, lookQ, tailQ, pcE, bLooked,
                      eAfterMove, staleEdit>>

(* The command checks out the other branch. *)
BRun ==
    /\ pcB = "run"
    /\ head' = 1
    /\ disk' = [d \in DocSet |-> 1]
    /\ pcB' = "tr"
    /\ UNCHANGED <<P, X, rec, lookQ, tailQ, pcE, bLooked, eAfterMove,
                   staleEdit>>

BTr ==
    /\ \/ LookStep(pcB, "tr", "trWait", "done")
       \/ /\ \/ Release(pcB, "trWait", "tr")
             \/ Bound(pcB, "trWait", "done")
          /\ UNCHANGED <<rec, lookQ, tailQ>>
    /\ UNCHANGED <<head, disk, P, X, pcE, bLooked, eAfterMove, staleEdit>>

ETc ==
    \/ /\ pcE = "tc"
       /\ eAfterMove' = (head = 1)
       /\ IF ~Join /\ bLooked
          THEN /\ pcE' = "run"
               /\ UNCHANGED <<rec, lookQ, tailQ>>
          ELSE LookStep(pcE, "tc", "tcWait", "run")
       /\ UNCHANGED <<head, disk, P, X, pcB, bLooked, staleEdit>>
    \/ /\ \/ Release(pcE, "tcWait", "tcAgain")
          \/ Bound(pcE, "tcWait", "run")
       /\ UNCHANGED <<head, disk, P, X, rec, lookQ, tailQ, pcB, bLooked,
                      eAfterMove, staleEdit>>
    \/ /\ LookStep(pcE, "tcAgain", "tcWait", "run")
       /\ UNCHANGED <<head, disk, P, X, pcB, bLooked, eAfterMove, staleEdit>>

(* The tool reads the primary's view. *)
ERun ==
    /\ pcE = "run"
    /\ staleEdit' = (staleEdit \/ (eAfterMove /\ \E d \in DocSet : P[d] # disk[d]))
    /\ pcE' = "done"
    /\ UNCHANGED <<head, disk, P, X, rec, lookQ, tailQ, pcB, bLooked,
                   eAfterMove>>

Apply(send) ==
    /\ P' = IF send[1] = "P" THEN [P EXCEPT ![send[2]] = disk[send[2]]] ELSE P
    /\ X' = IF send[1] = "X" THEN [X EXCEPT ![send[2]] = disk[send[2]]] ELSE X

SendLook ==
    /\ Busy
    /\ Apply(Head(lookQ))
    /\ lookQ' = Tail(lookQ)
    /\ UNCHANGED <<head, disk, rec, tailQ, pcB, pcE, bLooked, eAfterMove,
                   staleEdit>>

SendTail ==
    /\ ~Busy
    /\ tailQ # <<>>
    /\ Apply(Head(tailQ))
    /\ tailQ' = Tail(tailQ)
    /\ UNCHANGED <<head, disk, rec, lookQ, pcB, pcE, bLooked, eAfterMove,
                   staleEdit>>

Next == BTc \/ BRun \/ BTr \/ ETc \/ ERun \/ SendLook \/ SendTail

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ head \in 0..1
    /\ rec \in 0..1
    /\ pcB \in {"tc", "tcWait", "run", "tr", "trWait", "done"}
    /\ pcE \in {"tc", "tcWait", "tcAgain", "run", "done"}

(* A tool call that began after the move never reads a stale primary. *)
EditSeesFreshPrimary == ~staleEdit

(* Once every send has run, both servers hold the disk bytes. *)
SettledFresh ==
    (lookQ = <<>> /\ tailQ = <<>> /\ pcB = "done" /\ rec = head) =>
        \A d \in DocSet : P[d] = disk[d] /\ X[d] = disk[d]
=============================================================================
