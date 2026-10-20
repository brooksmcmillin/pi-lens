---
section: Fixed
audience: user
---

- **A grammar load that never settles no longer strands its language (closes #4224).** `Language.load` is now bounded at 30 s. A load that hangs counts as a failed load: the call returns null, one `grammar-blocked` record names the grammar, and the grammar's retry cooldown keeps later calls from waiting out the bound again. Callers that joined the same in-flight rule-batch build settle with it, so the rules for that language no longer stay stuck for the rest of the process. The abandoned load is still watched: an abort that arrives after the bound latches the wasm runtime as it would have on time, and any other late failure adds to the grammar's `grammar-blocked` record. The log line and notice for a timeout now describe a local hang and no longer name a truncated download or a network fix.
