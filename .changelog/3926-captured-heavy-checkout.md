---
section: Fixed
audience: internal
---

- **The delayed Windows Vitest advisory checkout no longer fetches the deleted merge ref (refs #3926)** — `unit-tests-windows` starts only after the required checks pass, so auto-merge can already have deleted `refs/pull/<n>/merge`. Its checkout pinned `ref: ${{ github.ref }}` and fetched that dead ref, so the Windows subset never ran. It now relies on the pinned action's default captured commit (`github.sha`, the validated test-merge tree), exactly as the sibling gated jobs `mutation` and `codeql` do. The always-run outcome step also reports an honest bounded "Not executed" summary when the executed-file list is absent, instead of failing with a missing-module error that masked the checkout failure.
