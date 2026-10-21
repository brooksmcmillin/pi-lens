--------------------------- MODULE BashWriteOrder ---------------------------
(***************************************************************************)
(* The order in which one bash command's writes reach the primary server   *)
(* (#4507). The command rewrites two held documents: a dependency z and a  *)
(* dependent a whose new bytes import a name the command adds to z. Its    *)
(* tool_result then dispatches each written file, one at a time, in the    *)
(* order git status or the command recognizer lists them (either order).  *)
(* A dispatch sends its file's disk bytes to the primary and reads the     *)
(* primary's check of that file, which reads the primary's view of every   *)
(* held document (a dependent is checked against the dependency the        *)
(* server holds).                                                          *)
(*                                                                         *)
(* WritesPrimaryFirst TRUE (sendToHeldPrimaries in                         *)
(* clients/runtime-tool-result.ts): before the dispatch loop, the written  *)
(* held documents go to the primary, one at a time, in the same order.     *)
(* FALSE (before #4507): a file reached the primary only in its own        *)
(* dispatch, and an opaque command's paths were resent detached after the  *)
(* loop.                                                                   *)
(*                                                                         *)
(* DispatchWaitsPhase (#4528 r1 F1): TRUE, the loop waits for the phase    *)
(* itself, bounded by the edit budget. FALSE (#4528 r1), a 500 ms bound    *)
(* could end the wait (PhaseCut) while the phase was still sending, and    *)
(* the loop started with the rest of the phase running beside it.          *)
(*                                                                         *)
(* A primary may wedge (stop reading its input) at any time. Its views     *)
(* then stop changing and it answers no check, so a dispatch on it reads   *)
(* no verdict. Under DispatchWaitsPhase the edit-budget bound ends the     *)
(* wait only for a wedged primary (EditCut): the model assumption is that  *)
(* a live primary takes the capped sends inside the edit budget.           *)
(*                                                                         *)
(* A send here is one the primary has READ. A write resolves once its      *)
(* bytes are in the pipe; resyncHeldPrimaries' drain barrier (one request  *)
(* answered per client after its sends) proves read only with measured     *)
(* single-task ordering. Threaded/unmeasured replies may overtake the reads; *)
(* RequireOrderedDrain makes those phases undrained. Dispatch still runs:   *)
(* the threaded configs assert DrainProven, not NoPhantomFinding.           *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    WritesPrimaryFirst,  \* TRUE: written held documents reach the primary first
    RequireOrderedDrain, ReplyOrdering,
    DispatchWaitsPhase   \* TRUE: the loop waits for the phase (no 500 ms cut)

Docs == {"a", "z"}

VARIABLES
    disk,     \* per document: the version on disk
    P,        \* per document: the version the primary holds
    order,    \* the written order: the phase's and the dispatches', chosen at run
    pc,       \* "run", "primary", "dispatch", "done"
    i,        \* the next dispatch
    j,        \* the phase's next send (Len(order) + 1 once it has sent all)
    wedged,   \* the primary stopped reading its input
    drained,  \* the phase claimed its queued sends were read
    phantom   \* a check read a held document's old bytes

vars == <<disk, P, order, pc, i, j, wedged, drained, phantom>>

Init ==
    /\ disk = [d \in Docs |-> 0]
    /\ P = [d \in Docs |-> 0]
    /\ order = <<>>
    /\ pc = "run"
    /\ i = 1
    /\ j = 1
    /\ wedged = FALSE
    /\ drained = FALSE
    /\ phantom = FALSE

PhaseRunning == WritesPrimaryFirst /\ pc # "run" /\ j <= Len(order)

(* The command rewrites both files; the result lists them in either order. *)
Run ==
    /\ pc = "run"
    /\ disk' = [d \in Docs |-> 1]
    /\ \E o \in {<<"a", "z">>, <<"z", "a">>} : order' = o
    /\ pc' = IF WritesPrimaryFirst THEN "primary" ELSE "dispatch"
    /\ UNCHANGED <<P, i, j, wedged, drained, phantom>>

(* One phase send. It keeps running after a cut, beside the dispatches. *)
PrimarySend ==
    /\ PhaseRunning
    /\ P' = IF wedged THEN P ELSE [P EXCEPT ![order[j]] = disk[order[j]]]
    /\ j' = j + 1
    /\ UNCHANGED <<disk, order, pc, i, wedged, drained, phantom>>

(* A threaded/unmeasured reply can arrive before the queued reads finish. *)
PrimaryDone ==
    /\ pc = "primary"
    /\ (j > Len(order) \/ ReplyOrdering # "single-task-ordered")
    /\ drained' = (~RequireOrderedDrain \/ ReplyOrdering = "single-task-ordered")
    /\ pc' = "dispatch"
    /\ UNCHANGED <<disk, P, order, i, j, wedged, phantom>>

(* #4528 r1: the 500 ms bound ends the wait while the phase still sends. *)
PhaseCut ==
    /\ ~DispatchWaitsPhase
    /\ pc = "primary"
    /\ j <= Len(order)
    /\ pc' = "dispatch"
    /\ UNCHANGED <<disk, P, order, i, j, wedged, drained, phantom>>

(* The edit-budget bound ends the wait, which only a wedged primary outlasts. *)
EditCut ==
    /\ DispatchWaitsPhase
    /\ pc = "primary"
    /\ wedged
    /\ pc' = "dispatch"
    /\ UNCHANGED <<disk, P, order, i, j, wedged, drained, phantom>>

Wedge ==
    /\ ~wedged
    /\ pc # "done"
    /\ wedged' = TRUE
    /\ UNCHANGED <<disk, P, order, pc, i, j, drained, phantom>>

(* One dispatch: send the file, then read the check, which reads every view. *)
(* A wedged primary takes no send and answers no check.                     *)
Dispatch ==
    /\ pc = "dispatch"
    /\ LET f == order[i]
           sent == IF wedged THEN P ELSE [P EXCEPT ![f] = disk[f]]
       IN /\ P' = sent
          /\ phantom' = (phantom \/ (~wedged /\ \E d \in Docs : sent[d] # disk[d]))
    /\ i' = i + 1
    /\ pc' = IF i = Len(order) THEN "done" ELSE "dispatch"
    /\ UNCHANGED <<disk, order, j, wedged, drained>>

Next ==
    Run \/ PrimarySend \/ PrimaryDone \/ PhaseCut \/ EditCut \/ Wedge \/ Dispatch

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ pc \in {"run", "primary", "dispatch", "done"}
    /\ i \in 1..3
    /\ j \in 1..3
    /\ wedged \in BOOLEAN

(* No dispatch checks a file against a held document's old bytes. *)
DrainProven == drained => (j > Len(order))

NoPhantomFinding == ~phantom

(* Once the result is done, a live primary holds the disk bytes. *)
SettledFresh == (pc = "done" /\ ~wedged) => \A d \in Docs : P[d] = disk[d]
=============================================================================
