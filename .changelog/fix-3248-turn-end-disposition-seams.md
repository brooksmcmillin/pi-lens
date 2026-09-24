---
section: Fixed
---

- **Apply stored dispositions at six more turn-end surfaces (refs #3248)** — knip's blocker and advisory, the dead-code advisory, the call-graph impact advisory, the late-runner drain and the code-quality warnings advisory now filter through the shared disposition/rule policy before rendering, so a finding marked `false-positive` stops re-reporting there; a mark that names no tool — the only spelling those surfaces' own text can carry — is honored too.
