import { AlreadyExistsError, UnsupportedError, collection, collectionGroup, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { OpenVaultDbDatabase } from "../src/index.js";

interface Item {
  readonly title: string;
  readonly done: boolean;
  readonly rank: number;
}

type Handler = (request: Request) => Response | Promise<Response>;

function mockFetch(handler: Handler): { readonly fetch: typeof globalThis.fetch; readonly requests: Request[] } {
  const requests: Request[] = [];
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  };
  return { fetch: fetcher, requests };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const items = collection<Item>("items");

describe("OpenVaultDbDatabase", () => {
  it("gets records with bearer authentication and represents 404 as missing", async () => {
    const mock = mockFetch((request) => request.url.endsWith("/items/missing")
      ? json({ error: { code: "not_found", message: "missing" } }, 404)
      : json({ key: "items/a%2Fb", data: { title: "Milk", done: false, rank: 1 } }));
    const db = new OpenVaultDbDatabase({
      baseUrl: "http://127.0.0.1:6832",
      databaseId: "my db",
      accessToken: "secret",
      fetch: mock.fetch,
    });

    const record = await db.get<Item>(items.key("a/b"));
    expect(record.exists && record.data.title).toBe("Milk");
    expect(mock.requests[0]?.url).toContain("/v1/databases/my%20db/records/items/a%2Fb");
    expect(mock.requests[0]?.headers.get("Authorization")).toBe("Bearer secret");
    expect((await db.get(items.key("missing"))).exists).toBe(false);
  });

  it("maps collection queries and decodes hierarchical response keys", async () => {
    const mock = mockFetch(() => json({
      records: [{ key: "spaces/home/items/milk", data: { title: "Milk", done: false, rank: 1 } }],
    }));
    const db = new OpenVaultDbDatabase({ baseUrl: "https://db.example", databaseId: "todos", fetch: mock.fetch });
    const nested = items.in(key("spaces", "home"));
    const result = await db.query(nested.query().where("done", "==", false).orderBy("rank", "desc").limit(10).build());

    expect(result.records[0]?.key.path).toBe("spaces/home/items/milk");
    expect(await mock.requests[0]?.json()).toEqual({
      collection: "items",
      parent: "spaces/home",
      where: [{ field: "done", op: "==", value: false }],
      orderBy: [{ field: "rank", desc: true }],
      limit: 10,
    });
  });

  it("buffers writes and commits one atomic batch with read-your-writes", async () => {
    const mock = mockFetch(() => new Response(null, { status: 200 }));
    const db = new OpenVaultDbDatabase({ baseUrl: "https://db.example", databaseId: "todos", fetch: mock.fetch });
    const result = await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("milk"), { title: "Milk", done: false, rank: 1 });
      await transaction.update(items.key("milk"), { done: true });
      const current = await transaction.get<Item>(items.key("milk"));
      expect(current.exists && current.data.done).toBe(true);
      await transaction.delete(items.key("old"));
      return "committed";
    });

    expect(result).toBe("committed");
    expect(mock.requests).toHaveLength(1);
    expect(await mock.requests[0]?.json()).toEqual({
      ops: [
        { op: "set", key: "items/milk", data: { title: "Milk", done: false, rank: 1 } },
        { op: "update", key: "items/milk", updates: [{ fieldName: "done", value: true }] },
        { op: "delete", key: "items/old" },
      ],
    });
  });

  it("does not send buffered writes when the callback fails", async () => {
    const mock = mockFetch(() => new Response(null, { status: 200 }));
    const db = new OpenVaultDbDatabase({ baseUrl: "https://db.example", databaseId: "todos", fetch: mock.fetch });
    await expect(db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("milk"), { title: "Milk", done: false, rank: 1 });
      throw new Error("stop");
    })).rejects.toThrow("stop");
    expect(mock.requests).toHaveLength(0);
  });

  it("maps batch insert conflicts to AlreadyExistsError", async () => {
    const mock = mockFetch(() => json({ error: { code: "already_exists", message: "exists" } }, 409));
    const db = new OpenVaultDbDatabase({ baseUrl: "https://db.example", databaseId: "todos", fetch: mock.fetch });
    await expect(db.runReadwriteTransaction(async (transaction) => {
      await transaction.insert(items.key("milk"), { title: "Milk", done: false, rank: 1 });
    })).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("fails unsupported server query features before making a request", async () => {
    const mock = mockFetch(() => json({ records: [] }));
    const db = new OpenVaultDbDatabase({ baseUrl: "https://db.example", databaseId: "todos", fetch: mock.fetch });
    await expect(db.query(collectionGroup<Item>("items").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().offset(1).build())).rejects.toBeInstanceOf(UnsupportedError);
    expect(mock.requests).toHaveLength(0);
  });
});
