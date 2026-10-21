--------------------------- MODULE HeadMoveResync ---------------------------
(***************************************************************************)
(* The HEAD-move resync of held documents (#4493). Records:               *)
(* clients/opaque-mutation-scan.ts headRecords (headRecordKey,            *)
(* observeGitHead). Looks: handleToolCall in clients/runtime-tool-call.ts *)
(* and the bash branch of handleToolResult in                             *)
(* clients/runtime-tool-result.ts, both through resyncHeadMove. Resync:   *)
(* resyncGitChangedFiles in clients/lsp/index.ts (forced drift passes,    *)
(* each capped).                                                           *)
(*                                                                         *)
(* Two sessions share one LSP server (one LSPService per process) and one *)
(* RuntimeCoordinator, so they share the baseline slot; each runs bash     *)
(* calls in parallel. A call's command may move HEAD: a checkout rewrites  *)
(* the held documents on disk, a commit moves HEAD and leaves the bytes.  *)
(* An outside move (a terminal, an IDE) does the same with no tool event. *)
(*                                                                         *)
(* A look (a tool_call or a bash tool_result hook) is three steps, each   *)
(* await a step boundary: Read takes HEAD (git rev-parse, awaited); Cas    *)
(* compares and sets the session's record synchronously; Resync, only     *)
(* when Cas reported a move, resends the stale held documents (up to Cap  *)
(* of them) and writes the one row. A look that saw no move returns at    *)
(* Cas.                                                                    *)
(*                                                                         *)
(* Looks of one key run one at a time (Serial): resyncHeadMove runs under *)
(* a coalescing single-flight per key, so a look that arrives mid-flight  *)
(* waits and gets one fresh trailing pass. Without it, two looks of one   *)
(* session can read HEAD on either side of a move and set the record in   *)
(* the other order, regressing it: the next look then reports the same    *)
(* move again (the HeadMoveMutNoSerial trace).                             *)
(*                                                                         *)
(* Knobs: Track FALSE is the code before #4493 (recovery reads only the   *)
(* dirty set, so a clean-tree move is never looked at). Keying "slot"     *)
(* keys one record for both sessions; "session" adds the session id.      *)
(* Compare FALSE makes every look report the previous HEAD. CurrentOnly   *)
(* resends only a document whose sent bytes differ from the disk.         *)
(* ReportDeferred writes the drain cap's remainder into the row. InitRec  *)
(* TRUE starts each record at the initial HEAD (the session looked before *)
(* any move); FALSE leaves it unset, the session-start warm-up gap.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Track,          \* TRUE: the fix looks at HEAD; FALSE: before #4493
    Keying,         \* "session" (the fix) | "slot" (one record per slot)
    Compare,        \* TRUE: Cas reports only a different HEAD
    CurrentOnly,    \* TRUE: resend only documents whose sent bytes differ
    ReportDeferred, \* TRUE: the row states what the drain cap left
    InitRec,        \* TRUE: each record starts at the initial HEAD
    Serial,         \* TRUE: one look per key at a time (the single-flight)
    Cap,            \* documents one resync sends (model scale of 64)
    MaxMoves,       \* HEAD moves explored
    Outside         \* TRUE: a move may also happen outside pi

Sessions == {"s1", "s2"}
Docs == {"d1", "d2"}
CallIds == Sessions \X {1, 2}
\* No HEAD observed yet: a number no move produces, so it compares with one.
None == MaxMoves + 1
Keys == IF Keying = "session" THEN Sessions ELSE {"slot"}
KeyOf(s) == IF Keying = "session" THEN s ELSE "slot"

Phases == {"idle", "tcRead", "tcCas", "tcResync", "running",
           "trRead", "trCas", "trResync", "done"}

VARIABLES
    head,      \* the commit HEAD names (a fresh number per move)
    disk,      \* per document: the version of its bytes on disk
    server,    \* per document: the version the server holds
    rec,       \* per key: the HEAD its session last observed, or None
    writers,   \* per key: the sessions whose looks wrote it
    pc,        \* per call: its phase
    seen,      \* per call: the HEAD its look read
    from,      \* per call: the previous HEAD its Cas reported
    rows,      \* the head_moved rows written
    moves,     \* moves made so far
    looked,    \* TRUE once a hook ran after the latest move (a look read)
    redundant  \* TRUE once a resync resent bytes the server already held

vars == <<head, disk, server, rec, writers, pc, seen, from, rows, moves,
          looked, redundant>>

TypeOK ==
    /\ head \in 0..MaxMoves
    /\ disk \in [Docs -> 0..MaxMoves]
    /\ server \in [Docs -> 0..MaxMoves]
    /\ rec \in [Keys -> 0..None]
    /\ writers \in [Keys -> SUBSET Sessions]
    /\ pc \in [CallIds -> Phases]
    /\ moves \in 0..MaxMoves

Init ==
    /\ head = 0
    /\ disk = [d \in Docs |-> 0]
    /\ server = [d \in Docs |-> 0]
    /\ rec = [k \in Keys |-> IF InitRec THEN 0 ELSE None]
    /\ writers = [k \in Keys |-> {}]
    /\ pc = [c \in CallIds |-> "idle"]
    /\ seen = [c \in CallIds |-> 0]
    /\ from = [c \in CallIds |-> None]
    /\ rows = <<>>
    /\ moves = 0
    /\ looked = TRUE
    /\ redundant = FALSE

(* A move: a checkout rewrites every held document, a commit none. *)
Move(rewrite) ==
    /\ moves < MaxMoves
    /\ moves' = moves + 1
    /\ head' = moves + 1
    /\ disk' = IF rewrite THEN [d \in Docs |-> moves + 1] ELSE disk
    /\ looked' = FALSE

(* Without Track the hook runs and looks at nothing, so it counts as run. *)
ToolCall(c) ==
    /\ pc[c] = "idle"
    /\ pc' = [pc EXCEPT ![c] = IF Track THEN "tcRead" ELSE "running"]
    /\ looked' = (looked \/ ~Track)
    /\ UNCHANGED <<head, disk, server, rec, writers, seen, from, rows, moves,
                   redundant>>

(* The command runs; it may move HEAD. *)
(* The command runs; it may move HEAD. Without Track its tool_result hook  *)
(* runs in the same step, after the move, and looks at nothing.            *)
Run(c) ==
    /\ pc[c] = "running"
    /\ pc' = [pc EXCEPT ![c] = IF Track THEN "trRead" ELSE "done"]
    /\ \E kind \in {"checkout", "commit", "none"} :
        /\ IF kind = "none"
           THEN UNCHANGED <<head, disk, moves>>
           ELSE /\ moves < MaxMoves
                /\ moves' = moves + 1
                /\ head' = moves + 1
                /\ disk' = IF kind = "checkout"
                           THEN [d \in Docs |-> moves + 1] ELSE disk
        /\ looked' = IF ~Track THEN TRUE
                     ELSE IF kind = "none" THEN looked ELSE FALSE
    /\ UNCHANGED <<server, rec, writers, seen, from, rows, redundant>>

OutsideMove ==
    /\ Outside
    /\ \E rewrite \in BOOLEAN : Move(rewrite)
    /\ UNCHANGED <<server, rec, writers, pc, seen, from, rows, redundant>>

InLook == {"tcCas", "tcResync", "trCas", "trResync"}

Read(c, at, next) ==
    /\ pc[c] = at
    /\ Serial =>
        \A o \in CallIds : (o # c /\ KeyOf(o[1]) = KeyOf(c[1])) =>
            pc[o] \notin InLook
    /\ seen' = [seen EXCEPT ![c] = head]
    /\ looked' = TRUE
    /\ pc' = [pc EXCEPT ![c] = next]
    /\ UNCHANGED <<head, disk, server, rec, writers, from, rows, moves,
                   redundant>>

(* observeGitHead: synchronous compare-and-set on the session's record. *)
Cas(c, at, resync, after) ==
    LET k == KeyOf(c[1])
        prev == rec[k]
        moved == prev # None /\ (~Compare \/ prev # seen[c])
    IN /\ pc[c] = at
       /\ rec' = [rec EXCEPT ![k] = seen[c]]
       /\ writers' = [writers EXCEPT ![k] = @ \cup {c[1]}]
       /\ from' = [from EXCEPT ![c] = IF moved THEN prev ELSE None]
       /\ pc' = [pc EXCEPT ![c] = IF moved THEN resync ELSE after]
       /\ UNCHANGED <<head, disk, server, seen, rows, moves, looked,
                      redundant>>

(* The delta's held documents, cut to the stale ones with CurrentOnly;    *)
(* the forced passes send Cap of them, reading the disk as it is now.     *)
Resync(c, at, after) ==
    LET delta == IF from[c] = seen[c] THEN {} ELSE Docs
        targets == IF CurrentOnly
                   THEN {d \in delta : server[d] # disk[d]}
                   ELSE delta
        sent == CHOOSE S \in SUBSET targets :
                    Cardinality(S) = IF Cardinality(targets) < Cap
                                     THEN Cardinality(targets) ELSE Cap
        left == Cardinality(targets) - Cardinality(sent)
    IN /\ pc[c] = at
       /\ server' = [d \in Docs |-> IF d \in sent THEN disk[d] ELSE server[d]]
       /\ redundant' = (redundant \/ \E d \in sent : server[d] = disk[d])
       /\ rows' = Append(rows, [s |-> c[1], from |-> from[c], to |-> seen[c],
                                deferred |-> IF ReportDeferred THEN left
                                             ELSE 0])
       /\ pc' = [pc EXCEPT ![c] = after]
       /\ UNCHANGED <<head, disk, rec, writers, seen, from, moves, looked>>

Next ==
    \/ \E c \in CallIds :
        \/ ToolCall(c)
        \/ Read(c, "tcRead", "tcCas")
        \/ Cas(c, "tcCas", "tcResync", "running")
        \/ Resync(c, "tcResync", "running")
        \/ Run(c)
        \/ Read(c, "trRead", "trCas")
        \/ Cas(c, "trCas", "trResync", "done")
        \/ Resync(c, "trResync", "done")
    \/ OutsideMove

Spec == Init /\ [][Next]_vars

(* No look is between its Read and its return. *)
Quiet == \A c \in CallIds : pc[c] \in {"idle", "running", "done"}

(* A held document never stays stale once every look that started after  *)
(* the latest move has returned, unless that move's row says how many    *)
(* documents the drain cap deferred.                                       *)
HeldFreshWhenQuiet ==
    (Quiet /\ looked) =>
        \/ \A d \in Docs : server[d] = disk[d]
        \/ \E i \in 1..Len(rows) : rows[i].to = head /\ rows[i].deferred > 0

(* One row per move a session observed: never a HEAD to itself, and never *)
(* two rows of one session for the same transition.                        *)
OneRowPerEvent ==
    /\ \A i \in 1..Len(rows) : rows[i].from # rows[i].to
    /\ \A i, j \in 1..Len(rows) :
        (i # j /\ rows[i].s = rows[j].s) =>
            <<rows[i].from, rows[i].to>> # <<rows[j].from, rows[j].to>>

(* One session's look never writes the record another session reads. *)
SessionIsolation == \A k \in Keys : Cardinality(writers[k]) <= 1

(* A resync never resends bytes the server already holds. *)
NoRedundantSend == ~redundant
=============================================================================
