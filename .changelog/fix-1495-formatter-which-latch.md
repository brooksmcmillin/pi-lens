---
section: Fixed
---

- **A stalled PATH lookup no longer disables a formatter until you edit a config file (closes #1495)** — Detecting rustfmt, shfmt, zig, dart, nixfmt, gofmt and about a dozen other formatters runs `which`/`where` on a 5-second budget. A single timeout dropped the formatter and then wrote that empty result into the detection cache, which is only invalidated when a formatter config file changes size or timestamp — so formatting stayed silently off for the rest of the session, looking to you like pi-lens deciding the file needed no formatting. PATH lookups now go through the shared availability policy: a timeout is retried after a short wait, only a genuine absence sticks, and an empty detection caused by a stalled probe is no longer cached at all. Editing a config file still re-checks PATH, so installing a formatter mid-session works as before. Each lookup is recorded in `latency.log` as an `availability_decision` entry with its cause.
