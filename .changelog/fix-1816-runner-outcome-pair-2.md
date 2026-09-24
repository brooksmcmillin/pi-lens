---
section: Fixed
---

- **Share runner outcome parsing for Dart Analyze and Elixir Check (refs #1816)** — Nonzero empty, malformed, stderr-only, or signaled runs no longer report a clean file; valid findings remain visible through the shared bounded outcome path.
