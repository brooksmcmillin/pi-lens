---
section: Changed
---

- Folded three hand-rolled path-key transformations in the LSP server, LSP
  launch and tool-call seams onto `clients/path-utils.ts` and added a
  comment- and string-blanked source sweep that pins every remaining raw `\` → `/` fold and
  path-key case fold per file, so a new copy fails CI (refs #1193). The PATH
  entry dedupe key now parses with `path.win32`/`path.posix` chosen from its own
  `platform` argument instead of the host default, so two spellings of one
  Windows directory dedupe on every lane.
