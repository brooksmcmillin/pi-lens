---
section: Fixed
---

- **oxfmt no longer fails on a file its own config ignores (refs #1844)** —
  pi-lens offers oxfmt for every extension oxfmt supports, so in a project
  whose oxfmt config carries `ignorePatterns`, oxfmt was selected for files it
  then refused to touch. It exits 2 with "Expected at least one target file",
  which the strict exit-code posture read as a formatting failure, so every
  edit to an ignored file surfaced an error. pi-lens now passes
  `--no-error-on-unmatched-pattern`, which makes an empty target set a clean
  no-op. Every other nonzero exit, including an unparseable file, still fails.
