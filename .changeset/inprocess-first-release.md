---
"@openvaultdb/inprocess": minor
---

First release: `createOvdbFetch` serves the OpenVaultDB wire subset (discovery, database descriptor, records, batch, query, single-collection DTQL with snapshot paging, reset) over local DALgo databases as a standard `fetch`, and `serveFetchOverPort`/`fetchOverPort` bridge it across a `MessagePort`.

Peer range for `@dalgo/core` is `>=0.7.4 <0.9.0`. The package is published to npm by the release workflow only after this changeset is versioned and merged.
