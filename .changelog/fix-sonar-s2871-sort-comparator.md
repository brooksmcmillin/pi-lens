---
section: Fixed
audience: internal
---

- **Declaration walk states its sort order with the shared code-unit comparator** —
  `walkDeclarations` now passes `compareOrdinal` to `found.sort()` instead of a
  bare `.sort()`, and `carryUnreadable`'s inline three-way comparator moved onto
  the same export. Both bodies were already code units, so no output moves; the
  change states the intent the bare call left implicit and closes SonarCloud
  `typescript:S2871` on the changed code.
