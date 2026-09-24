---
section: Fixed
---

- LSP workspace-edit changed paths are compared with the dispatched file through
  the filesystem-aware path identity seam instead of a bare string equality, so a
  differently spelled path to the same file is no longer announced as a
  collateral change of itself (refs #3294).
