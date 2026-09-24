---
section: Fixed
---

- **Honor `lens_diagnostic_mark` on turn-end unresolved blockers (refs #3246)** — The "Unresolved from this turn" section now applies the shared disposition/rule/inline-suppression policy to the blockers it re-serves, so a finding marked `false-positive` stops coming back on later turns; when every blocker on a file is marked, the section and its `🔴 STOP` text are dropped entirely.
