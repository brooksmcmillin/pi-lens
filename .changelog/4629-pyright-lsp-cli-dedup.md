---
section: Fixed
audience: user
---

- **A Python error is listed once, not twice, when Pyright finds it (closes #4629)** — the `pyright` CLI and the Pyright language server (or basedpyright's) both check a `.py` file and name each finding under a different spelling of its rule, so one error showed up twice in the STOP block and counted twice in its header. The two spellings are now one identity, and a bare Pyright code in `rules.<id>.disable`, `select` or a `pi-lens-ignore` comment reaches both copies where it used to hide only the CLI's. The same identity also stops an unchanged error from showing up as new after a write when the language server goes silent and only the CLI's copy is left.
