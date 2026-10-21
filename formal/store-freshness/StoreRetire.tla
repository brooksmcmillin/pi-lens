---------------------------- MODULE StoreRetire -----------------------------
(***************************************************************************)
(* What the widget store keeps once the freshness gate has demoted a       *)
(* result (#4625). StoreFreshness decides whether the cached result about  *)
(* X may be served; this module adds the RECORD the store holds about it,  *)
(* the two sweeps that run the gate over that record, and the reader that  *)
(* consults the record afterwards.                                         *)
(*                                                                         *)
(* The record is "live" (a final snapshot), "unfinished" (kept without a   *)
(* final snapshot: a changed file's surviving findings, or a record with   *)
(* no findings at all) or "gone" (no record). The                          *)
(* reader, lens_diagnostics' session read, reports only what the record    *)
(* says: "served" for a live record and "inconclusive" for an unfinished   *)
(* one. A record that is gone has nothing to flag, so the file reads       *)
(* "clean": a directory scope, or a sibling's final snapshot, still prints *)
(* the check mark. The unverified rule covers only a file the request      *)
(* names.                                                                  *)
(*                                                                         *)
(* Two actors run the gate over a record:                                  *)
(*  - the tool's sweep, inside a read: an observer hands that one call the *)
(*    files the sweep just invalidated;                                    *)
(*  - the footer's sweep (scheduleStaleReconcile): the same gate with no   *)
(*    observer, at any time between reads.                                 *)
(*                                                                         *)
(* Retire is what a stale verdict leaves behind:                           *)
(*  "drop"     the record is deleted and nobody is told (the code before   *)
(*             #4625);                                                     *)
(*  "dropOnce" the record is deleted and the sweeping call is told, once   *)
(*             (#4625 at 586dd00fd);                                       *)
(*  "retain"   the record is kept as unfinished evidence: the final flag   *)
(*             is cleared and only the findings still current stay.        *)
(*                                                                         *)
(* A fresh snapshot (commitDiagnostics) ends an unfinished record, and the *)
(* store's idle eviction ends one that holds no errors or warnings (#4625  *)
(* round 3). A run has one computation, so neither is modelled here        *)
(* (README: Scope and limits).                                             *)
(***************************************************************************)
EXTENDS StoreFreshness

CONSTANT Retire     \* "drop" | "dropOnce" | "retain"

VARIABLES
    rec,            \* the record about X: "live" | "unfinished" | "gone"
    reports         \* what each tool read said, and whether the gate had
                    \* already demoted the result by then

retireVars == <<rec, reports>>

-----------------------------------------------------------------------------
\* The verdict GateCheck gives if it runs now.
Stale == (Latch /\ demotedBefore) \/ IsStale

\* What a stale verdict leaves of the record.
Kept == IF Retire = "retain" THEN "unfinished" ELSE "gone"

\* The record once a sweep has judged it.
After == IF Stale THEN Kept ELSE rec

\* What a reader can say about a record.
Says(r) == IF r = "live" THEN "served"
           ELSE IF r = "unfinished" THEN "inconclusive"
           ELSE "clean"

RetireInit == Init /\ rec = "live" /\ reports = {}

-----------------------------------------------------------------------------
\* A sweep judges a record that exists; a deleted one is not judged again.
\* The tool's sweep also answers its caller: from the record it leaves, or,
\* when it deleted the record, from the observer (once, for this call).
ToolSweep ==
    /\ rec /= "gone"
    /\ GateCheck
    /\ rec' = After
    /\ reports' = reports \cup
         {[after   |-> demotedBefore \/ Stale,
           verdict |-> IF Stale /\ Retire = "dropOnce"
                         THEN "inconclusive" ELSE Says(After)]}

\* The footer's debounced sweep: the same gate, no observer, no answer.
FooterSweep ==
    /\ rec /= "gone"
    /\ GateCheck
    /\ rec' = After
    /\ UNCHANGED reports

\* A read of a deleted record: nothing to sweep and no observer to hear, so
\* the only answer is the absence.
ToolReadGone ==
    /\ rec = "gone" /\ servesLeft > 0
    /\ servesLeft' = servesLeft - 1
    /\ reports' = reports \cup {[after |-> demotedBefore, verdict |-> "clean"]}
    /\ UNCHANGED <<now, disk, size, mtime, mtimeId, recMtimeId, recHash, writesLeft,
                   lastWriteAt, comp, startAt, ref, readVer, readSize, recMtime,
                   recSize, postReadWrite, demotedBefore, served, demoted, rec>>

Computation == Tick \/ Write \/ Start \/ ReadEarly \/ Read \/ Record

RetireNext ==
    \/ Computation /\ UNCHANGED retireVars
    \/ ToolSweep
    \/ FooterSweep
    \/ ToolReadGone

RetireSpec == RetireInit /\ [][RetireNext]_<<vars, rec, reports>>

-----------------------------------------------------------------------------
(* Once the gate has demoted the result, no read says "clean": the         *)
(* invalidated evidence is never turned into a check mark, whichever       *)
(* sweep ran first and however many reads follow.                          *)
NoCleanAfterDemotion == \A r \in reports : r.after => r.verdict /= "clean"
=============================================================================
