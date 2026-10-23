---
"@openvaultdb/inprocess": minor
---

TugQL full cutover: the server serves `/v1/databases/{db}/tugql` only (the `/dtql` route is removed), the error code is `invalid_tugql`, the capabilities keys are `tugql`, `tugqlStreaming` and `tugqlStreamingErrors`, the descriptor `endpoints.tugql` and `queryFormat: "tugql-yaml+json"`, and the option `maxDtqlBytes` and export `defaultMaxDtqlBytes` are now `maxTugqlBytes` and `defaultMaxTugqlBytes`. Builds against `@dalgo/core` 0.8.0 and `@dalgo/ovdb` with the `./tugql` export.
