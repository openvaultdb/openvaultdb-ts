# @openvaultdb/inprocess

## 0.1.0

### Minor Changes

- 88db83c: First release: `createOvdbFetch` serves the OpenVaultDB wire subset (discovery, database descriptor, records, batch, query, single-collection TugQL with snapshot paging, reset) over local DALgo databases as a standard `fetch`, and `serveFetchOverPort`/`fetchOverPort` bridge it across a `MessagePort`.
  
  Peer range for `@dalgo/core` is `>=0.7.4 <0.9.0`. The package is published to npm by the release workflow only after this changeset is versioned and merged.
  
  The server refuses prototype-polluting field paths and `__proto__` keys, caps request bodies (`maxBodyBytes`, 413), enforces `read: false` (403 `read_denied`), serves `HEAD` on `GET` routes, validates `/query` operand shapes and reserves snapshot slots atomically. `fetchOverPort` rejects pending requests with `PortClosedError` when the port closes or `dispose()` is called, supports `timeoutMs`, and forwards aborts to the serving side.
- 7a4bce9: TugQL full cutover: the server serves `/v1/databases/{db}/tugql` only (the `/dtql` route is removed), the error code is `invalid_tugql`, the capabilities keys are `tugql`, `tugqlStreaming` and `tugqlStreamingErrors`, the descriptor `endpoints.tugql` and `queryFormat: "tugql-yaml+json"`, and the option `maxDtqlBytes` and export `defaultMaxDtqlBytes` are now `maxTugqlBytes` and `defaultMaxTugqlBytes`. Builds against `@dalgo/core` 0.8.0 and `@dalgo/ovdb` with the `./tugql` export.

### Patch Changes

- 7192052: Fix every POST /query and POST /batch answering HTTP 500 in Firefox, where `Request.body` is `undefined`: the server now falls back to reading the body with `arrayBuffer()` when there is no body stream, still enforcing `maxBodyBytes` (413 `payload_too_large`) from Content-Length and from the bytes read.
