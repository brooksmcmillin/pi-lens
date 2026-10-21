---
section: Changed
audience: internal
---

- **The session tier of the real-host test seam (#4632): a real pi `AgentSession` over the built `index.js`, with a scripted provider at the boundary.** `tests/support/pi-session.ts` runs pi's own loader over the compiled extension, so a case asserts what the host and the scripted model actually received instead of what a handler was handed; three files moved their session-flow cases onto it (injection placement on a real turn, the `session_start_total` classification row, and the primary release at shutdown), and the helper's own contract test pins the tool-call round trip, resume from the persisted session file, and the effects of the loaded copy's own `session_shutdown` handler (its primary release and its settled sinks).
