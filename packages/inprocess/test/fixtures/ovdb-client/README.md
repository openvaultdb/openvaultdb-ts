# Unreleased OVDB CRUD client test fixture

These five TypeScript files are the exact, unmodified CRUD client source closure
from [dal-go/dalgo-http-adapters](https://github.com/dal-go/dalgo-http-adapters/tree/f6a83966646f94d88b62653daeab1b91f95c1efa/packages/ovdb/src)
at commit `f6a83966646f94d88b62653daeab1b91f95c1efa`.

This is an unreleased client fixture for the in-process server's existing HTTP
contract tests. It is not a published client SDK. The registry `@dalgo/ovdb`
package is query-only and does not export this CRUD client.

`provenance.json` records every original path and SHA-256. The MIT `LICENSE`
retains its original text with one trailing blank line removed; its upstream and
normalized hashes are recorded separately. Keep the five source files byte-identical to that upstream commit;
their relative `.js` imports stay inside this fixture. The existing Vitest alias
resolves `@dalgo/core` to the server's registry core instance, preserving error
class identity across the real client and server.

The fixture is outside the production build's `src` root. The package publishes
only `dist` and its package README, so this fixture is not shipped. Coverage still
measures all production `src/**/*.ts` with the existing 100% thresholds.
