---
section: Fixed
---

- **Wall-clock budget tests get a quiet serial phase (closes #1920)** — Five test files asserting real elapsed-time budgets ran inside the default project's fork storm, measuring scheduler contention instead of code speed (`startup-overhead` measured 659-2321ms against a 500ms budget under load, green solo every time). They now run in a dedicated fully-serialized `wall-clock-budget` Vitest project that phases dead last on a quiet host. A coverage guard keeps the new include list from silently dropping renamed files.
