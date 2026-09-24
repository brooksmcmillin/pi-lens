---
section: Fixed
---

- **Two case-distinct workspaces no longer share one warm-IPC endpoint (closes #3255)**
  — the per-workspace id behind the warm socket/pipe and the
  `pi-lens-turn-end-*.json` status file lowercased the resolved cwd on every
  platform, so on a case-sensitive filesystem `/repo/Alpha` and `/repo/alpha`
  collided: a PostToolUse or Stop hook in one project could reach the other
  project's warm server, and `pilens_health` reported one workspace's turn-end
  activity under the other's name. The fold now runs only on the platforms
  whose filesystem folds case (Windows, macOS), where it is what lets the
  server and the hook meet. On Linux and the BSDs the id changes for any
  workspace path containing an uppercase letter, so the upgrade is now
  reported rather than silent: a warm endpoint with nothing listening is its
  own skip reason (`no-listener`) instead of the generic `ipc-error`, the Stop
  hook prints and records it for `pilens_health` with the remedy (an MCP
  server that was already running owns the previous endpoint name — restart
  it), and a warm-attached session records it once per session, now also shown
  by `/lens-health`. A status file written before the upgrade is simply left
  alone: it is no longer derived by anything, and on a case-sensitive host that
  name can belong to a live case-variant sibling workspace.
