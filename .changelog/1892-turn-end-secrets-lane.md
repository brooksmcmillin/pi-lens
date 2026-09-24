---
section: Changed
---

- Extracted the turn-end secrets delivery (the gitleaks and trivy-secrets
  blocker and demoted tiers) out of `clients/runtime-turn.ts` into
  `clients/turn-end/lanes/secrets.ts` behind one `TurnEndLane` interface —
  collect the stores, gate them with the composer's shared freshness pass, then
  render — so the ten rendering and disposition rules that block used to state
  inline now live once, in the lane, and the composer states none of them
  (refs #1892, ADR 0008). Agent-facing text is byte-identical: the committed
  witness golden for the scanner lanes is unchanged and a second golden pins the
  lane's own live tier, demoted tier, combined ast-grep provenance and
  suppressed-by-disposition notice through the real pi host entry.
