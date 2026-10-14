import { NotFoundError, UnsupportedError, key, type Database } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { createOvdbFetch } from "../src/index.js";
import { MapDatabase, ResettableMapDatabase, readOnlyCapabilities, writable } from "./fake-database.js";
import { base, caller, refusal } from "./helpers.js";

const seeded = (): MapDatabase => new MapDatabase(undefined, {
  "users/ann": { name: "Ann", age: 30, tags: ["a"] },
  "users/bob": { name: "Bob", age: 20, tags: ["b"] },
});

/** A DALgo database with no capabilities() and no reset(). */
function plain(db: MapDatabase): Database {
  return {
    get: (key) => db.get(key),
    getMany: (keys) => db.getMany(keys),
    query: (query) => db.query(query),
    runReadwriteTransaction: (callback) => db.runReadwriteTransaction(callback),
  };
}

describe("api.md#authentication-optional-ovdb-serve---auth: GET /.well-known/openvaultdb", () => {
  it("lists every database with its apiUrl and capability flags, joins and aggregation off", async () => {
    const call = caller({ databases: { zeta: plain(new MapDatabase()), alpha: new MapDatabase(readOnlyCapabilities) } });
    const answer = await call("GET", "/.well-known/openvaultdb");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("Cache-Control")).toBe("no-store");
    expect(answer.body).toMatchObject({
      name: "OpenVaultDB", protocol: "openvaultdb/0.1", authEnabled: false,
      query: { format: "dtql-yaml+json", joinEngines: [] },
      databases: [
        { id: "alpha", url: `${base}/ovdb/dbs/alpha`, apiUrl: `${base}/v1/databases/alpha`,
          capabilities: { read: true, write: false, delete: false, joins: false, aggregation: false } },
        { id: "zeta", capabilities: { write: true, delete: true, reset: false, persistent: false } },
      ],
    });
    expect((await call("POST", "/.well-known/openvaultdb")).status).toBe(405);
  });
});

describe("api.md#server--databases: GET /v1/databases/{db}", () => {
  it("describes capabilities from capabilities(), with the DTQL endpoint when queries run", async () => {
    const call = caller({ databases: { demo: new MapDatabase({ ...writable, persistent: true, joins: true }) } });
    expect(await call("GET", "/v1/databases/demo")).toEqual({
      status: 200,
      headers: expect.any(Headers) as unknown,
      body: {
        id: "demo", engine: "inprocess", schemaMode: "schemaless", collections: [],
        capabilities: {
          read: true, query: true, dtql: true, dtqlStreaming: true, dtqlStreamingErrors: false,
          write: true, delete: true, reset: false, persistent: true, joins: false, aggregation: false,
        },
        endpoints: { dtql: `${base}/v1/databases/demo/dtql` },
        queryFormat: "dtql-yaml+json",
      },
    });
  });

  it("adds canonical and localState for a resettable database only", async () => {
    const canonical = { url: "https://demodb.dev/chinook.sqlite", sha256: "ab".repeat(32), bytes: 1024 };
    const call = caller({
      databases: {
        demo: new ResettableMapDatabase({ ...writable, reset: true, query: false }, {}),
        fixed: new MapDatabase(),
        bare: new ResettableMapDatabase({ ...writable, reset: true }, {}),
      },
      canonical: { demo: canonical, fixed: canonical },
      localState: (id) => ({ modified: id === "demo" }),
    });
    const demo = (await call("GET", "/v1/databases/demo")).body as Record<string, unknown>;
    expect(demo).toMatchObject({ capabilities: { reset: true, query: false, dtql: false }, canonical, localState: { modified: true } });
    expect(demo).not.toHaveProperty("endpoints");
    const fixed = (await call("GET", "/v1/databases/fixed")).body as Record<string, unknown>;
    expect(fixed).not.toHaveProperty("canonical");
    expect(fixed).not.toHaveProperty("localState");
    const bare = (await caller({ databases: { bare: new ResettableMapDatabase(writable, {}) } })("GET", "/v1/databases/bare")).body;
    expect(bare).not.toHaveProperty("canonical");
    expect(bare).not.toHaveProperty("localState");
  });

  it("api.md#conventions: 404 not_found for a database that is not mounted or a route it does not serve", async () => {
    const call = caller({ databases: { demo: seeded() } });
    expect(await call("GET", "/v1/databases/nope")).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(await call("GET", "/v1/databases/%E0%A4%A")).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(await call("GET", "/v1/databases/demo/inferred-schema")).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(await call("GET", "/v1/status")).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(await call("GET", "/v1/databases/demo/batch")).toMatchObject({ status: 405, body: refusal("bad_request") });
  });
});

describe("api.md#records", () => {
  it("GET → 200 {key, data} | 404 not_found", async () => {
    const call = caller({ databases: { demo: seeded() } });
    expect(await call("GET", "/v1/databases/demo/records/users/ann")).toMatchObject({
      status: 200, body: { key: "users/ann", data: { name: "Ann", age: 30, tags: ["a"] } },
    });
    expect(await call("GET", "/v1/databases/demo/records/users/zed")).toMatchObject({ status: 404, body: refusal("not_found") });
  });

  it("HEAD → 200 (exists) | 404, with no body", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    expect(await call("HEAD", "/v1/databases/demo/records/users/ann")).toMatchObject({ status: 200, body: undefined });
    expect(await call("HEAD", "/v1/databases/demo/records/users/zed")).toMatchObject({ status: 404, body: undefined });
    expect(await call("HEAD", "/v1/databases/demo/records/users")).toMatchObject({ status: 400, body: undefined });
    db.get = () => Promise.reject(new Error("disk"));
    expect(await call("HEAD", "/v1/databases/demo/records/users/ann")).toMatchObject({ status: 404, body: undefined });
  });

  it("PUT body {data} → 204 set; POST → 201 insert | 409 already_exists", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    expect((await call("PUT", "/v1/databases/demo/records/users/ann", { data: { name: "Anna" } })).status).toBe(204);
    expect(db.store.get("users/ann")?.data).toEqual({ name: "Anna" });
    expect((await call("POST", "/v1/databases/demo/records/users/cid", { data: { name: "Cid" } })).status).toBe(201);
    expect(await call("POST", "/v1/databases/demo/records/users/cid", { data: {} })).toMatchObject({ status: 409, body: refusal("already_exists") });
  });

  it("PUT and POST refuse a body without a data object as 400 bad_request", async () => {
    const call = caller({ databases: { demo: seeded() } });
    for (const body of [{}, { data: null }, { data: [1] }, { data: "x" }, "null", "{nope"]) {
      expect(await call("PUT", "/v1/databases/demo/records/users/ann", body)).toMatchObject({ status: 400, body: refusal("bad_request") });
    }
  });

  it("PATCH body {updates} → 204 | 404 not_found (record must exist) | 400 bad_request", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    const updates = [
      { fieldName: "age", transform: "increment", value: 2 },
      { fieldPath: ["profile", "city"], value: "Oslo" },
      { fieldName: "tags", delete: true },
      { fieldName: "seen", serverTimestamp: true },
    ];
    expect((await call("PATCH", "/v1/databases/demo/records/users/ann", { updates })).status).toBe(204);
    expect(db.store.get("users/ann")?.data).toEqual({ name: "Ann", age: 32, profile: { city: "Oslo" }, seen: expect.stringMatching(/Z$/u) as unknown });
    expect(await call("PATCH", "/v1/databases/demo/records/users/zed", { updates })).toMatchObject({ status: 404, body: refusal("not_found") });
    for (const body of [{ updates: [] }, {}, "null"]) {
      expect(await call("PATCH", "/v1/databases/demo/records/users/ann", body)).toMatchObject({ status: 400, body: refusal("bad_request") });
    }
  });

  it("DELETE → 204, idempotent: 204 even if absent", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    expect((await call("DELETE", "/v1/databases/demo/records/users/ann")).status).toBe(204);
    expect((await call("DELETE", "/v1/databases/demo/records/users/ann")).status).toBe(204);
    expect(db.store.has("users/ann")).toBe(false);
  });

  it("answers another method with 405", async () => {
    const call = caller({ databases: { demo: seeded() } });
    expect(await call("OPTIONS", "/v1/databases/demo/records/users/ann")).toMatchObject({ status: 405, body: refusal("bad_request") });
  });
});

describe("api.md#conventions: record key paths", () => {
  const cases: readonly [string, string][] = [
    ["a missing key", "/records/"],
    ["an odd number of segments", "/records/users"],
    ["an empty segment", "/records/users//x/y"],
    ["a malformed escape", "/records/users/%E0%A4%A"],
    ["a control character", "/records/users/a%01b"],
    ["only path separators", "/records/users/%2F"],
    ["a decoded ../ component", "/records/users/%2E%2E%2F%2E%2E%2Fp2"],
    ["a \\ separated .. component", "/records/users/a%5C..%5Cb"],
    ["a collection DALgo refuses", "/records/a%2Fb/x"],
  ];
  for (const [name, path] of cases) {
    it(`400 invalid_key for ${name}`, async () => {
      const call = caller({ databases: { demo: seeded() } });
      expect(await call("GET", `/v1/databases/demo${path}`)).toMatchObject({ status: 400, body: refusal("invalid_key") });
    });
  }

  it("unescapes each segment, so an escaped id survives as data", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    expect((await call("PUT", "/v1/databases/demo/records/users/a%2Eb%2Fc/", { data: { ok: true } })).status).toBe(204);
    expect(await call("GET", "/v1/databases/demo/records/users/a%2Eb%2Fc")).toMatchObject({ body: { key: "users/a%2Eb%2Fc" } });
    expect([...db.store.values()].map(({ key }) => key.id)).toContain("a.b/c");
  });
});

describe("api.md#batch-transaction-commit: POST /v1/databases/{db}/batch", () => {
  it("→ 200 {applied}: ops apply in order with read-your-writes", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    const answer = await call("POST", "/v1/databases/demo/batch", {
      message: "seed",
      ops: [
        { op: "set", key: "users/cid", data: { name: "Cid", age: 1 } },
        { op: "update", key: "users/cid", updates: [{ fieldName: "age", transform: "increment", value: 1 }] },
        { op: "insert", key: "users/dan" },
        { op: "set", key: "users/eve" },
        { op: "update", key: "users/eve" },
        { op: "delete", key: "users/bob" },
      ],
    });
    expect(answer).toMatchObject({ status: 200, body: { applied: 6 } });
    expect(db.store.get("users/cid")?.data).toEqual({ name: "Cid", age: 2 });
    expect(db.store.get("users/dan")?.data).toEqual({});
    expect(db.store.has("users/bob")).toBe(false);
  });

  it("rejects the whole batch on any failure: nothing is written", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    const answer = await call("POST", "/v1/databases/demo/batch", {
      ops: [{ op: "set", key: "users/cid", data: {} }, { op: "update", key: "users/zed", updates: [] }],
    });
    expect(answer).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(db.store.has("users/cid")).toBe(false);
  });

  const refusals: readonly [string, unknown, string][] = [
    ["a body that is not an object", [1], "bad_request"],
    ["an empty ops array", { ops: [] }, "bad_request"],
    ["an op that is not an object", { ops: [1] }, "bad_request"],
    ["an op without a key", { ops: [{ op: "set" }] }, "invalid_key"],
    ["an unsafe key", { ops: [{ op: "set", key: "users/.." }] }, "invalid_key"],
    ["an unknown op", { ops: [{ op: "upsert", key: "users/x" }] }, "bad_request"],
    ["data that is not an object", { ops: [{ op: "set", key: "users/x", data: [] }] }, "bad_request"],
    ["updates that are not an array", { ops: [{ op: "update", key: "users/x", updates: {} }] }, "bad_request"],
    ["malformed JSON", "{", "bad_request"],
  ];
  for (const [name, body, code] of refusals) {
    it(`400 ${code} for ${name}`, async () => {
      const call = caller({ databases: { demo: seeded() } });
      expect(await call("POST", "/v1/databases/demo/batch", body)).toMatchObject({ status: 400, body: refusal(code) });
    });
  }
});

describe("api.md#update-operation-object", () => {
  const patch = async (data: Record<string, unknown>, updates: unknown[]) => {
    const db = new MapDatabase(undefined, { "users/u": data });
    const answer = await caller({ databases: { demo: db } })("PATCH", "/v1/databases/demo/records/users/u", { updates });
    return { answer, data: db.store.get("users/u")?.data };
  };

  it("sets nested fields, creating maps and replacing nulls", async () => {
    const { data } = await patch({ a: null }, [{ fieldPath: ["a", "b", "c"], value: 1 }, { fieldName: "n", transform: "increment", value: 3 }]);
    expect(data).toEqual({ a: { b: { c: 1 } }, n: 3 });
  });

  it("deletes a field, and deleting under a missing or scalar parent is a no-op", async () => {
    const { data } = await patch({ a: { b: 1, c: 2 }, s: 1 }, [
      { fieldPath: ["a", "b"], delete: true },
      { fieldPath: ["x", "y"], delete: true },
      { fieldPath: ["s", "y"], delete: true },
    ]);
    expect(data).toEqual({ a: { c: 2 }, s: 1 });
  });

  const refused: readonly [string, unknown][] = [
    ["both fieldName and fieldPath", { fieldName: "a", fieldPath: ["a"], value: 1 }],
    ["neither fieldName nor fieldPath", { value: 1 }],
    ["an empty path segment", { fieldPath: ["a", ""], value: 1 }],
    ["an update that is not an object", 5],
    ["a path through a scalar", { fieldPath: ["s", "x"], value: 1 }],
    ["an increment by a non-number", { fieldName: "n", transform: "increment", value: "1" }],
    ["an increment of a non-number", { fieldName: "s", transform: "increment", value: 1 }],
    ["an unknown transform", { fieldName: "n", transform: "append", value: 1 }],
  ];
  for (const [name, update] of refused) {
    it(`400 bad_request for ${name}`, async () => {
      const { answer } = await patch({ s: "text", n: 1 }, [update]);
      expect(answer).toMatchObject({ status: 400, body: refusal("bad_request") });
    });
  }
});

describe("api.md#query: read-only mode → 403 read_only", () => {
  it("refuses every record and batch mutation of a database whose capabilities say write:false", async () => {
    const db = new MapDatabase(readOnlyCapabilities, { "users/ann": { name: "Ann" } });
    const call = caller({ databases: { demo: db } });
    for (const [method, path, body] of [
      ["PUT", "/records/users/ann", { data: {} }],
      ["POST", "/records/users/x", { data: {} }],
      ["PATCH", "/records/users/ann", { updates: [{ fieldName: "a", value: 1 }] }],
      ["DELETE", "/records/users/ann", undefined],
      ["POST", "/batch", { ops: [{ op: "set", key: "users/x" }] }],
      ["PUT", "/records/not-a-key", { data: {} }],
    ] as const) {
      expect(await call(method, `/v1/databases/demo${path}`, body)).toMatchObject({ status: 403, body: refusal("read_only") });
    }
    expect(await call("GET", "/v1/databases/demo/records/users/ann")).toMatchObject({ status: 200 });
  });

  it("refuses deletes of a database that writes but reports delete:false", async () => {
    const db = new MapDatabase({ ...writable, delete: false }, { "users/ann": { name: "Ann" } });
    const call = caller({ databases: { demo: db } });
    expect(await call("DELETE", "/v1/databases/demo/records/users/ann")).toMatchObject({ status: 403, body: refusal("read_only") });
    expect(await call("POST", "/v1/databases/demo/batch", { ops: [{ op: "delete", key: "users/ann" }] }))
      .toMatchObject({ status: 403, body: refusal("read_only") });
    expect((await call("PUT", "/v1/databases/demo/records/users/ann", { data: {} })).status).toBe(204);
  });
});

describe("api.md#query: POST|GET /v1/databases/{db}/query", () => {
  it("→ 200 {records, complete} for POST and for GET ?q=", async () => {
    const call = caller({ databases: { demo: seeded() } });
    const query = { collection: "users", where: [{ field: "tags", op: "array-contains", value: "a" }], limit: 0 };
    const expected = { records: [{ key: "users/ann", data: { name: "Ann", age: 30, tags: ["a"] } }], complete: true };
    expect(await call("POST", "/v1/databases/demo/query", query)).toMatchObject({ status: 200, body: expected });
    expect(await call("GET", `/v1/databases/demo/query?q=${encodeURIComponent(JSON.stringify(query))}`))
      .toMatchObject({ status: 200, body: expected });
  });

  it("keysOnly without an order sorts keys and applies the limit after sorting", async () => {
    const db = new MapDatabase(undefined, { "users/c": { n: 1 }, "users/a": { n: 3 }, "users/b": { n: 2 }, "users/d": { n: 2 } });
    const call = caller({ databases: { demo: db } });
    expect((await call("POST", "/v1/databases/demo/query", { collection: "users", keysOnly: true, limit: 2 })).body)
      .toEqual({ records: [{ key: "users/a" }, { key: "users/b" }], complete: true });
    expect((await call("POST", "/v1/databases/demo/query", { collection: "users", keysOnly: true })).body)
      .toMatchObject({ records: [{ key: "users/a" }, { key: "users/b" }, { key: "users/c" }, { key: "users/d" }] });
    expect((await call("POST", "/v1/databases/demo/query", { collection: "users", keysOnly: true, orderBy: [{ field: "n", desc: true }], limit: 1 })).body)
      .toEqual({ records: [{ key: "users/a" }], complete: true });
    expect((await call("POST", "/v1/databases/demo/query", { collection: "users", keysOnly: true, orderBy: [{ field: "n" }], limit: 1 })).body)
      .toEqual({ records: [{ key: "users/c" }], complete: true });
  });

  const refusals: readonly [string, unknown, string][] = [
    ["a body that is not an object", [], "bad_request"],
    ["a missing collection", {}, "invalid_key"],
    ["an unsafe collection", { collection: ".." }, "invalid_key"],
    ["an unsafe parent", { collection: "items", parent: "lists" }, "invalid_key"],
    ["a parent that is not a string", { collection: "items", parent: 5 }, "invalid_key"],
    ["a where that is not an array", { collection: "users", where: {} }, "bad_request"],
    ["an orderBy that is not an array", { collection: "users", orderBy: {} }, "bad_request"],
    ["a negative limit", { collection: "users", limit: -1 }, "bad_request"],
    ["a keysOnly that is not boolean", { collection: "users", keysOnly: 1 }, "bad_request"],
    ["a filter without a field", { collection: "users", where: [1] }, "bad_request"],
    ["an unsupported operator", { collection: "users", where: [{ field: "a", op: "!=", value: 1 }] }, "bad_request"],
    ["an order without a field", { collection: "users", orderBy: [{}] }, "bad_request"],
    ["an order that is not an object", { collection: "users", orderBy: [1] }, "bad_request"],
  ];
  for (const [name, body, code] of refusals) {
    it(`400 ${code} for ${name}`, async () => {
      const call = caller({ databases: { demo: seeded() } });
      expect(await call("POST", "/v1/databases/demo/query", body)).toMatchObject({ status: 400, body: refusal(code) });
    });
  }

  it("400 bad_request for a GET without one q, a q that is not JSON, or a body over 1 MiB", async () => {
    const call = caller({ databases: { demo: seeded() } });
    expect(await call("GET", "/v1/databases/demo/query")).toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("GET", "/v1/databases/demo/query?q=%7B")).toMatchObject({ status: 400, body: refusal("bad_request") });
    const big = JSON.stringify({ collection: "users", pad: "x".repeat(1 << 20) });
    expect(await call("POST", "/v1/databases/demo/query", big)).toMatchObject({ status: 400, body: refusal("bad_request") });
  });

  it("501 query_unsupported for a database whose capabilities say query:false", async () => {
    const call = caller({ databases: { demo: new MapDatabase({ ...writable, query: false }) } });
    expect(await call("POST", "/v1/databases/demo/query", { collection: "users" })).toMatchObject({ status: 501, body: refusal("query_unsupported") });
  });

  it("scopes a parent query to the parent key", async () => {
    const db = seeded();
    const call = caller({ databases: { demo: db } });
    await call("PUT", "/v1/databases/demo/records/lists/l1/items/i1", { data: { n: 1 } });
    expect((await call("POST", "/v1/databases/demo/query", { collection: "items", parent: "lists/l1" })).body)
      .toEqual({ records: [{ key: "lists/l1/items/i1", data: { n: 1 } }], complete: true });
    expect(db.queries.at(-1)?.source).toMatchObject({ kind: "collection", name: "items", parent: { path: "lists/l1" } });
  });
});

describe("api.md#conventions: DALgo errors map to the Go server's statuses", () => {
  const failing = (error: unknown): Database => {
    const db = seeded();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the cases include a thrown non-Error
    db.query = () => Promise.reject(error);
    return db;
  };
  const cases: readonly [string, unknown, number, string][] = [
    ["NotFoundError", new NotFoundError(key("users", "x")), 404, "not_found"],
    ["UnsupportedError", new UnsupportedError("x"), 422, "not_supported"],
    ["a ConstraintViolationError", Object.assign(new Error("dup"), { name: "ConstraintViolationError" }), 409, "constraint_violation"],
    ["a constraint_violation code", Object.assign(new Error("dup"), { code: "constraint_violation" }), 409, "constraint_violation"],
    ["SQLite constraint text", new Error("FOREIGN KEY constraint failed"), 409, "constraint_violation"],
    ["an error with a numeric code", Object.assign(new Error("io"), { code: 5 }), 500, "internal"],
    ["any other error", new Error("disk on fire"), 500, "internal"],
    ["a thrown non-error", "boom", 500, "internal"],
  ];
  for (const [name, error, status, code] of cases) {
    it(`${name} → ${status.toString()} ${code}`, async () => {
      const call = caller({ databases: { demo: failing(error) } });
      const answer = await call("POST", "/v1/databases/demo/query", { collection: "users" });
      expect(answer).toMatchObject({ status, body: refusal(code) });
      if (status === 500) expect(answer.body).toEqual({ error: { code: "internal", message: "internal server error" } });
    });
  }

  it("a NotFoundError of an adapter's delete keeps DELETE idempotent; other delete errors fail", async () => {
    const db = seeded();
    const run = db.runReadwriteTransaction.bind(db);
    let failure: Error = new NotFoundError(key("users", "zed"));
    db.runReadwriteTransaction = (callback) => run((tx) => callback({ ...tx, delete: () => Promise.reject(failure) }));
    const call = caller({ databases: { demo: db } });
    expect((await call("DELETE", "/v1/databases/demo/records/users/zed")).status).toBe(204);
    failure = new Error("locked");
    expect((await call("DELETE", "/v1/databases/demo/records/users/zed")).status).toBe(500);
  });
});

describe("POST /v1/databases/{db}/reset (in-process extension)", () => {
  it("restores a resettable database that reports reset:true → 204", async () => {
    const db = new ResettableMapDatabase({ ...writable, reset: true }, { "users/ann": { name: "Ann" } });
    const call = caller({ databases: { demo: db } });
    await call("DELETE", "/v1/databases/demo/records/users/ann");
    expect((await call("POST", "/v1/databases/demo/reset")).status).toBe(204);
    expect(db.store.has("users/ann")).toBe(true);
  });

  it("403 read_only when capabilities say reset:false, 404 not_found when the database cannot reset", async () => {
    const call = caller({ databases: { locked: new ResettableMapDatabase(writable, {}), plain: seeded() } });
    expect(await call("POST", "/v1/databases/locked/reset")).toMatchObject({ status: 403, body: refusal("read_only") });
    expect(await call("POST", "/v1/databases/plain/reset")).toMatchObject({ status: 404, body: refusal("not_found") });
    expect(await call("GET", "/v1/databases/plain/reset")).toMatchObject({ status: 405 });
  });

  it("a plain DALgo database reports default capabilities: writable, not resettable, not persistent", async () => {
    const call = caller({ databases: { demo: plain(seeded()) } });
    expect((await call("GET", "/v1/databases/demo")).body).toMatchObject({
      capabilities: { read: true, query: true, write: true, delete: true, reset: false, persistent: false },
    });
  });
});

describe("createOvdbFetch never reaches the network", () => {
  it("rejects a request to any other origin", async () => {
    const fetch = createOvdbFetch({ databases: { demo: seeded() } });
    await expect(fetch("https://example.com/v1/databases/demo")).rejects.toBeInstanceOf(TypeError);
    await expect(fetch("http://local.ovdb.invalid/v1/databases/demo")).rejects.toThrow(/serves https:\/\/local\.ovdb\.invalid only/u);
  });

  it("serves a custom base URL with a path prefix and answers 404 outside it", async () => {
    const fetch = createOvdbFetch({ baseUrl: "http://127.0.0.1:6832/ovdb-local/", databases: { demo: seeded() } });
    const descriptor = await fetch("http://127.0.0.1:6832/ovdb-local/v1/databases/demo");
    expect(await descriptor.json()).toMatchObject({ endpoints: { dtql: "http://127.0.0.1:6832/ovdb-local/v1/databases/demo/dtql" } });
    expect((await fetch(new URL("http://127.0.0.1:6832/v1/databases/demo"))).status).toBe(404);
    const request = new Request("http://127.0.0.1:6832/ovdb-local/.well-known/openvaultdb");
    expect(await (await fetch(request)).json()).toMatchObject({ databases: [{ apiUrl: "http://127.0.0.1:6832/ovdb-local/v1/databases/demo" }] });
  });
});
