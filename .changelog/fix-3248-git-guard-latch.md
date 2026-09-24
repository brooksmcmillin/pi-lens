---
section: Fixed
---

- **The commit gate honors a turn-end disposition mark (refs #3248)** — when every blocker on a file is marked `false-positive`, turn end now recomputes the `--lens-guard` commit-gate latch from the surviving findings instead of from the raw blocker map, so the gate stops quoting findings pi-lens no longer prints, and the persisted turn-end record stops re-serving them; a blocker the policy did not suppress, a file demoted by the freshness sweep, and a freshly dispatched blocker all keep gating exactly as before, and a marked file whose bytes change outside pi-lens blocks again as `blocker state is unknown` until a fresh check judges the new content, rather than committing on a verdict that no longer describes the file.
