# Release a worktree without exiting Pi

A Pi session launched from the main checkout can leave its own language servers
rooted in a linked worktree. Before removing that worktree, its owning session
can release those resources through the in-process event bus:

```typescript
const request = { root: absoluteWorktreePath, pending: [] as Promise<string[]>[] };
pi.events.emit("pilens:workspace:release", request);
if (request.pending.length === 0) throw new Error("Workspace release unavailable");
const releasedClientKeys = await Promise.all(request.pending);
```

The listener claims the request synchronously by adding its promise. Await every
promise before running normal process-liveness and Git cleanup checks. A rejected
promise means release did not complete; retain the worktree and report the error.
The event does not delete files, unlock worktrees, grant cleanup authorization,
or contact another session. It refuses relative paths and any root containing
the Pi process's working directory.

Release fences new acquisitions for that workspace, joins its pending LSP spawns,
and shuts down primary and auxiliary clients rooted at or below it. Existing
client shutdown cancels watched-file queues and document work; normal retirement
clears client timers and readiness state. Other workspace clients and the Pi
session remain live. Failed client shutdowns remain available for a release retry.
An ancestor client outside the target is not stopped: OS liveness checks remain
the authority for whether removal is safe.

The fence lasts until the LSP service resets, normally on session replacement or
`/reload`. A failed Git cleanup does not automatically re-enable analysis. There
are at most 128 release fences per service generation; further distinct releases
report an error rather than silently evicting a fence. Repeated release is safe.
The degradation ledger records `lsp-workspace-released` once per workspace.

This API releases LSP resources, not arbitrary build jobs or another Pi process.
Do not ignore remaining rooted processes or kill them to force cleanup.
