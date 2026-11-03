-------------------------- MODULE TurnStateOwner --------------------------
EXTENDS Naturals, TLC
\* #4751: who owns the turn-state worklist (`turn-state.json`) inside ONE
\* process. Two classifiers read one record. The writer
\* (`CacheManager.addModifiedRange` through `resolveTurnStatePartition`) takes
\* the role from the PERSISTED envelope owner: the owner's own id, or no owner
\* and no reserved partition, is the primary; any other session is a
\* secondary (a pi owner of this process with another id). The reader
\* (`handleTurnEnd`) takes the LIVE role: the primary reads the envelope, a
\* secondary its own partition. A departing primary keeps the envelope, its
\* owner field included, for successor replay.
\*
\* PrimaryClaims: does a primary's turn_start take the envelope from an
\* in-process predecessor (TRUE, as-built since #4751)? FALSE is the pre-fix
\* tree: after pi's newSession the successor's write went to a partition its
\* own turn end never reads.
\* ClaimEmpty: does the claim also take an envelope with no owner and no files
\* (TRUE, as-built)? FALSE leaves the window in which a subagent that leaves
\* before any turn stamps the ownerless envelope as its own.
\* SecondaryClaims: does a secondary's turn_start claim too? FALSE is as-built
\* (the `ownedSessionRole === "primary"` guard in `index.ts` turn_start).
\* WithSubagent bounds the explored population: FALSE drops the subagent, so a
\* config's violation can only come from the newSession path.
\*
\* Assumption: pi delivers a session's turn_end before any session
\* replacement, so LeavePrimary ends the primary's turn and no turn_end of a
\* departed primary follows its successor's claim. That ordering is outside
\* the model: `clearTurnState`'s same-pid fall-through would clear the
\* claimed envelope. Review r1 of #4753 found it unreachable through real pi
\* (README, "TurnStateOwner").
CONSTANTS PrimaryClaims, ClaimEmpty, SecondaryClaims, WithSubagent

VARIABLES life, role, inTurn, turns, owner, env, reserved, part, stranded,
          wiped
vars == <<life, role, inTurn, turns, owner, env, reserved, part, stranded,
          wiped>>

\* P1 is the first primary, P2 its in-process successor (newSession, fork,
\* clone, a resume of another session), S an in-process subagent.
Sess == {"P1", "P2", "S"}
None == "none"
MaxTurns == 2

LivePrimary == {x \in Sess : life[x] = "live" /\ role[x] = "primary"}

Init ==
    /\ life = [x \in Sess |-> "unstarted"]
    /\ role = [x \in Sess |-> "-"]
    /\ inTurn = [x \in Sess |-> FALSE]
    /\ turns = [x \in Sess |-> 0]
    /\ owner = None
    /\ env = {}
    /\ reserved = {}
    /\ part = [x \in Sess |-> {}]
    /\ stranded = FALSE
    /\ wiped = FALSE

\* The writer's classifier (`resolveTurnStatePartition`).
ResolvesPrimary(x) ==
    \/ owner = x
    \/ owner = None /\ x \notin reserved

\* A primary session starts: P1 first, P2 only after P1 left.
StartPrimary(x) ==
    /\ x \in {"P1", "P2"}
    /\ life[x] = "unstarted"
    /\ LivePrimary = {}
    /\ x = "P2" => life["P1"] = "gone"
    /\ life' = [life EXCEPT ![x] = "live"]
    /\ role' = [role EXCEPT ![x] = "primary"]
    /\ UNCHANGED <<inTurn, turns, owner, env, reserved, part, stranded, wiped>>

\* The primary leaves, mid-turn or not. It holds the registration, so its
\* shutdown clears nothing: the envelope, owner and files, stays for its
\* successor (`index.ts` session_shutdown, #3676/#4704).
LeavePrimary(x) ==
    /\ x \in LivePrimary
    /\ life' = [life EXCEPT ![x] = "gone"]
    /\ inTurn' = [inTurn EXCEPT ![x] = FALSE]
    /\ UNCHANGED <<role, turns, owner, env, reserved, part, stranded, wiped>>

\* An in-process subagent starts beside the live primary: a concurrent
\* secondary, its own activation (#4704).
StartSubagent ==
    /\ WithSubagent
    /\ life["S"] = "unstarted"
    /\ LivePrimary # {}
    /\ life' = [life EXCEPT !["S"] = "live"]
    /\ role' = [role EXCEPT !["S"] = "secondary"]
    /\ UNCHANGED <<inTurn, turns, owner, env, reserved, part, stranded, wiped>>

\* The subagent leaves, after its turns or before any (`clearTurnState` keyed
\* by its id, `!holdsRegistration`). A reserved partition goes; with none, the
\* classifier decides: as a primary it clears and stamps the envelope.
LeaveSubagent ==
    /\ life["S"] = "live"
    /\ life' = [life EXCEPT !["S"] = "gone"]
    /\ inTurn' = [inTurn EXCEPT !["S"] = FALSE]
    /\ IF "S" \in reserved
          THEN /\ reserved' = reserved \ {"S"}
               /\ part' = [part EXCEPT !["S"] = {}]
               /\ UNCHANGED <<owner, env, wiped>>
          ELSE IF ResolvesPrimary("S")
               THEN /\ wiped' = (wiped \/ env # {})
                    /\ env' = {}
                    /\ owner' = "S"
                    /\ UNCHANGED <<reserved, part>>
               ELSE UNCHANGED <<owner, env, reserved, part, wiped>>
    /\ UNCHANGED <<role, turns, stranded>>

\* The claim's two admitted forms (`claimPrimaryTurnState`).
Claims(x) ==
    \/ owner \notin {None, x}
    \/ ClaimEmpty /\ owner = None /\ env = {}

\* turn_start: a secondary reserves its partition; the claim runs where its
\* switch allows it.
TurnStart(x) ==
    /\ life[x] = "live"
    /\ ~inTurn[x]
    /\ turns[x] < MaxTurns
    /\ inTurn' = [inTurn EXCEPT ![x] = TRUE]
    /\ turns' = [turns EXCEPT ![x] = @ + 1]
    /\ reserved' = IF role[x] = "secondary" THEN reserved \cup {x} ELSE reserved
    /\ owner' = IF /\ \/ role[x] = "primary" /\ PrimaryClaims
                      \/ role[x] = "secondary" /\ SecondaryClaims
                   /\ Claims(x)
                THEN x ELSE owner
    /\ UNCHANGED <<life, role, env, part, stranded, wiped>>

\* A worklist write by x, filed by the writer's classifier. It is stranded
\* when it lands outside the store x's own turn end reads.
Write(x) ==
    /\ inTurn[x]
    /\ IF ResolvesPrimary(x)
          THEN /\ env' = env \cup {x}
               /\ owner' = x
               /\ stranded' = (stranded \/ role[x] = "secondary")
               /\ UNCHANGED <<reserved, part>>
          ELSE /\ part' = [part EXCEPT ![x] = @ \cup {x}]
               /\ reserved' = reserved \cup {x}
               /\ stranded' = (stranded \/ role[x] = "primary")
               /\ UNCHANGED <<owner, env>>
    /\ UNCHANGED <<life, role, inTurn, turns, wiped>>

\* turn_end by the live role: the primary reads, replays and clears the
\* envelope and stamps itself; a secondary drains and drops its partition.
TurnEnd(x) ==
    /\ inTurn[x]
    /\ inTurn' = [inTurn EXCEPT ![x] = FALSE]
    /\ IF role[x] = "primary"
          THEN /\ env' = {}
               /\ owner' = x
               /\ UNCHANGED <<reserved, part>>
          ELSE /\ part' = [part EXCEPT ![x] = {}]
               /\ reserved' = reserved \ {x}
               /\ UNCHANGED <<owner, env>>
    /\ UNCHANGED <<life, role, turns, stranded, wiped>>

Next ==
    \/ \E x \in Sess : StartPrimary(x) \/ LeavePrimary(x) \/ TurnStart(x)
                       \/ Write(x) \/ TurnEnd(x)
    \/ StartSubagent
    \/ LeaveSubagent

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ life \in [Sess -> {"unstarted", "live", "gone"}]
    /\ role \in [Sess -> {"-", "primary", "secondary"}]
    /\ owner \in Sess \cup {None}
    /\ env \subseteq Sess
    /\ reserved \subseteq Sess

\* I1: every worklist write lands in the store its writer's own turn end
\* reads: the envelope for the live primary, its partition for a secondary.
NoStrandedWrite == ~stranded

\* I2: no clear keyed by one session empties work another session wrote.
NoForeignWipe == ~wiped

=============================================================================
