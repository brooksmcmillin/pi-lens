# A project data directory as pi-lens 4.1.6 wrote it

pi-lens 4.1.6 (tag `v4.1.6`, `1f3d3ef5a`) and every earlier version named a project's data directory `<base>/<readable>`, with no hash. `<readable>` is the absolute root with its separators folded to dashes and every other character stripped. v4.2.0 added the `-<8 hex>` hash. From then on, `settleProjectDataDir` renames the unhashed name of the root it was given into the hashed one.

`alias-mark/` is the directory the 4.1.6 build wrote for a project whose root is spelled through a directory link (`aliasproj -> realproj`). The build was compiled from the tag with `tsc --project tsconfig.build.json`. Two calls, both rooted at the link spelling, wrote it:

- `markDisposition(alias, …, "false-positive", "4.1.6 fixture")` on `aliasproj/src/x.ts`. The tool is `eslint`, the rule `no-bad`, the message `bad call`, line 1, and the content `export const target = bad();`. Its strict anchor is `dd:164197458e2b`, the same anchor 4.4.4 computes (`../data-dir-4.4.4/dispatch-mark`).
- `new CacheManager(false).writeCache("knip", { issues: [] }, alias)`.

The files are copied verbatim, and none holds an absolute path. 4.1.6 left no lock directory behind.

#4689 round 6 (G1): this PR names a link-rooted project's directory from its real path. The spelling's unhashed directory is therefore neither renamed nor read unless it is adopted. `tests/clients/project-data-dir-slug.test.ts` places this directory where 4.1.6 put it (`dataDir416` in `tests/support/data-dir-4-4-4.ts`). It then reads the mark back through `getProjectDataDir` and the real store reader.
