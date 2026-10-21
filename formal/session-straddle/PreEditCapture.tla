------------------------ MODULE PreEditCapture ------------------------
EXTENDS Naturals, FiniteSets
\* #4543: capture slots remain owned through abort and session reset until
\* runner teardown settles. Cancellation must be checked before seed publish.
CONSTANTS Capacity, CheckCancellation
Paths == 1..5
VARIABLES active, cancelled, seeded, reset, badSeed, missedFresh
vars == <<active, cancelled, seeded, reset, badSeed, missedFresh>>
Init == /\ active = {} /\ cancelled = {} /\ seeded = {}
        /\ reset = FALSE /\ badSeed = FALSE /\ missedFresh = FALSE
Start(p) == /\ p \notin active /\ Cardinality(active) < Capacity
            /\ active' = active \cup {p}
            /\ UNCHANGED <<cancelled, seeded, reset, badSeed, missedFresh>>
Abandon(p) == /\ p \in active /\ cancelled' = cancelled \cup {p}
              /\ UNCHANGED <<active, seeded, reset, badSeed, missedFresh>>
Reset == /\ ~reset /\ reset' = TRUE /\ cancelled' = active
         /\ seeded' = {} /\ UNCHANGED <<active, badSeed, missedFresh>>
Finish(p) == /\ p \in active /\ active' = active \ {p}
             /\ cancelled' = cancelled \ {p}
             /\ seeded' = IF CheckCancellation /\ p \in cancelled
                           THEN seeded ELSE seeded \cup {p}
             /\ badSeed' = (badSeed \/ (~CheckCancellation /\ p \in cancelled))
             /\ missedFresh' = (missedFresh \/ (p \notin cancelled /\ p \notin seeded'))
             /\ UNCHANGED reset
Next == Reset \/ (\E p \in Paths: Start(p) \/ Abandon(p) \/ Finish(p))
Spec == Init /\ [][Next]_vars
Bounded == Cardinality(active) <= Capacity
NoLateSeed == ~badSeed
NoFreshDrop == ~missedFresh
=============================================================================
