import { AlreadyExistsError, Key, type ReadwriteTransaction } from "@dalgo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOvdbFetch } from "../src/index.js";
import { MapDatabase, readOnlyCapabilities, writable } from "./fake-database.js";
import { base, caller, refusal } from "./helpers.js";

const objectPrototype = Object.getOwnPropertyNames(Object.prototype).sort();

function expectPrototypeUntouched(): void {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(objectPrototype);
  expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  expect(({} as Record<string, unknown>).X).toBeUndefined();
}

const seeded = (): MapDatabase => new MapDatabase(undefined, { "users/a": { name: "Ann", n: 1 } });

describe("prototype pollution is refused (400) and Object.prototype stays untouched", () => {
  beforeEach(expectPrototypeUntouched);
  afterEach(expectPrototypeUntouched);

  const patch = (updates: unknown): unknown => ({ updates });
  const cases: readonly [string, unknown][] = [
    ["fieldPath through __proto__", patch([{ fieldPath: ["__proto__", "pwned"], value: "yes" }])],
    ["fieldPath through constructor", patch([{ fieldPath: ["constructor", "prototype", "pwned"], value: "yes" }])],
    ["fieldPath through prototype", patch([{ fieldPath: ["name", "prototype"], value: "yes" }])],
    ["fieldName __proto__", patch([{ fieldName: "__proto__", value: { pwned: "yes" } }])],
    ["delete through __proto__", patch([{ fieldPath: ["__proto__", "X"], delete: true }])],
    ["serverTimestamp through __proto__", patch([{ fieldPath: ["__proto__", "pwned"], serverTimestamp: true }])],
    ["increment through __proto__", patch([{ fieldPath: ["__proto__", "pwned"], transform: "increment", value: 1 }])],
    ["update value holding a __proto__ key", patch([{ fieldName: "x", value: JSON.parse('{"__proto__":{"pwned":"yes"}}') as unknown }])],
  ];

  for (const [name, body] of cases) {
    it(`PATCH: ${name}`, async () => {
      const db = seeded();
      const call = caller({ databases: { d: db } });
      expect(await call("PATCH", "/v1/databases/d/records/users/a", body)).toMatchObject({ status: 400, body: refusal("bad_request") });
      expect(db.store.get("users/a")?.data).toEqual({ name: "Ann", n: 1 });
    });

    it(`batch update: ${name}`, async () => {
      const call = caller({ databases: { d: seeded() } });
      const updates = (body as { updates: unknown }).updates;
      expect(await call("POST", "/v1/databases/d/batch", { ops: [{ op: "update", key: "users/a", updates }] }))
        .toMatchObject({ status: 400, body: refusal("bad_request") });
    });
  }

  it("PUT, POST and batch bodies holding a __proto__ key, at any depth", async () => {
    const db = seeded();
    const call = caller({ databases: { d: db } });
    const raw = '{"data":{"a":[{"__proto__":{"pwned":"yes"}}]}}';
    expect(await call("PUT", "/v1/databases/d/records/users/b", raw)).toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("POST", "/v1/databases/d/records/users/b", raw)).toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("POST", "/v1/databases/d/batch", '{"ops":[{"op":"set","key":"users/b","data":{"__proto__":{"pwned":"yes"}}}]}'))
      .toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(db.store.has("users/b")).toBe(false);
  });

  it("nested arrays and objects without __proto__ are stored; a PUT with no body is a 400", async () => {
    const db = seeded();
    const call = caller({ databases: { d: db } });
    expect((await call("PUT", "/v1/databases/d/records/users/b", { data: { a: [1, { b: 2 }], c: { d: [] } } })).status).toBe(204);
    expect((await createOvdbFetch({ databases: { d: db } })(`${base}/v1/databases/d/records/users/b`, { method: "PUT" })).status).toBe(400);
  });

  it("a plain field named constructor or toString is data, not a prototype lookup", async () => {
    const db = seeded();
    const call = caller({ databases: { d: db } });
    expect((await call("PATCH", "/v1/databases/d/records/users/a", patch([{ fieldPath: ["toString", "x"], value: 1 }]))).status).toBe(204);
    expect(await call("PATCH", "/v1/databases/d/records/users/a", patch([{ fieldPath: ["valueOf", "x"], delete: true }]))).toMatchObject({ status: 204 });
    expect(Object.hasOwn(db.store.get("users/a")?.data ?? {}, "toString")).toBe(true);
  });

  it("query and DTQL field names of __proto__ are refused", async () => {
    const call = caller({ databases: { d: seeded() } });
    expect(await call("POST", "/v1/databases/d/query", { collection: "users", where: [{ field: "__proto__", op: "==", value: 1 }] }))
      .toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("POST", "/v1/databases/d/dtql", { query: "from: {name: users}\ncolumns: [{field: __proto__}]" }, { "Content-Type": "application/json" }))
      .toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    expectPrototypeUntouched();
  });

  it("database ids that name Object.prototype members are not found", async () => {
    const call = caller({ databases: { d: seeded() } });
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect((await call("GET", `/v1/databases/${id}`)).status).toBe(404);
    }
  });
});

describe("request body limit (413 payload_too_large)", () => {
  const big = { data: { pad: "x".repeat(300) } };

  it("refuses record, batch, query and DTQL bodies over maxBodyBytes while reading", async () => {
    const call = caller({ databases: { d: seeded() }, maxBodyBytes: 200 });
    expect(await call("PUT", "/v1/databases/d/records/users/b", big)).toMatchObject({ status: 413, body: refusal("payload_too_large") });
    expect(await call("POST", "/v1/databases/d/batch", { ops: [{ op: "set", key: "users/b", data: big.data }] }))
      .toMatchObject({ status: 413, body: refusal("payload_too_large") });
    expect(await call("POST", "/v1/databases/d/query", { collection: "users", pad: big.data.pad }))
      .toMatchObject({ status: 413, body: refusal("payload_too_large") });
    expect(await call("POST", "/v1/databases/d/dtql", `from: {name: users}\n#${big.data.pad}`)).toMatchObject({ status: 413 });
  });

  it("refuses by a declared Content-Length before reading, and stops a chunked body that grows past the limit", async () => {
    const fetch = createOvdbFetch({ databases: { d: seeded() }, maxBodyBytes: 200 });
    const declared = await fetch(`${base}/v1/databases/d/records/users/b`, {
      method: "PUT", headers: { "Content-Length": "5000" }, body: "{}",
    });
    expect(declared.status).toBe(413);

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(100));
        if (pulled === 1000) controller.close();
      },
    });
    const streamed = await fetch(`${base}/v1/databases/d/records/users/b`, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("accepts a body at the limit and a multi-chunk multibyte body", async () => {
    const fetch = createOvdbFetch({ databases: { d: seeded() } });
    const text = JSON.stringify({ data: { s: "é".repeat(50) } });
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 20)); // splits a two-byte character
        controller.enqueue(bytes.slice(20));
        controller.close();
      },
    });
    const response = await fetch(`${base}/v1/databases/d/records/users/c`, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(204);
    const exact = caller({ databases: { d: seeded() }, maxBodyBytes: bytes.length });
    expect((await exact("PUT", "/v1/databases/d/records/users/c", text)).status).toBe(204);
  });
});

describe("read: false is enforced", () => {
  const noRead = { ...writable, read: false };

  it("answers 403 read_denied for record GET/HEAD, query and DTQL, while the descriptor and writes still work", async () => {
    const call = caller({ databases: { d: new MapDatabase(noRead, { "users/a": { n: 1 } }) } });
    expect(await call("GET", "/v1/databases/d/records/users/a")).toMatchObject({ status: 403, body: refusal("read_denied") });
    expect(await call("HEAD", "/v1/databases/d/records/users/a")).toMatchObject({ status: 403, body: undefined });
    expect(await call("POST", "/v1/databases/d/query", { collection: "users" })).toMatchObject({ status: 403, body: refusal("read_denied") });
    expect(await call("GET", "/v1/databases/d/query?q=%7B%22collection%22%3A%22users%22%7D")).toMatchObject({ status: 403 });
    expect(await call("POST", "/v1/databases/d/dtql", "from: {name: users}")).toMatchObject({ status: 403, body: refusal("read_denied") });
    expect((await call("GET", "/v1/databases/d")).status).toBe(200);
    expect((await call("PUT", "/v1/databases/d/records/users/b", { data: {} })).status).toBe(204);
  });
});

describe("HEAD on GET routes", () => {
  it("answers the status and headers of GET with no body", async () => {
    const call = caller({ databases: { d: seeded() } });
    for (const path of ["/.well-known/openvaultdb", "/v1/databases/d", "/v1/databases/d/query?q=%7B%22collection%22%3A%22users%22%7D", "/v1/databases/d/dtql?q=from%3A%20%7Bname%3A%20users%7D"]) {
      const answer = await call("HEAD", path);
      expect(answer.status).toBe(200);
      expect(answer.body).toBeUndefined();
      expect(answer.headers.get("Content-Type")).toBe("application/json");
    }
    expect((await call("HEAD", "/v1/databases/d/batch")).status).toBe(405);
    expect((await call("HEAD", "/v1/databases/zz")).status).toBe(404);
  });
});

describe("/query operand shapes", () => {
  const bad: readonly [string, unknown][] = [
    ["in with a scalar", { field: "n", op: "in", value: 1 }],
    ["in with a non-scalar item", { field: "n", op: "in", value: [{}] }],
    ["array-contains-any with a string", { field: "n", op: "array-contains-any", value: "a" }],
    ["== with an object", { field: "n", op: "==", value: {} }],
    ["< with null", { field: "n", op: "<", value: null }],
    ["array-contains with an array", { field: "n", op: "array-contains", value: [1] }],
  ];
  for (const [name, filter] of bad) {
    it(`400 bad_request: ${name}`, async () => {
      const call = caller({ databases: { d: seeded() } });
      expect(await call("POST", "/v1/databases/d/query", { collection: "users", where: [filter] }))
        .toMatchObject({ status: 400, body: refusal("bad_request") });
    });
  }

  it("accepts well-shaped operands, including == null", async () => {
    const call = caller({ databases: { d: seeded() } });
    const where = [
      { field: "n", op: "in", value: [1, 2] }, { field: "n", op: "==", value: null },
      { field: "n", op: ">=", value: 0 }, { field: "tags", op: "array-contains-any", value: ["a"] },
    ];
    expect((await call("POST", "/v1/databases/d/query", { collection: "users", where })).status).toBe(200);
  });
});

describe("insert conflict check does not rely on the adapter", () => {
  /** A database whose insert silently overwrites, like an upsert-based adapter. */
  class OverwritingDatabase extends MapDatabase {
    public override async runReadwriteTransaction<Result>(callback: (tx: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
      return super.runReadwriteTransaction((tx) => callback({ ...tx, insert: (key, data) => tx.set(key, data) }));
    }
  }

  it("POST a record and a batch insert over an existing key answer 409 already_exists, leaving the record unchanged", async () => {
    const db = new OverwritingDatabase(writable, { "users/a": { name: "Ann" } });
    const call = caller({ databases: { d: db } });
    expect(await call("POST", "/v1/databases/d/records/users/a", { data: { name: "Other" } }))
      .toMatchObject({ status: 409, body: refusal("already_exists") });
    expect(await call("POST", "/v1/databases/d/batch", { ops: [{ op: "insert", key: "users/a", data: { name: "Other" } }] }))
      .toMatchObject({ status: 409, body: refusal("already_exists") });
    expect(db.store.get("users/a")?.data).toEqual({ name: "Ann" });
    expect(new AlreadyExistsError(new Key("users", "a"))).toBeInstanceOf(Error);
  });
});

describe("snapshot capacity is reserved atomically", () => {
  it("concurrent first pages never exceed two snapshots, and a failed capture frees its slot", async () => {
    const db = new MapDatabase(readOnlyCapabilities, { "users/a": { n: 1 } });
    const real = db.query.bind(db);
    let gate: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { gate = resolve; });
    db.query = async (query) => {
      await held;
      return real(query);
    };
    const call = caller({ databases: { d: db } });
    const first = (): Promise<unknown> => call("POST", "/v1/databases/d/dtql", { query: "from: {name: users}" }, {
      "Content-Type": "application/json", "OVDB-Page-Size": "1",
    });
    const started = [first(), first(), first(), first()];
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate();
    const statuses = (await Promise.all(started) as { status: number }[]).map(({ status }) => status).sort();
    expect(statuses).toEqual([200, 200, 503, 503]);

    // Two live snapshots remain; a new database instance shows a failed capture releasing its slot.
    const second = new MapDatabase(readOnlyCapabilities, { "users/a": { n: 1 } });
    second.query = () => Promise.reject(new Error("boom"));
    const again = caller({ databases: { d: second } });
    const attempt = (): Promise<{ status: number }> => again("POST", "/v1/databases/d/dtql", { query: "from: {name: users}" }, {
      "Content-Type": "application/json", "OVDB-Page-Size": "1",
    });
    expect((await attempt()).status).toBe(500);
    expect((await attempt()).status).toBe(500);
    expect((await attempt()).status).toBe(500);
  });
});
