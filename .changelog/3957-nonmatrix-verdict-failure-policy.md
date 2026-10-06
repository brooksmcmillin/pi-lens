---
section: Changed
audience: internal
---

- **The non-matrix required producers' verdict steps are pinned against tolerated failure (refs #3957)** — `tests/config/sharded-aggregate-failure-policy.test.ts` now reads `.github/workflows/lint.yml` alongside `ci.yml` and names every no-drop verdict step of the required `Lint & type-check`, `knip`, and `oxfmt` jobs, so a `continue-on-error: true` on any of them reds instead of greening its required check. The same table classifies every step of the three jobs (verdict 6/1/1, setup 3/3/3, best-effort 0/0/0), so a step added without a class also reds while the intentionally best-effort and setup steps stay accepted. A live step may reuse a declared step identity only as often as the declaration does, so a duplicate `name:`/`uses:` reds even when another step was removed and the total is unchanged.
