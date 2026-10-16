# openvaultdb-ts
TypeScript SDK for [OpenVaultDB](https://openvaultdb.com/) — DTQL queries, schema management, authentication, and access to user-owned application databases.

## TypeScript SDK and DataTug session storage

[DataTug](https://datatug.app)’s in-progress OpenVaultDB session-storage architecture currently centers on Go; this repository is the separate TypeScript SDK. Read [how DataTug’s development tools were built](https://datatug.app/en/under-the-hood/tools-we-built/).

## Packages

| Package | |
| --- | --- |
| [`@openvaultdb/inprocess`](packages/inprocess) | An in-process OpenVaultDB server exposed as a standard `fetch` over local DALgo databases |

## Development

```sh
pnpm install
pnpm check   # lint, typecheck, tests with 100% coverage, build
```

Every pull request that should release a package includes a changeset
(`pnpm changeset`).
