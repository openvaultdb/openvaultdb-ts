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
| `POST`, `GET /v1/databases/{db}/dtql` | DTQL document of one plain collection, with result snapshot paging |
| `POST /v1/databases/{db}/reset` | restore a resettable database (in-process only) |

DALgo errors are answered as the Go server answers them: `NotFoundError` is
`404 not_found`, `AlreadyExistsError` is `409 already_exists`, a storage
constraint the adapter refuses is `409 constraint_violation`, and
`UnsupportedError` is `422 not_supported`. A relational DTQL document is
`422 join_engine_unsupported`.

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
