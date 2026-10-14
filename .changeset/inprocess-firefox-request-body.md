---
"@openvaultdb/inprocess": patch
---

Fix every POST /query and POST /batch answering HTTP 500 in Firefox, where `Request.body` is `undefined`: the server now falls back to reading the body with `arrayBuffer()` when there is no body stream, still enforcing `maxBodyBytes` (413 `payload_too_large`) from Content-Length and from the bytes read.
