# @openvaultdb/inprocess

## 0.1.0

### Minor Changes

- 88db83c: First release: `createOvdbFetch` serves the OpenVaultDB wire subset (discovery, database descriptor, records, batch, query, single-collection DTQL with snapshot paging, reset) over local DALgo databases as a standard `fetch`, and `serveFetchOverPort`/`fetchOverPort` bridge it across a `MessagePort`.
  
  Peer range for `@dalgo/core` is `>=0.7.4 <0.9.0`. The package is published to npm by the release workflow only after this changeset is versioned and merged.
  
  The server refuses prototype-polluting field paths and `__proto__` keys, caps request bodies (`maxBodyBytes`, 413), enforces `read: false` (403 `read_denied`), serves `HEAD` on `GET` routes, validates `/query` operand shapes and reserves snapshot slots atomically. `fetchOverPort` rejects pending requests with `PortClosedError` when the port closes or `dispose()` is called, supports `timeoutMs`, and forwards aborts to the serving side.

### Patch Changes

- 7192052: Fix every POST /query and POST /batch answering HTTP 500 in Firefox, where `Request.body` is `undefined`: the server now falls back to reading the body with `arrayBuffer()` when there is no body stream, still enforcing `maxBodyBytes` (413 `payload_too_large`) from Content-Length and from the bytes read.
