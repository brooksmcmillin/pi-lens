---
section: Fixed
---

- Keep automatic probe telemetry outside reviewed checkouts in `~/.pi-lens/probe-logs/<canonical-root-sha256>`. Reviewer startup in temporary Git checkouts no longer creates untracked log files that fail clean-checkout checks. Machine state and explicit `PI_LENS_HOME` overrides retain their existing behavior.
