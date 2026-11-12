---
section: Added
audience: user
---

- **Release worktree resources without exiting Pi.** Await owned language-server shutdown through `pilens:workspace:release` before Git cleanup. Fence late acquisitions through path aliases, preserve other workspaces even while a target server is still starting, and report teardown errors. The hot-path benchmark host supports the release event bus.
