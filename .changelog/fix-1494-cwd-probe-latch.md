---
section: Fixed
---

- **A stalled version check no longer disables eslint, credo or clippy for the rest of the session (closes #1494)** — The per-directory probe these three runners share cached its verdict forever, so a single `eslint --version` that timed out on the first JS/TS save silently dropped eslint for that project until pi-lens restarted. Credo's 10-second `mix credo --version` on a cold BEAM and clippy's 8-second `cargo clippy --version` had the same failure mode, and clippy went further by treating the timeout as grounds for an install attempt. The verdict now goes through the shared availability policy from #1467/#1476: only a genuine absence sticks, while a timeout, abort or host stall is retried after a short cooldown. ESLint autofix in the post-write pipeline carried its own copy of the latch and is fixed the same way. Every decision is recorded in `latency.log` as an `availability_decision` entry with its cause, timing and retry window.
