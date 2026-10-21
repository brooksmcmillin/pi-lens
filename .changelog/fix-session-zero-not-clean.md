---
section: Fixed
audience: user
---

- **Session diagnostics disclose incomplete evidence (closes #4620)** — `lens_diagnostics` session results and compact summaries no longer show a ✓ or "clean" for a pending, stale or never-diagnosed file. Only a final snapshot with no matching findings reads clean; every other zero-finding result says `inconclusive` or `unverified`, and names a next check scoped to the requested paths with the pi or MCP tool name. A file that changed on disk stays `inconclusive` on every later read, and the footer withholds `✓ clean` for it, until a fresh analysis replaces its evidence. Session reads still run no validation. The footer's five file rows go to the highest tiers first, so a retained warning never pushes a blocking row out of the frame.
