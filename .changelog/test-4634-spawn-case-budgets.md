---
section: Fixed
audience: internal
---

- **Wall-clock budgets scale with the host's load (#4634)** — Every case in
  `tests/tools/diagnostics-route-switch-matrix.test.ts` now carries an explicit
  `scaledTestTimeout` budget instead of vitest's 5 s default, the matrix's
  write-time cell judges only the latency reports its own writes produced, and
  the mkdtemp whole-tree scan in `tests/config/tmp-fixture-hygiene.test.ts` takes
  60 s. The `default` Vitest project declares the 60 s `hookTimeout` its six
  sibling projects already use, which ends the 10 s `beforeAll` ceiling a
  whole-`clients/` scan red on. Round 2 gives the same treatment to the tree-walk
  census in `tests/clients/pi-lens-home-hermeticity.test.ts` and
  `tests/config/vacuous-skip-coverage.test.ts`, to the wedged-notify rename case
  in `tests/clients/lsp/rename-notify-wedged.test.ts`, and to the five unbudgeted
  real-pi cases in `tests/real-harness/tools-enabled.test.ts` (whose four
  budgeted siblings take the same scaled spelling, so the file has one budget),
  and the
  `expect.poll` waits on a real pi child in `tests/real-harness/lifecycle.test.ts`
  now take a scaled 10 s poll budget instead of Vitest's 1 s poll default. No
  product behaviour changes.
