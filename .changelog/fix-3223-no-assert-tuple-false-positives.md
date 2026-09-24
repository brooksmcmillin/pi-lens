---
section: Fixed
---

- **`no-assert-tuple` now checks only the assertion condition (closes #3223).**
  Tuple literals used in comparisons, calls, comprehensions, containers, and
  assertion messages no longer produce false-positive diagnostics.
