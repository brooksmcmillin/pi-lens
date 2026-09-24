---
section: Fixed
---

- The tool-smoke workflow's SonarCloud master-gate read now runs only on the nightly schedule and on master, so a branch dispatch no longer goes red on master's Sonar state; the advisory targeted-tests CI job installs lockfile-locked and script-free (refs #3319, #3346).
