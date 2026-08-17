---
section: Fixed
---

- **A stalled PowerShell check no longer disables PSScriptAnalyzer for the rest of the session (closes #1490)** — The runner ran its own child processes to find a PowerShell interpreter and check for the PSScriptAnalyzer module, and every failure looked the same to it: a timeout, a Windows spawn error and a genuinely missing binary all reported nothing at all. Any of them was remembered as "PowerShell analysis is not available" until pi-lens restarted. Both probes now go through the shared spawn layer, so a timeout is distinguishable from an absence, and the verdict is owned by the same availability policy as knip, madge, Go and Rust: a stall is retried after a short wait, and only a genuine absence sticks. Each decision lands in `latency.log` as an `availability_decision` entry with its cause and timing.
