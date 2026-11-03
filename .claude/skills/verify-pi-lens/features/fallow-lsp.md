# fallow-lsp (opt-in auxiliary)

`fallow-lsp`, the first opt-in, language-scoped auxiliary language server
(#4929). It attaches beside the TypeScript server on JS/TS files only, reports
unused code as advisory warnings, and runs only when the operator turns it on.
Scenario: `scripts/scenarios/fallow-lsp.mjs`.

## Sub-features

- The gate: `fallow.enabled: true` in `~/.pi-lens/config.json` or `--lens-fallow`;
  any other value, a misspelled key or a malformed document is off
  (`isEnabledByConfiguration` in `clients/dispatch/auxiliary-lsp.ts`).
- The install: a pinned archive, sha256-checked before extraction, into
  `<pi-lens home>/tools/fallow-lsp` (`clients/installer/index.ts`).
- The scope: a Python file never attaches it (`extensions` of `FallowServer`).
- Gate off: nothing downloaded, nothing launched, per-edit and turn-end text
  identical to a tree without the server.

## How to get to it (user POV)

An operator who wants unused-export findings sets `fallow.enabled: true`, then
edits a TypeScript file through an MCP host. The next analysis carries a
`fallow:unused-export` warning for an export nothing imports; with the setting
absent the same edit looks exactly as it did before.

## Driving it with the MCP layer

Needs network on the `config` and `flag` variants: the pinned release (about
48 MB) is downloaded into the run's pi-lens home. The binary is not put on PATH
on purpose.

`scripts/verify.mjs drive fallow-lsp <variant>`:

- **Goal, `off`: no config. No fallow finding, no `tools/fallow-lsp`, no fallow
  process, and the turn-end summary names none.** Drive the same variant on an
  old tree (`--tree "$OLD"`) and diff `analyze-last.txt` and `turn-end.txt` in
  the evidence directories after normalising the workspace path and durations.
- **Goal, `config`: `fallow.enabled: true`. The unused export in `src/util.ts`
  comes back as `fallow:unused-export`, the release is installed, a process
  runs, no blocker, and `src/script.py` gets no fallow finding.**
- **Goal, `flag`: the same through the tool's `flags: {"lens-fallow": true}`.**
- **Goal, `bad`: `fallow.enabled: "yes"` behaves as `off`.**

## Gotchas

- The first touch pays the download and the spawn; the scenario retries up to
  eight times, four seconds apart.
- fallow publishes unused-export as an LSP Hint (severity 4); the profile
  raises it to a warning, so `severity: hint` in the raw result is expected.
- `pilens_turn_end` sometimes reports `Turn-end over 0 file(s)` on a master tree
  too (a registration race, not this feature); compare only runs that report one
  file.
- Match findings by `"tool": "fallow"` or `fallow:<rule>`, never a bare
  `fallow`: the workspace path carries the scenario name.
