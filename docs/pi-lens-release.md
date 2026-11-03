<important if="building, packaging, or releasing">

## Build, packaging, and release

`main` and `pi.extensions` point to `dist/index.js`; `dist/` is generated and
not committed. `prepare` builds it for git and package installs. `build:dist`
bundles pure-JS dependencies while keeping host-provided and lazy native
packages external. Package-root resource resolution is depth-robust; pi
resolves `pi.skills` entries relative to the package root, so manifests use
`"./skills"` and never an escaping path.

Runtime imports must be production dependencies. The pi SDK is an optional
peer/dev dependency and must be imported type-only. Lockfiles use the pinned
npm version. Release notes use one `.changelog/<slug>.md` fragment per PR
(`audience: user` or `internal`; the release body lists only `user`); never
edit `CHANGELOG.md` for ordinary PR notes. Upstream syncs retain unchanged
imported fragments; `check-changelog-fragments.mjs --upstream <trusted-ref>`
excludes only shared-ancestor records from the count, never schema validation.
CI pins the upstream repository; see `.changelog/README.md`.
New user-facing fragments begin with a bold lead of at most 100 characters
(issue references are excluded from the count); internal fragments are exempt.

</important>
