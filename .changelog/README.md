# Per-entry changelog files

Each user-facing change gets one Markdown file in this directory. The file name
must be `<branch-or-slug>-<short-desc>.md`, for example
`feat-1321-changelog-entries.md`.

A PR adds at most one new fragment. Upstream syncs preserve imported records:
`check-changelog-fragments.mjs --base <base> --upstream <trusted-ref>` excludes
only additions unchanged from HEAD's common ancestor with that ref. CI fetches
`apmantza/pi-lens` master explicitly and keeps full history; local sync checks
may use the verified `upstream/master` ref. Edited imports and untracked notes
still count, and every entry still passes schema validation. Missing comparison
history fails the check rather than skipping it. For a local sync, use
`npm run preflight -- --upstream upstream/master` after verifying that ref;
ordinary preflight remains strict unless this option is explicitly supplied.

Use YAML front matter to select one Keep a Changelog section, followed by one
entry in any of the repository's existing styles:

```markdown
---
section: Fixed
audience: user
---

- **Short title (closes #1321)** — Explain the user-visible change.
```

`section` must be `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or
`Security`. `audience` is required: `user` for anything a pi-lens user or an
agent using pi-lens can observe (tools, diagnostics, messages, config, install,
performance, a fixed bug they could hit), `internal` for CI, tests, `formal/`,
contributor docs, orchestration and refactors with no observable change. The
GitHub release body lists only `user` entries plus a one-line internal count;
`CHANGELOG.md` keeps the `internal` ones in a collapsed `### Internal` block.
The entry may use a `-` or `*` bullet, bold or plain text, and an
em dash, period, or no title separator. Continuation lines and nested bullets
are preserved; each file must contain exactly one top-level entry.

Entry files must land through a PR even though the repository permits direct
pushes for other docs-only changes. At version-bump time,
`npm run changelog:release` folds the populated `Unreleased` section and every
entry file into the new version section, then removes the entry files while
retaining this README. The tag-time release workflow only verifies that this
rollup has already happened.
