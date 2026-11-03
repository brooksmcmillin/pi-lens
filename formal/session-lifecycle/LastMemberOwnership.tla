---------------------- MODULE LastMemberOwnership ----------------------
EXTENDS FiniteSets, TLC
\* #4554 r5: two activations, three context identities. M and R deliberately
\* have the SAME stable session id; only registration context identifies owner.
\* R may replace stale M in A, or reload into B after M leaves A with S live.
\* No timers, stores or filesystem protocol are abstracted by this slice.
\* #4554 r6 (Greptile F1): may a leave this activation cannot place run the
\* shared teardown? FALSE is as-built: last means no live member remains, so a
\* superseded primary's delayed shutdown cannot stop the replacement.
CONSTANT UnmatchedLeaveIsLast
\* #4704: pi 1.3.0 runs the factory once per session load, so an in-process
\* subagent T is its OWN activation C (a declined start: C admits nothing).
\* ProcessWideLast: is "last" read across every activation (TRUE, as-built),
\* or within the leaving one (FALSE, pre-fix: M's leave tore down under T)?
\* With TRUE, the process's last leave releases whichever registration is
\* held, whatever its activation admitted: no live successor can remain, and
\* no other leave would release it (S last in A after R left B, or T last).
\* StaleMemberHolds: does a member pi invalidated without a shutdown still
\* count as live? pi's `AgentSession.dispose()` emits no session_shutdown, so
\* TRUE strands the registration forever once T is disposed; FALSE is as-built
\* (`hasLiveSessionInProcess` skips a context `probeCtxActive` reads stale).
CONSTANTS ProcessWideLast, StaleMemberHolds
\* #4708 review F1: SplitRelease says who releases the primary REGISTRATION.
\* TRUE is as-built: the holder's own leave releases it, whatever else is
\* live, and only the process's last live leave tears the shared INFRA down
\* (it also releases a registration still held then). FALSE is round 1 of
\* #4708: one boundary for both, so a primary that left while T lived kept
\* its dead registration, and root identity (#2129) declined a successor in
\* another root (`/resume`) as `secondary-root` for its whole life.
\* StartKeepsLiveFleet: does a full start keep the shared LSP fleet while
\* another session is truly live (TRUE, as-built)? FALSE resets it under T,
\* the start-side twin of an early teardown.
CONSTANTS SplitRelease, StartKeepsLiveFleet
\* #4965: the session-id lookup (`clients/session-scope.ts`) is a process-wide
\* index from a session's key to its scope, so a key nobody gives back holds an
\* ended session's scope and cells for the life of the process. `bound` is the
\* set of contexts whose key the index names. M and R share one key, so R's
\* bind takes M's. UnbindAtLeave: does every leave give its key back (TRUE,
\* as-built), or only the activation's last leave, whose retire did (FALSE,
\* #4972 r1: S leaving before M stayed bound)? DisposalUnbinds: does a process
\* read that finds a member pi disposed give its key back (TRUE, as-built), or
\* is it only counted (FALSE, r1: T stayed bound)? SweepAtStart: does every
\* start read the process (TRUE, as-built), or only a primary's (FALSE, r1:
\* a run of subagent starts never found the disposed ones)?
CONSTANTS UnbindAtLeave, DisposalUnbinds, SweepAtStart

VARIABLES members, admitted, owner, started, cleaned, departed, saved, foreignTeardown,
          earlyTeardown, stale, missedTeardown, declinedSuccessor, bound, leaked
vars == <<members, admitted, owner, started, cleaned, departed, saved, foreignTeardown,
          earlyTeardown, stale, missedTeardown, declinedSuccessor, bound, leaked>>
Acts == {"A", "B", "C"}
Ctxs == {"M", "R", "S", "T"}
Role(c) == IF c \in {"S", "T"} THEN "secondary" ELSE "primary"
AllMembers(m) == UNION {m[a] : a \in Acts}
\* The truth: a session pi disposed never shuts down and is not live.
TrueLive(m) == {c \in AllMembers(m) : c \notin stale}
\* What the code counts as live.
CodeLive(m) == IF StaleMemberHolds THEN AllMembers(m) ELSE TrueLive(m)
\* #4965: a process read (`hasLiveSessionInProcess`) gives back the key of
\* every member pi disposed, beside a live sibling or not.
Swept(b) == IF DisposalUnbinds THEN b \ stale ELSE b
\* The read a start makes: every start as-built, only a full start before.
StartSweep(b, full) == IF SweepAtStart \/ full THEN Swept(b) ELSE b
\* The ghost: after this start or leave, an ended session is still bound. A
\* context is gone once it left and no activation lists it (a LateLeave of a
\* context another activation still holds names no key of its own).
Leaks(b, m, d) == b \cap ((d \ AllMembers(m)) \cup stale) # {}
Init == /\ members = [a \in Acts |-> {}]
        /\ admitted = [a \in Acts |-> "none"]
        /\ owner = "none" /\ started = {} /\ cleaned = {} /\ departed = {}
        /\ saved = [c \in Ctxs |-> "none"] /\ foreignTeardown = FALSE
        /\ earlyTeardown = FALSE /\ stale = {} /\ missedTeardown = FALSE
        /\ declinedSuccessor = FALSE
        /\ bound = {} /\ leaked = FALSE
StartM == /\ "M" \notin started
          /\ members' = [members EXCEPT !["A"] = {"M"}]
          /\ admitted' = [admitted EXCEPT !["A"] = "M"]
          /\ owner' = "M" /\ started' = started \cup {"M"}
          /\ bound' = StartSweep(bound, TRUE) \cup {"M"}
          /\ leaked' = (leaked \/ Leaks(bound', members', departed))
          /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown, declinedSuccessor>>
StartS == /\ "M" \in members["A"] /\ "S" \notin started
          /\ members' = [members EXCEPT !["A"] = @ \cup {"S"}]
          /\ started' = started \cup {"S"}
          /\ bound' = StartSweep(bound, FALSE) \cup {"S"}
          /\ leaked' = (leaked \/ Leaks(bound', members', departed))
          /\ UNCHANGED <<admitted, owner, cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown, declinedSuccessor>>
\* #4704: M's subagent binds in its own activation C and is declined.
StartT == /\ "M" \in members["A"] /\ "T" \notin started
          /\ members' = [members EXCEPT !["C"] = @ \cup {"T"}]
          /\ started' = started \cup {"T"}
          /\ bound' = StartSweep(bound, FALSE) \cup {"T"}
          /\ leaked' = (leaked \/ Leaks(bound', members', departed))
          /\ UNCHANGED <<admitted, owner, cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown, declinedSuccessor>>
\* #4704: T's runner disposes its session: pi invalidates T's contexts and
\* emits no session_shutdown, so T never leaves.
DisposeT == /\ "T" \in members["C"] /\ "T" \notin stale
            /\ stale' = stale \cup {"T"}
            \* Detection is lazy: T's key goes at the next process read.
            /\ UNCHANGED <<members, admitted, owner, started, cleaned, departed, saved,
                           foreignTeardown, earlyTeardown, missedTeardown, declinedSuccessor,
                           bound, leaked>>
\* R is M's successor (`/new`, `/resume`, a reload). `r` is its root: the
\* registered primary's (`same`) or another (`other`, a cross-root resume).
\* The start's classifier (`explainSessionStart`) declines R when a
\* registration is still held and R's root differs from it: the
\* root-differs branch precedes the prior-context-dead branch (#2129). Every
\* prior owner R can meet here is dead (replaced or departed), so a held
\* registration with the same root is a sequential replacement.
StartR(a, r) ==
    /\ a # "C" /\ "M" \in started /\ "R" \notin started
    /\ IF a = "B" THEN "M" \notin members["A"] ELSE TRUE
    /\ started' = started \cup {"R"}
    /\ IF owner # "none" /\ r = "other"
       THEN \* Declined: R binds as a member and admits nothing. The ghost
            \* flags it only once M really left, which is when a registration
            \* outlived its holder's leave (#4708 F1). A held registration of
            \* a primary pi replaced WITHOUT a shutdown declines a cross-root
            \* start before and after #4704 alike.
            /\ members' = [members EXCEPT ![a] = @ \cup {"R"}]
            /\ declinedSuccessor' = (declinedSuccessor \/ "M" \in departed)
            \* R's key is M's: the bind moves it to R.
            /\ bound' = (StartSweep(bound, FALSE) \ {"M"}) \cup {"R"}
            /\ UNCHANGED <<admitted, owner, earlyTeardown>>
       ELSE /\ members' = [members EXCEPT ![a] =
                    {c \in @ : Role(c) # "primary"} \cup {"R"}]
            /\ admitted' = [admitted EXCEPT ![a] = "R"]
            /\ owner' = "R"
            \* The full start's LSP reset, with another session truly live.
            /\ earlyTeardown' = (earlyTeardown \/
                    (~StartKeepsLiveFleet /\ TrueLive(members) \ {"M"} # {}))
            /\ bound' = (StartSweep(bound, TRUE) \ {"M"}) \cup {"R"}
            /\ UNCHANGED declinedSuccessor
    /\ leaked' = (leaked \/ Leaks(bound', members', departed))
    /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown, stale, missedTeardown>>
Leave(a,c) ==
    /\ c \in members[a]
    /\ c \notin stale
    /\ LET remaining == members[a] \ {c}
           after == [members EXCEPT ![a] = remaining]
           last == IF ProcessWideLast THEN CodeLive(after) = {} ELSE remaining = {}
           owns == IF ProcessWideLast THEN owner # "none" ELSE admitted[a] = owner
           \* The shared infra: the registry entry and the LSP fleet.
           tearsDown == IF SplitRelease THEN last ELSE last /\ owns
           \* The registration: its holder's own leave, or the last leave.
           releases == IF SplitRelease
                       THEN c = owner \/ (last /\ owner # "none")
                       ELSE tearsDown
           \* The activation's own last leave retires the leaver's scope, which
           \* gives its key back (index.ts `isLast`, a disposed member not live).
           lastInAct == IF StaleMemberHolds THEN remaining = {}
                        ELSE remaining \subseteq stale
           unbinds == UnbindAtLeave \/ lastInAct
           \* The key c's bind holds: R took M's.
           keyed == IF c = "M" /\ "R" \in bound THEN {} ELSE {c}
       IN /\ members' = after
          /\ bound' = Swept(IF unbinds THEN bound \ keyed ELSE bound)
          /\ leaked' = (leaked \/ Leaks(bound', members', departed \cup {c}))
          /\ owner' = IF releases THEN "none" ELSE owner
          \* #4704: released a registration whose own session is still live.
          /\ foreignTeardown' = (foreignTeardown \/
                    (releases /\ owner \in TrueLive(after)))
          /\ earlyTeardown' = (earlyTeardown \/ (tearsDown /\ TrueLive(after) # {}))
          \* #4704: a leave that leaves no session truly live keeps the shared
          \* infra or a held registration (the stale-holds mutation).
          /\ missedTeardown' = (missedTeardown \/
                    ((~tearsDown \/ (~releases /\ owner # "none")) /\
                     TrueLive(after) = {}))
    /\ departed' = departed \cup {c}
    /\ cleaned' = cleaned \cup {c}
    /\ saved' = [saved EXCEPT ![c] = Role(c)]
    /\ UNCHANGED <<admitted, started, stale, declinedSuccessor>>
\* #4554 r6: the superseded primary's DELAYED shutdown arrives after the
\* replacement's full admission retired its membership record in this
\* activation, so it is unmatched. It may run no shared teardown: a live member
\* remains and the owner registration is the replacement's, not the departing
\* context's. `UnmatchedLeaveIsLast = TRUE` is the pre-fix reading that reset a
\* live replacement's LSP fleet and registry entry (and retired its scope).
LateLeave(a, c) ==
    /\ c \in started
    /\ c \notin members[a]
    /\ owner = admitted[a]
    /\ members[a] # {}
    /\ LET tearsDown == UnmatchedLeaveIsLast
       IN /\ owner' = IF tearsDown THEN "none" ELSE owner
          /\ earlyTeardown' = (earlyTeardown \/ tearsDown)
    \* Unmatched: no key of its own to give back (R holds M's); its read sweeps.
    /\ bound' = Swept(bound)
    /\ leaked' = (leaked \/ Leaks(bound', members, departed \cup {c}))
    /\ UNCHANGED <<members, admitted, started, foreignTeardown, stale, missedTeardown,
                   declinedSuccessor>>
    /\ departed' = departed \cup {c}
    /\ cleaned' = cleaned \cup {c}
    /\ saved' = [saved EXCEPT ![c] = Role(c)]

Next == StartM \/ StartS \/ StartT \/ DisposeT \/ (\E a \in Acts, r \in {"same", "other"} : StartR(a, r)) \/
        (\E a \in Acts, c \in Ctxs : Leave(a,c)) \/
        (\E a \in Acts, c \in Ctxs : LateLeave(a,c))
Spec == Init /\ [][Next]_vars
NoForeignTeardown == ~foreignTeardown
NoEarlyTeardown == ~earlyTeardown
NoSupersededMembers == ~("R" \in started /\ admitted["A"] = "R" /\
    "M" \in members["A"])
\* #4704: the registration is held only while a session is truly live (the
\* #472 leak), with ONE accepted exception: every member still recorded was
\* disposed with no shutdown, so no pi-lens callback can run. That is T
\* disposed after M left first; the next full admission or process exit
\* releases it (the PR's accepted residual). Before #4704 this read "an
\* activation that admitted the owner still has a member", which the
\* cross-activation rule deliberately breaks while T outlives M.
NoStrandedOwner == owner = "none" \/ TrueLive(members) # {} \/
    (AllMembers(members) # {} /\ AllMembers(members) \subseteq stale)
NoMissedTeardown == ~missedTeardown
\* #4708 F1: no successor of a primary that left is declined behind that
\* primary's dead registration.
NoDeclinedSuccessor == ~declinedSuccessor
OwnScopeAndCleanup == departed \subseteq cleaned /\
    \A c \in departed : saved[c] = Role(c)
\* #4965: after every start and every leave, the session-id lookup names no
\* session that left or that pi disposed (the leak #2442's cap used to bound).
NoLeakedBinding == ~leaked
=============================================================================
