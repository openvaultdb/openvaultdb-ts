---
"@openvaultdb/client": minor
---

Publish the existing OpenVaultDB HTTP CRUD client as its own package, preserving
its DALgo contracts and runtime behaviour. Replace the in-process server's
copied test fixture with the workspace client for cross-package contract tests.
