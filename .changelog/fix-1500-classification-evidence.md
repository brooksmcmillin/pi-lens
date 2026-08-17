---
section: Fixed
---

- **Tool-availability records now show what actually failed, and a failed auto-install is no longer a silent verdict (closes #1500)** — When pi-lens decides a tool is unavailable it writes one `availability_decision` line to `latency.log`. Those lines reported the verdict but not the evidence, so "the tool is missing" looked identical whether a probe returned "not found" or an auto-install had just failed for a reason that would clear on a retry. Each line now carries the raw spawn facts (exit status, failure kind, errno, whether an install was attempted) and says whether the classification was derived from a probe or asserted by the caller. Security-scanner clients — gitleaks, trivy, opengrep, govulncheck — used to latch "not installed" after a failed install without recording anything at all; that write is now recorded like any other decision.
