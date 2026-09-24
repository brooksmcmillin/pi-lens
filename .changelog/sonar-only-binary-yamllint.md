---
section: Changed
---

- The lint workflow installs yamllint with `--only-binary=:all:`, so pip can never fall back to running a source distribution's setup script on the runner (SonarCloud githubactions:S8541; the only open finding failing the master quality gate since 2026-09-08).
