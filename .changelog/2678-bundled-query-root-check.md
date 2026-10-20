---
section: Fixed
audience: user
---

- **Record bundled query-root checks:** Tree-sitter now records the bundled root's health and entry count once per ledger generation, so a healthy check is distinguishable from a check that never ran. Repeated file dispatches do not add duplicate check records. (#2678)
