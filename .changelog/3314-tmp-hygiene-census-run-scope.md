---
section: Fixed
---

- The tmp-fixture hygiene census now judges only the temp entries the running
  vitest invocation created: a root left by another invocation sharing the same
  `TMPDIR` is neither reported as this run's leak nor deleted from under it, a
  leak report names the test file behind a raw `mkdtempSync` prefix instead of
  `owner: tests/unknown`, and the owner-marker liveness cases read only the
  markers they wrote, so a fully skipped test file in the same invocation no
  longer reds them (refs #3314, refs #3316, refs #3306).
