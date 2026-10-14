# openvaultdb-ts
TypeScript SDK for [OpenVaultDB](https://openvaultdb.com/) — DTQL queries, schema management, authentication, and access to user-owned application databases.

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
