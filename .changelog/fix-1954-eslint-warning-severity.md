---
section: Fixed
---

- **ESLint warnings are no longer discarded (closes #1954)** — The eslint runner treated every exit 0 as "nothing found". ESLint exits 0 whenever no rule reaches error severity, so a run that produced only warning-severity findings was thrown away silently. The runner now parses stdout unconditionally and surfaces the findings; a clean file still reports clean, and exit 2 stays an unavailable skip.
