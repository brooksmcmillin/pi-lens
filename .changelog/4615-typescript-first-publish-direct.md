---
section: Changed
audience: user
---

- **TypeScript files confirm clean on their first touch.** typescript-language-server's first publish for a file that has a finding already carries it (measured 2026-10-20), so the client no longer holds that first publish: a clean TypeScript file's single empty publish now resolves `lsp_diagnostics` instead of leaving the first touch of each session unconfirmed and spending its full wait budget (#4615).
