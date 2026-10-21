---
section: Fixed
audience: internal
---

- **A by-path extension load no longer leaves a `jiti` directory at the tmp root (#4673)** —
  pi's loader mkdirs `path.join(os.tmpdir(), "jiti")` in the test process on the
  first by-path extension load, and the shared tmp-root census judged it as a
  fixture sibling of `tests/clients/skills-package-filter.test.ts`, so any run
  that selected that file beside the hygiene sweep red on a name neither file
  spells. The test environment now pins `JITI_FS_CACHE=0` and `JITI_CACHE=0` in
  `tests/support/vitest-setup.ts` and `vitest.config.ts`; the census's two
  comments now say that a CHILD process's write is the case with no creator on
  record, not an in-process loader cache; and a mechanism case in
  `tests/config/tmp-fixture-hygiene.test.ts` drives pi's real
  `DefaultResourceLoader` by path and asserts the tmp root gained nothing. No
  product behaviour changes.
