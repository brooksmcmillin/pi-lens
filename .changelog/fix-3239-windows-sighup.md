---
section: Fixed
---

- **Avoid unsupported Windows SIGHUP re-raise (refs #3239)** — Console-close cleanup now preserves tracked-child termination without recording a false crash from `kill ENOSYS`.
