---
section: Changed
---

- Extracted the turn-end govulncheck delivery (the 🛡️ Go CVE advisory tier) out
  of `clients/runtime-turn.ts` into `clients/turn-end/lanes/govulncheck.ts`
  behind the same `TurnEndLane` interface as the secrets lane, and added the
  advisory tier to `TurnEndLaneParts` with it — the first lane that renders one,
  so the field, the composer's tagged push and the registered surface arrive
  together rather than as a slot nothing reads (refs #1892, ADR 0008
  amendment). The six rules the block stated inline — the `onMissing: "demote"`
  first-trace-frame freshness declaration, the disposition anchor over both
  freshness arms, the withheld stale line and its marker, the module/package
  fallback, the upgrade hint and the display cap — now live once, in the lane.
  Agent-facing text is byte-identical: both committed witness goldens are
  unchanged and a third pins this lane's live rows, demoted rows, deleted
  call-site demotion, module fallback, cap and suppression notice through the
  real pi host entry.
