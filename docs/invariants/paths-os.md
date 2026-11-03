<important if="touching paths, data, and operating systems rules">

### Paths, data, and operating systems

- Use `PathKeyedMap` for path-keyed memory. Choose
  `normalizeEphemeralMapKey` for process-local hot indexes and `normalizeMapKey`
  for long-lived shared state. Preserve original display paths separately.
- Resolve a path's identity once, where it enters (a tool argument, a write
  event, `createDispatchContext`, `FormatService`), and hand it down. The
  widget, delta-baseline and finding stores key a path that is already an
  identity: they keep the syntactic key and resolve nothing per write
  (maintainer decision 2026-10-24; shape 1). A walk or key derived from a caller
  spelling instead answers for the link's project, not the file's.
- A path a host tool was given resolves through `resolveHostToolPath` (the
  base expansion) or `resolveToolCallFilePath` (base plus pi's variant
  ladder), never a bare `path.resolve(base, raw)`; see shape 74.
- Windows-shaped paths use `path.win32` functions. Use `toPosix`,
  `splitPathSegments`, `isUnderDir`, `isSameOrWithin`, `relativeInside`
  (lexical containment with the relative text), `isWithinIdentity`
  (containment on the identity axis), and `isAtOrAboveHomeDir` instead of
  inline separator or containment logic.
- Data and log locations follow **Data directories and logs**; never hardcode
  `.pi-lens` paths in writes or user-facing text.
- Probes and child processes pin `PI_LENS_HOME`, `PILENS_DATA_DIR`, `HOME`, and
  install/log/cache directories to `.probe-home` under the worktree; never the
  maintainer's real home, and never via `TMPDIR`/`TMP`/`TEMP`, which moves the
  vitest harness home into the checkout (#3026).
- Scratch checkouts and `mktemp -d` never land under `/tmp` (tmpfs; #3526). Use
  `~/.local/share/pi-lens-orchestrator/tmp/<lane>` for orchestrator and
  reviewer scratch, `<worktree>/../probes-<pr>` for probes, and
  `.claude/worktrees/` for a fixer's own worktree.
- Vitest also pins `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`
  and `XDG_DATA_HOME` per worker, to a scratch directory under
  `pi-lens-scratch`, so `os.homedir()` and every child a test spawns
  resolve inside it. A test that sets `HOME` itself (`pinFixtureHome`) wins. The
  real home stays reachable only as `REAL_HOME` from `tests/support/vitest-setup.ts`
  (or `os.userInfo()`), and a file that spells either is a named row in
  `tests/support/real-home-readers.ts` with a `// real-home: <reason>` header.
  The managed bin directory refuses to resolve outside a pinned `PI_LENS_HOME`
  (`assertManagedBinDirInsidePinnedHome`, `clients/installer/index.ts`).
- Vitest gives every worker its own `PI_LENS_HOME`, `<run-shared home>/worker-home-<run>-<pid>`
  (#3721); log sinks bind their path at module load, so a `PI_LENS_HOME` assigned
  in `beforeEach`/an `it` body moves nothing. A test process never truncates a log
  under the real `~/.pi-lens` (`isTestProcessTargetingRealHome`); the first refusal
  emits one `process.emitWarning` (visible on stderr) and folds a
  `log-sink-truncate-refused` row into `pilens_health`. `vitest-setup.ts` also pins the orphan-backstop
  directory through `resolveBackstopStateDir` (#3083) when the home IS the
  run-shared one. Explicit per-case homes remain authoritative. Never bypass this
  seam for its lock or stamp.
- Test tmp roots are swept by the worker that made them (#2912):
  `tests/support/vitest-setup.ts` removes every `setupTestEnvironment` root at
  `afterAll` and on SIGTERM; any other straggler reds its owner, so do not widen
  the sweep. Registry: `tests/support/tmp-root-registry.ts`.
- Two vitest invocations may share one `TMPDIR`. An invocation judges and
  sweeps only tmp entries owned by files its own workers loaded (#3314), so a
  tmp fixture names its family in the prefix at its own `mkdtempSync` or
  `setupTestEnvironment` call (#3306).
- New filesystem walkers use shared exclusions and ignore matching, cap
  walk-down work, and use the correct home-ceiling policy for walk-up discovery.

</important>
