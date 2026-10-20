---
section: Changed
audience: internal
---

- **Registration tests read pi's real extension runner (#4632).** `tests/support/pi-runner.ts` loads the built extension through pi's own loader into a real `ExtensionRunner`, pins `PI_LENS_HOME` and `PILENS_DATA_DIR` before the load, keeps the loader's `jiti` cache inside the fixture, and drains the test-side writers in `afterAll`; four tool-roster, registry, schema and contract-pin files now assert the registries the host holds instead of the arguments a stand-in recorded. The helper runs on all six certified hosts, and its own contract test pins the declared handler, flag and command sets beside the host metadata each registration comes from.
