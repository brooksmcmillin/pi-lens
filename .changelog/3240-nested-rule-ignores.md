---
section: Fixed
---

- **Nested bundled rule ignores (refs #3240)** — Console and Go rule directory carve-outs now apply at nested package depths without hiding similarly named application paths; the shared matcher now treats POSIX, drive-letter, and UNC paths with segment-aware containment on every host OS.
