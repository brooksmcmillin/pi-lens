---
section: Fixed
---

- `go vet` findings for the file you just edited are no longer dropped when
  go's spelling of that file's path differs from the dispatcher's. The runner
  now decides "is this line about the edited file?" through `pathsEqual`, the
  shared on-disk path identity seam, instead of a bare string compare, so a
  differently-cased path on Windows or a case-folding macOS volume is
  recognised as the same file and the run is no longer reported clean
  (closes #3277, refs #1193).
