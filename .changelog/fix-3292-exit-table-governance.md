---
section: Changed
---

- Every `parseToolRun` runner now documents its nonzero exit table, its
  documented `ran` codes are pinned exactly so neither adding nor removing one
  passes silently, and each documented code needs an executable status fixture
  in the runner's test matrix (refs #3292).
