---
section: Changed
---

- **Turn-end madge circular-dependency check is opt-in, default off (closes [#766](https://github.com/apmantza/pi-lens/issues/766))** — the per-turn-end madge pass only produced debug output while adding tail latency to every turn; it now runs only with `--lens-turn-end-madge` (or `turnEnd.madge.enabled: true`). User-facing madge diagnostics still come from the session-start project scan and `lens_diagnostics`.
