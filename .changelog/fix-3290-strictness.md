---
section: Fixed
---

- **Restore strictness in the actionable-warnings advisory (refs #3248)** —
  disposition identity fields that are absent from a warning are no longer
  emitted as explicit `undefined` values, keeping the strict optional-property
  ratchet at its existing floor.
