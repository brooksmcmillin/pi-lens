---
section: Fixed
---

- **Transient security-scanner probe records now carry their retry schedule (closes #1501)** — When a `gitleaks`/`trivy`/`opengrep`/`govulncheck` version probe timed out, the `availability_decision` record in `latency.log` said the tool was off but not when it would be retried, because the record was emitted before the caller decided the cooldown. The shared seam now owns the transient cooldown and logs `retryAfterMs` alongside the existing outcome, cause, and timing fields, matching the shape the install and scan paths already emitted. Success and durable-absence records are unchanged.
