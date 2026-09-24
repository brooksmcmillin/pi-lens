---
section: Fixed
---

- `elixir-check` now decides whether a compiler diagnostic belongs to the
  edited file through `pathsEqual`, the shared on-disk path identity seam,
  instead of its own win32 case fold. Findings whose reported spelling differs
  from the dispatched one — a lowercase drive letter on Windows, a backslash
  segment anywhere — reach the agent as the blocking error they are instead of
  a generic unparseable-output warning (refs #1193).
