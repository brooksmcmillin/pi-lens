---
section: Fixed
---

- **Turn-end scanner-cache reads no longer block the hook (refs #3274)** — the
  gitleaks, trivy and govulncheck stores `turn_end` reads once per delivery were
  read synchronously, so a slow or wedged filesystem held the whole hook and no
  deadline or Escape could release it. They now read through
  `CacheManager.readCacheAsync` under the turn_end budget and the hook's abort
  signal; a read that cannot finish inside the budget is abandoned, delivers the
  same output as a cold cache, and is recorded — once per turn, naming the
  stores the turn was composed without — instead of stalling the turn.
