---
section: Fixed
---

- The temporary-fixture hygiene sweep now waits for live test owners to finish
  their bounded cleanup drain and attributes remaining entries to the owner
  file, preventing cross-worker false leaks without adding prefix admissions.
  Owner markers authenticate themselves with a heartbeat the worker refreshes
  from its own test lifecycle, so an orphaned or PID-reused worker is attributed
  after the bound on every platform, not only where `/proc` exists (refs #3186).
