---
section: Fixed
---

- **GitHub CLI authentication for release tools (closes #3221)** — GitHub-release
  tool installation and refresh now reuse authenticated `gh` CLI credentials for
  API metadata requests, while keeping release asset downloads unauthenticated
  and reporting evidence-supported anonymous rate-limit failures with an
  actionable remedy.
