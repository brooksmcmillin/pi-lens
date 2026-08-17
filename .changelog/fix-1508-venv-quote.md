---
section: Fixed
---

- **Venv-resolved tool paths are no longer wrapped in literal quotes (closes #1508)** — When a linter such as `ruff` resolved through a project virtualenv (`.venv/bin/ruff`), the availability seam returned the path wrapped in double-quote characters — a leftover from the `shell: true` spawn era. Every spawn now runs with `shell: false` (#817), so the quotes became part of the filename, the probe failed with ENOENT, and the runner silently reported no diagnostics. The path is now returned verbatim on every platform, and the resolved command is pinned quote-free by regression tests. Reported by @phionax.
