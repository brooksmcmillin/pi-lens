---
section: Fixed
audience: user
---

- **`rename_file` no longer overwrites a file written while the rename was computed.** A file the `workspace/willRenameFiles` edit rewrites text in must still hold the bytes the language server computed from; otherwise the whole edit is refused, nothing is written or moved, and the result names the stale file.
