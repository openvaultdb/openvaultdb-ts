---
"@openvaultdb/inprocess": minor
---

First release: `createOvdbFetch` serves the OpenVaultDB wire subset (discovery, database descriptor, records, batch, query, single-collection DTQL with snapshot paging, reset) over local DALgo databases as a standard `fetch`, and `serveFetchOverPort`/`fetchOverPort` bridge it across a `MessagePort`.

Peer range for `@dalgo/core` is `>=0.7.4 <0.9.0`. The package is published to npm by the release workflow only after this changeset is versioned and merged.

The server refuses prototype-polluting field paths and `__proto__` keys, caps request bodies (`maxBodyBytes`, 413), enforces `read: false` (403 `read_denied`), serves `HEAD` on `GET` routes, validates `/query` operand shapes and reserves snapshot slots atomically. `fetchOverPort` rejects pending requests with `PortClosedError` when the port closes or `dispose()` is called, supports `timeoutMs`, and forwards aborts to the serving side.
