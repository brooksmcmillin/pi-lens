# didSave

`textDocument/didSave` after a content push, for servers that declared
`textDocumentSync.save` (Expert compiles the project on save; opengrep rescans
on save). Writers: pi's post-write sync, the explicit `lsp_diagnostics` query
and the MCP analysis's first touch (`analyzeFile`, the route the MCP
PostToolUse hooks and `pilens_analyze` share). Scenario:
`scripts/scenarios/lsp-did-save.mjs`.

## Sub-features

- The save gate: no `save` capability, no didSave (`sendDidSave` in
  `clients/lsp/client.ts`); `includeText` per the server's declaration.
- The MCP analysis route declares its touch a save (#3405).
- The touch debounce keeps the save: a saved touch over an unsaved push of the
  same bytes sends the save alone (`notify.save`), not a second push (#3405).

## How to get to it (user POV)

An agent edits a file through an MCP host; a server that answers only after a
save (Expert) reports the new finding in the same turn instead of staying
silent until a later edit.

## Driving it with the MCP layer

Needs a clangd binary (it declares `save`): `VERIFY_CLANGD_DIR=<dir holding
clangd>`. The scenario mirrors clangd's input with `--input-mirror-file`, so the
wire log is clangd's own view.

`scripts/verify.mjs drive lsp-did-save analyze`:

- **Goal, `analyze`: an MCP analysis of a C file sends clangd a didSave after
  its push, and again after an on-disk edit.**
  - Control: a `pilens_diagnostics` query on `a.c` answers `undeclared_a` and
    the wire carries its didSave (the capture sees saves).
  - `pilens_analyze b.c` puts a didSave for `b.c` on the wire.
  - After the edit, one more didSave for `b.c`, after the first push of the
    new bytes.

## Gotchas

- clangd publishes on change, so its answer does not prove the save landed;
  read the wire. A save-only server is the unit double in
  `tests/mcp/server.smoke.test.ts` (fake server, `FAKE_LSP_PUBLISH_ON_SAVE`).
- The dispatch runner touches with `clientScope: "with-auxiliary"`, a separate
  debounce key, so it re-pushes the same bytes after the analysis's push (the
  residual the #3405 PR names). Count saves, not pushes.
