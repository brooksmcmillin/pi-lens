---
section: Fixed
audience: user
---

- **Restore the registry identity the idle-eviction probe arms, so measured servers can be promoted.** The compiled LSP registry hands back the catalog entry itself for every built-in without a command override instead of a shallow copy, so a policy set on the object `LSP_SERVERS`/`getServerById` exposes is the policy the client registry reads (refs #3952). Since 2026-10-10 the copy swallowed the nightly probe's `idleEviction` arm, so every measurement row read `not-evicted` and no server could earn a promotion night. An overridden server keeps its own copy, so its `spawn` and trust admission never reach the shared catalog. `scheduleIdleEviction` also records `lsp-idle-eviction-declined` once per server per session when it declines to arm a timer, so "no timer scheduled" no longer reads as "slow eviction". `/lens-perf` and `pilens_health` print both idle-eviction rows as plain counts rather than `⚠` warnings: a release and a declaration are the policy answering.
