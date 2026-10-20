---
section: Changed
audience: internal
---

- Document line addressing has one owner. `clients/lsp/content-scan.ts` counts the document's LF newlines (`countLfNewlines`) with a native walk on every document and serves the last LSP-addressable line, and the LSP sync bound (`exceedsLspSyncLimits`) plus `lineTextAt` now read that owner instead of running `content.split("\n")` themselves — one substring per line, ~40 800 of them on a 1.92 MB document. On a 1.92 MB document (best of 40, interleaved) the bound check drops from 0.61 ms to 0.44 ms on LF content and from 0.62 ms to 0.47 ms on CRLF content, so it no longer pays a per-character walk on any document holding `\r` (#2066); `lineTextAt` drops from 0.43 ms to under 0.01 ms for a line near the top. The #1095 content hash still makes its own native sha256 pass: folding it onto the walk costs 1.16x more on LF content (1.278 ms against 1.104 ms at 1.92 MB), and the walk's `lastLine` answers UTF-16 offsets a byte buffer cannot.
