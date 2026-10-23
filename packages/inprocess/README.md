# @openvaultdb/inprocess

An in-process OpenVaultDB server exposed as a standard `fetch`. Any OVDB HTTP
client, such as the `@dalgo/ovdb` client, can read and write a local DALgo
database through it with no network, for example a SQLite database running in
the browser.

```ts
import { createOvdbFetch } from "@openvaultdb/inprocess";

const fetch = createOvdbFetch({
  databases: { chinook: chinookDatabase }, // any DALgo Database
});
const response = await fetch("https://local.ovdb.invalid/v1/databases/chinook/records/Artist/1");
```

`baseUrl` defaults to `https://local.ovdb.invalid`. A request to any other
origin is rejected, so the fetch never reaches the network.

## Installing

Requires `@dalgo/core` `>=0.7.4 <0.9.0` as a peer. The supported package
manager is pnpm 11; npm is not supported. This package is released through the
changesets workflow of this repository, so it is on npm only once a release has
been published. `@dalgo/core` with the capabilities types, and the `@dalgo/ovdb`
CRUD client used by this repository's tests (`@dalgo/ovdb/client`), are not yet
published, so this repository and any consumer of unreleased builds pin them
from GitHub:

```jsonc
// package.json
"@dalgo/core": "github:dal-go/dalgo-js#24eb5b7ef8f044c274cb33beda353b2413e17c42",
"@dalgo/ovdb": "github:dal-go/dalgo-http-adapters#28bc59754f068335d08fb31c7aae5216b9f8bf56&path:/packages/ovdb"
```

```yaml
# pnpm-workspace.yaml: the GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/24eb5b7ef8f044c274cb33beda353b2413e17c42': true
  '@dalgo/ovdb@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/28bc59754f068335d08fb31c7aae5216b9f8bf56#path:/packages/ovdb': true
```

pnpm records no integrity hash for a GitHub tarball, so these pins are
trusted by their full commit SHA and the HTTPS download alone. That is
accepted until both packages are published to npm, when the pins go.

## Capabilities

The database descriptor (`GET /v1/databases/{db}`) and discovery
(`GET /.well-known/openvaultdb`) report the capabilities each database gives
through `capabilities()` (`@dalgo/core` `CapabilityAware`). A database without
it is reported as readable, queryable, writable, not resettable and not
persistent. `joins` and `aggregation` are always `false`: only documents of one
plain collection run.

A database whose capabilities say `write: false` answers every write with
`403 read_only`, exactly as `ovdb serve --read-only` does; `delete: false`
refuses deletes the same way. A database that implements `reset()`
(`Resettable`) also reports the `canonical` source and `localState` given to
`createOvdbFetch`, and `POST /v1/databases/{db}/reset` restores it when its
capabilities say `reset: true`.

## Routes

The routes, statuses, headers and error envelopes are those of `ovdb serve`
(see `docs/api.md` of openvaultdb-go):

| Route | Answer |
| --- | --- |
| `GET /.well-known/openvaultdb` | discovery: databases, `apiUrl`, capabilities |
| `GET /v1/databases/{db}` | descriptor with `capabilities` (and `canonical`, `localState` when resettable) |
| `GET`, `HEAD`, `PUT`, `POST`, `PATCH`, `DELETE /v1/databases/{db}/records/{key...}` | read, exists, set, insert, update, delete |
| `POST /v1/databases/{db}/batch` | ops applied in order in one DALgo read-write transaction |
| `POST`, `GET /v1/databases/{db}/query` | structured query of one collection |
| `POST`, `GET /v1/databases/{db}/tugql` | TugQL document of one plain collection, with result snapshot paging |
| `POST /v1/databases/{db}/reset` | restore a resettable database (in-process only) |

DALgo errors are answered as the Go server answers them: `NotFoundError` is
`404 not_found`, `AlreadyExistsError` is `409 already_exists`, a storage
constraint the adapter refuses is `409 constraint_violation`, and
`UnsupportedError` is `422 not_supported`. A relational TugQL document is
`422 join_engine_unsupported`.

Beyond the Go server's behaviour, this server also:

- refuses a request body over `maxBodyBytes` (default 8 MiB) with
  `413 payload_too_large`, while reading it, and a TugQL document over
  `maxTugqlBytes` (default 256 KiB) the same way, before any YAML parsing, since
  the YAML library parses a whole document before its depth can be checked;
- refuses a TugQL document nested deeper than 256 levels (flow or block style)
  with `400 invalid_tugql` from a linear pre-parse scan, parses it with the core
  schema only (no custom tags, merge keys or duplicate keys; duplicates are
  found in linear time) and refuses an unresolved or mismatched tag
  (`!!js/function`, `!!float 1`); `maxBodyBytes` and `maxTugqlBytes` must be
  positive safe integers, else `createOvdbFetch` throws a `TypeError`;
- answers `403 read_denied` for reads (record `GET`/`HEAD`, query, TugQL) of a
  database whose capabilities say `read: false` (`ovdb serve` has no such
  denial, so the code is this server's own);
- refuses field paths through `__proto__`, `constructor` or `prototype`, and
  record bodies or update values holding a `__proto__` key, with
  `400 bad_request`, so a request cannot reach `Object.prototype`;
- answers `HEAD` on `GET` routes with the status and headers of `GET`.

## Across a MessagePort

To run the databases in a worker and the client on the main thread:

```ts
// worker
serveFetchOverPort(createOvdbFetch({ databases }), port);

// main thread
const fetch = fetchOverPort(port);
```

Requests and responses cross the port as method, URL, headers and an
ArrayBuffer body.

`fetchOverPort(port, { timeoutMs })` returns a `fetch` with a `dispose()`
method. Every pending request rejects with `PortClosedError` when the port
emits `close` or `dispose()` is called, and with a `TimeoutError` after
`timeoutMs` (off by default). Aborting a request aborts it on the serving side
too, and its late response is dropped.
