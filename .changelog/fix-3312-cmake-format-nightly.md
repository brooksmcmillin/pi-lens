---
section: Fixed
---

- Install `cmake-format` as `cmakelang[yaml]` so it can read a
  `.cmake-format.yaml` project config instead of dying with
  `ModuleNotFoundError: No module named 'yaml'`, force a pipx install that would
  otherwise be a silent no-op over an existing venv, and keep a bounded,
  banner-free formatter traceback tail for actionable failures (refs #3312).
