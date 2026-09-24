---
section: Fixed
---

- A language server that answers `didOpen` with an empty diagnostic set while it
  indexes no longer makes pi-lens report the file clean. intelephense publishes
  `[]` before its whole-workspace index is warm and the real findings once
  indexing ends, so `lsp_diagnostics` reported a php file carrying an undefined
  variable as "confirmed clean". pi-lens now holds such a server's empty first
  publish — once per session, released by the server's own next publish — so the
  finding is reported, while every server that publishes `[]` for a genuinely
  clean file keeps confirming it with no added wait (refs #3310).
