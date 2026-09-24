---
section: Fixed
---

- `gleam check` diagnostics and `ruff` autofix findings are now attributed to the
  edited file through the same seam every other tool uses (`pathsEqual` against
  the path the tool reported, resolved from the cwd it ran in). gleam's location
  line arrives inside `codespan_reporting`'s `┌─` gutter, which a suffix compare
  was tolerating, so on Windows — and on any case-folding mount — a spelling
  that differed only in case dropped every gleam diagnostic for the edited file;
  ruff's JSON `filename` was compared with a bare `!==` against a path resolved
  with no base at all, which silently meant the extension's own working
  directory (refs #3285, refs #3286).
