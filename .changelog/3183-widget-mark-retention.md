---
section: Fixed
---

- **The `suppressed: N` chip counts a mark for as long as the mark stands (closes #3183)** —
  a `false-positive`/`suppress` mark stopped contributing to the pi-lens footer's
  suppressed count at the marked file's next edit, even an edit that left the
  marked line byte-identical and the mark still applying, with no way to get it
  back. The retained row's lifetime is now the mark's own: it stands while the
  marked line is still in the file and is retired when that line changes, the
  file is deleted, a scan reports the finding again, or the per-file retention
  cap truncates it. A second finding of the same rule with the same message no
  longer displaces the marked one, and `lens_diagnostics mode=all` never lists a
  marked finding as a live warning.
