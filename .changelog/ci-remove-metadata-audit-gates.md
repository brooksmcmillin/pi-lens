---
section: Changed
audience: internal
---

- **Simpler fork CI policy** — Remove the production dependency-audit step and PR-body validation from CI, remove PR-body validation from local preflight, and make issue references optional in PR titles and commit subjects. Conventional title prefixes, lint, type-checking, and other checks remain in place.
