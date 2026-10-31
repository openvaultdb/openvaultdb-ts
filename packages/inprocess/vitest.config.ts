import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The contract tests import the workspace @openvaultdb/client package. Its
// @dalgo/core import must resolve to this package's copy, so every DALgo error
// class is one module and instanceof checks hold across client and server.
const dalgoCore = fileURLToPath(new URL("./node_modules/@dalgo/core/dist/index.js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@dalgo\/core$/u, replacement: dalgoCore }],
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
