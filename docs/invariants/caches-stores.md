<important if="touching caches, stores, and project intelligence rules">

### Caches, stores, and project intelligence

- Behavior-gating durable stores use `clients/durable-store.ts`: lock, re-read,
  merge the caller delta, atomically publish, refresh coupled mirrors before
  releasing the lock. Best-effort derived caches declare their loss policy.
- Every cache states its freshness axes, bound, eviction axis, and invalidation
  source. A bounded entry count does not excuse unbounded bytes, timers, WASM
  objects, or persisted evidence.
- Workspace diagnostics cache mtime-drift hashing is limited by
  `CONTENT_HASH_MAX_BYTES` in `clients/content-stamp.ts`; larger entries retain
  strict mtime invalidation. Persistent reverify keeps zero mtime tolerance;
  session-state restore keeps its 1 ms tolerance.
- Tree-sitter's `queryBatchCache` is invalidated by `clearWasmInput` when a
  trapped query heals, because an in-flight batch may have cached a result that
  omitted the healed rule (#3834).
- Async publication carries a generation or epoch and checks it before and
  after awaited work. Graph snapshots are immutable by replacement.
- Review-graph, snapshot, reverse-dependency, word-index, and call-graph data
  use path identities and explicit partial-coverage markers. A capped walk is
  lower-bound evidence, never a clean zero.
- Tree-sitter uses the shared client and file-major project passes. Grammar
  crashes are blocked before load; source overrides record package/version
  provenance. Real grammar and rule tests use the warmed shared client.
- `module_report` and `symbol_search` are read-only orientation surfaces.
  `read_symbol` and `read_enclosing` return bodies and record pi read coverage;
  outlines do not claim body coverage. MCP adapters call `lens-engine.ts` only.

</important>
