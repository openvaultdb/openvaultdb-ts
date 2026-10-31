# @openvaultdb/client

OpenVaultDB HTTP client implementing the DALgo database contracts. Use it for
record reads, queries and buffered write transactions against an OpenVaultDB
server or an in-process fetch transport.

```ts
import { OpenVaultDbDatabase } from "@openvaultdb/client";

const database = new OpenVaultDbDatabase({
  baseUrl: "https://your-openvaultdb.example",
  databaseId: "demo",
  getAccessToken: async () => "your-access-token",
});
```

Requires `@dalgo/core >=0.8.0 <0.9.0`. The root export preserves the API formerly
available from the Git-only `@dalgo/ovdb/client` subpath; update that import to
`@openvaultdb/client`. The registry `@dalgo/ovdb` package remains the separate
TugQL executor.

The implementation and contract tests originate in
[dal-go/dalgo-http-adapters](https://github.com/dal-go/dalgo-http-adapters/tree/af8218ae07e752be25b65853a0819e2f9c7b7ed9/packages/ovdb).
See `provenance.json` for exact file hashes and `LICENSE` for the retained MIT
licence. The initial package preserves source behaviour, including finite
response budgets, token callbacks, error translation and provider-read checks.
