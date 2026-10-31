import { describe, expect, it } from "vitest";
import { keyFromOpenVaultDbPath } from "../src/index.js";

describe("OpenVaultDB key paths", () => {
  it("reconstructs nested DALgo keys and custom escaped ids", () => {
    const recordKey = keyFromOpenVaultDbPath("spaces/home/items/a%2Fb%2Ejson");
    expect(recordKey.id).toBe("a/b.json");
    expect(recordKey.parent?.id).toBe("home");
    expect(recordKey.path).toBe("spaces/home/items/a%2Fb%2Ejson");
  });

  it("rejects malformed paths", () => {
    expect(() => keyFromOpenVaultDbPath("spaces/home/items")).toThrow("invalid OpenVaultDB record path");
  });
});
