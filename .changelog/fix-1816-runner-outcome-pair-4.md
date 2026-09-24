---
section: Fixed
---

- **Share compiler runner outcome parsing (refs #1816)** — Route `javac` and `dotnet-build` through the shared runner outcome parser so failed compiler invocations cannot be reported as clean files.
