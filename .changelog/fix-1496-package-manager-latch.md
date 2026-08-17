---
section: Fixed
---

- **A stalled package-manager check no longer downgrades pi-lens's own managed installs to npm (closes #1496)** — Checking which package manager is installed spawned a `where`/`which` probe on a 5-second budget, and a timeout was remembered as "not installed" for the rest of the session. The blast radius was internal: the resolver only serves installs into pi-lens's managed tools directory and `pilens_rebuild` on a pi-lens source checkout, never a user project's lockfile. A timed-out check is now retried after a short wait instead of latching, matching the #1467/#1476 policy already used for knip, madge, govulncheck, vulture, biome, ast-grep, Go, and Rust. Each decision is recorded in `latency.log` as an `availability_decision` entry with its cause and timing.
