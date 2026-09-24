---
section: Fixed
---

- Runner parsers now attribute a diagnostic only when the tool-reported path
  matches the dispatched file, resolved from the cwd the tool actually ran in:
  taplo, yamllint, htmlhint, oxlint, shellcheck, trivy-config, stylelint,
  rubocop, eslint, biome, tflint, swiftlint, ktlint, hadolint, actionlint,
  typos, sqlfluff, vale, markdownlint, php -l, and the shared line-parser
  factory behind ruff's text fallback. A second file's finding is no longer
  delivered as the edited file's problem (refs #3295, #3278, #1193).
