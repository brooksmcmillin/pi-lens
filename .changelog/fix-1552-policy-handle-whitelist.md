---
section: Fixed
---

- **The availability-policy coverage gate no longer waves through a verdict that dodges the word "boolean" (refs #1552)** — Routing inheritance decided whether a unit that delegates its spawn to a routed helper may borrow that helper's coverage. It worked as a blacklist: inherit unless the unit's own memo "looks boolean". A `Map<string, "yes" | "no">` string-union verdict spells neither "boolean" nor a policy-factory name and slipped through, and a genuine boolean reached through a type alias slipped through the same way, since the word only ever appears in the alias's own declaration. The gate now works as a whitelist: a unit inherits routing only when its own memo is traceably a policy factory's handle, directly or through one hop of a module-local wrapper. An unrecognised shape defaults to unrouted instead of routed.
