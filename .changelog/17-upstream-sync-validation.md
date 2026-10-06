---
section: Fixed
audience: internal
---

- Allow PR-body validation to capture upstream-sync diffs up to 16 MiB instead
  of Node's 1 MiB default. Keep MCP dispatch smoke inputs independent of
  Stryker's generated-source annotations (refs #17).
