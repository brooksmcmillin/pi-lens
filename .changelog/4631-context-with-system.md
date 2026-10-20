---
section: Fixed
audience: user
---

- **Prompt-cache reuse survives injected findings on pi 0.87+**: pi-lens now injects through the host's `context_with_system` hook, whose returned list pi uses verbatim, so the system head stays byte-identical and the cached prefix is not rebuilt. On an older host the `context` hook still injects. Before this, a session holding a mid-list system message (pi adds one whenever prompt sections or tools change, for example after `pi_lens_activate_tools`) lost the whole cached prefix on every injecting turn (#4631).
