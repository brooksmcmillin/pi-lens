---
section: Fixed
audience: user
---

- Report unrunnable `pi-lens-analyze` invocations on stdout and in `pilens_health`. Plain CLI failures exit 2; edit and Stop hooks remain non-blocking. Failure reasons are bounded and redacted (#3922).
