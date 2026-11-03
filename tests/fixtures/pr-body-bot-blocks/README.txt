# Bot blocks appended to a PR body (#4774)

A bot that edits a PR body appends its block after the author's last section.
Each fixture is captured text, unedited.

- 4767.body.txt: the whole body of PR 4767 as GitHub stored it on
  2026-10-23. It ends with Greptile's block (`<!-- greptile_comment -->`),
  whose "Last reviewed commit" link quotes the commit title
  `test: sweep uses shared walker (refs #43...`. The check read `#43` as a
  `## Fold check` candidate with no decision (run 39863184911).
- 4680.coderabbit-block.txt: the block CodeRabbit appended to PR 4680
  (captured 2026-10-23, 28 of the last 200 PR bodies carry one). Its marker
  differs from Greptile's and the block holds a markdown heading.
