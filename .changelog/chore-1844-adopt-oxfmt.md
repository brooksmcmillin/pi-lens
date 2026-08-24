---
section: Changed
---

- **pi-lens formats its own TypeScript with oxfmt (refs #1844)** — The
  repository now carries an `.oxfmtrc.json` and an `oxfmt` devDependency, and
  an advisory `oxfmt --check` job runs in CI. Because `hasOxfmtConfig` gates
  the oxfmt formatter on exactly that config file, a pi-lens session opened on
  this repository now dispatches oxfmt as the format runner for edited
  TypeScript and JavaScript files.
