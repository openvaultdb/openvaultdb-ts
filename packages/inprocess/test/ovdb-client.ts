// The @dalgo/ovdb CRUD client is not in its published artifact (0.2.0 packs
// only the DTQL executor), so the contract tests run it from source through
// the dev link of pnpm-workspace.yaml.
export { OpenVaultDbDatabase, OpenVaultDbHttpError } from "../node_modules/@dalgo/ovdb/src/index.js";
