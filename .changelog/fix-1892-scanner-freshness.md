---
section: Changed
---

- The three cached scanner lanes turn_end reads — gitleaks, trivy secrets and
  govulncheck — now share ONE cited-path freshness pass instead of calling the
  gate once each (refs #1892). A file both secret scanners flag was stat'd
  twice and wrote two `finding_stale_line_demote` rows for one decision about
  one file; it is now one stat and one bounded record per delivery, carrying a
  `byStore` breakdown so the row still says which store's findings were
  retired. The stat allowance stays per store — a shared pool would let one
  lane spend it and leave another re-rendering an edited cited line as current
  — and a delivery that exhausts one now writes a bounded
  `finding_path_stat_budget_exhausted` row naming every store affected, which
  nothing disclosed before. Source identity survives the fold: each store's own `scannedAt`
  decides its own findings' staleness, and each store's own missing-path policy
  decides its own findings' deletion, so a govulncheck CVE still survives a
  deleted call site on the same path that drops a gitleaks secret. Scanner
  cache records written by 4.2.1 parse and render unchanged.
