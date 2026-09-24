---
section: Fixed
---

- `--lens-guard` no longer blocks every `git commit` for the rest of a session
  once pi-lens has reported a blocker. The commit gate validated its own
  persisted blocker record one line at a time while both writers of that record
  render multi-line blocker text, so from the first blocker onward every commit
  was refused with `blocker state is unknown
  (blocking_provenance_untrusted)` — including after the blocker was fixed, and
  with no re-run able to clear it (#3282).
