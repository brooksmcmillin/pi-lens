---
section: Fixed
---

- Runner diagnostics are attributed to the edited file through one seam:
  `pathsEqual` against the path the tool itself reported, resolved from the cwd
  the tool ran in. `golangci-lint`, `rust-clippy`, `javac`, `zig-check`,
  `detekt`, `cpp-check`, `dotnet-build`, `dart-analyze` and `cue-vet` each
  decided it locally before — a bare `===`, a `path.resolve` with no base, a
  basename compare, an `endsWith` — so a `golangci-lint` run in any project
  whose Go module root is not the extension's own working directory dropped
  every finding for the edited file and reported it clean, and a `cue vet` error
  in a sibling directory whose file shared the touched file's name was reported
  as the touched file's own failure (refs #3278).
