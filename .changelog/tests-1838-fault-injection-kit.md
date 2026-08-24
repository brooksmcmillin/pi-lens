---
section: Added
---

- **Shared fault-injection test kit (closes #1838)** — `tests/support/fault-injection.ts` promotes the bespoke fault probes reviewers kept rebuilding by hand into four one-call primitives: `spawnWedgedChild` (a real child whose stdin pipe is genuinely full — the #1811 fixture generalized, with its fail-fast-instead-of-hang trap asserted against), `delayInside` (deterministic completion delay inside any mocked async seam), `fireResetAt` (fire a lifecycle hook from inside a seam's implementation at a chosen call — the #1746-R2-F1 shape), and `starveBudget` plus `gatedPromise` (the tiny-budget starvation repro). Every primitive carries its own fidelity test in `fault-injection.test.ts`, so a neutered primitive goes red in CI instead of silently weakening every consumer.
