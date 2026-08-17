---
section: Fixed
---

- **Knip's per-turn delta no longer reads a shifted finding as newly unused ([#1483](https://github.com/apmantza/pi-lens/issues/1483))** — the finding key included the line number, and the delta is filtered to exactly the files the edit touched, so lines shifted by that same edit landed right where the filter looks. A finding that only moved down now keys the same as before and drops out of the delta; a genuinely new finding still appears. The key now shares `stableFindingKey` with the dead-code delta ([#1477](https://github.com/apmantza/pi-lens/issues/1477)), which had the identical bug and the identical fix — one rule, one place, for both scanners.
