# Diff-keyed PR-body recurrence captures (#4585)

Each numbered fixture retains the historical body, diff and post-images for
that PR. The JSON metadata pins the audited head and body edit timestamp.
Bodies came from GitHub's `userContentEdits` history; diffs compare the head
against its historical merge base. Source maps retain the blobs named by each
diff so CI does not need the historical commits in a shallow checkout.

- 4577: row 1, audited head 64918f7e8, body 2026-10-17T17:10:46Z.
- 4575: row 2, audited head af1a3eee3, body 2026-10-17T18:57:49Z;
  review comment 4304045025. The mutation section names the built files and
  claims reds in table cells, but quotes no failing mutation run.
- 4566: row 4, audited head 3446d8e4a, body 2026-10-17T19:25:44Z;
  review comment 4304149666. Windows execution remains promised to CI.

Row 3 is reviewer judgement under issuecomment 6241755363. No model-fidelity
assertion is made by this lint.

Historical bodies contain citations outside these changed source maps. The
regression tests deny Git reads for uncaptured paths and assert only the new
compliance messages; citation and structural rules retain their own tests.
