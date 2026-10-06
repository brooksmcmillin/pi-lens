---
section: Changed
audience: user
---

- **Ten more language servers release idle memory (refs #3952)** — `bash`, `clojure`, `cpp`, `css`, `deno`, `fish`, `html`, `php`, `prisma`, and `yaml` now join the existing idle-eviction set, so an idle client is released after the shared 20-minute window and rebuilds on the next request. The nightly fixture measured ~82–282 MB resident and ~0.5–1.2 s cold per server; those are fixture measurements, not a deployment guarantee.
