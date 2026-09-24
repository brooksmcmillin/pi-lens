---
section: Added
---

- **Read (and edit) the global config from the host's config dir (refs #2457)** — When `PI_CODING_AGENT_DIR` is set, `$PI_CODING_AGENT_DIR/extensions/pi-lens.json` is read when it exists and the legacy `~/.pi-lens/config.json` does not; a file at the legacy default keeps winning while it exists, so current users never move. Settings editors resolve through the same seam and create in the agent-dir location when NEITHER file exists ("edit the one that exists; prefer the new one if neither does"). The canonical default and `PI_LENS_CONFIG_PATH` semantics are unchanged.