import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createOvdbFetch, fetchOverPort, PortProtocolError, serveFetchOverPort, type FetchPort } from "../src/index.js";
import { MapDatabase } from "./fake-database.js";
import { base, caller, refusal } from "./helpers.js";

const opened: MessagePort[] = [];

afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

function channel(): readonly [MessagePort, MessagePort] {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  return [port1, port2];
}

const tick = async (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const asPort = (port: MessagePort): FetchPort => port as unknown as FetchPort;
const good = { ok: true, status: 200, statusText: "OK", headers: [["x-a", "b"]], body: new ArrayBuffer(2) };

/** A far side that answers every request it receives with the scripted reply for that request's id. */
function scripted(reply: (id: number) => unknown): { readonly fetch: ReturnType<typeof fetchOverPort>; readonly far: MessagePort } {
  const [near, far] = channel();
  far.on("message", (message: { type: string; id: number }) => {
    if (message.type === "openvaultdb/fetch-request") far.postMessage({ type: "openvaultdb/fetch-response", id: message.id, ...(reply(message.id) as object) });
  });
  return { fetch: fetchOverPort(asPort(near)), far };
}

describe("a malformed reply rejects its request with PortProtocolError and keeps the bridge alive", () => {
  const bad: readonly [string, Record<string, unknown>][] = [
    ["status 0", { ...good, status: 0 }],
    ["status 199", { ...good, status: 199 }],
    ["status 600", { ...good, status: 600 }],
    ["status 1xx", { ...good, status: 101 }],
    ["fractional status", { ...good, status: 200.5 }],
    ["string status", { ...good, status: "200" }],
    ["statusText with a line break", { ...good, statusText: "O\nK" }],
    ["non-string statusText", { ...good, statusText: 7 }],
    ["non-array headers", { ...good, headers: { a: "b" } }],
    ["header pair of the wrong size", { ...good, headers: [["a"]] }],
    ["non-string header value", { ...good, headers: [["a", 1]] }],
    ["invalid header name", { ...good, headers: [["bad name", "v"]] }],
    ["invalid header value", { ...good, headers: [["a", "x\ny"]] }],
    ["a string body", { ...good, body: "text" }],
    ["a missing body", { ...good, body: undefined }],
    ["a body on a 204", { ...good, status: 204, body: new ArrayBuffer(3) }],
    ["a missing ok", { status: 200 }],
    ["a failure without a name", { ok: false, message: "m" }],
    ["a failure without a message", { ok: false, name: "Error" }],
  ];

  for (const [name, reply] of bad) {
    it(name, async () => {
      const { fetch } = scripted(() => reply);
      await expect(fetch(`${base}/x`)).rejects.toBeInstanceOf(PortProtocolError);
      await expect(fetch(`${base}/y`)).rejects.toBeInstanceOf(PortProtocolError);
    });
  }

  it("a duplicate bad reply is ignored, and many bad replies then a good one still work", async () => {
    let calls = 0;
    const { fetch, far } = scripted((id) => {
      calls += 1;
      // The second request of the run gets a good answer; the others get a bad one, twice.
      if (calls === 6) return good;
      far.postMessage({ type: "openvaultdb/fetch-response", id, ...bad[0]?.[1] });
      return bad[1]?.[1];
    });
    for (let index = 0; index < 5; index += 1) await expect(fetch(`${base}/x`)).rejects.toBeInstanceOf(PortProtocolError);
    const answer = await fetch(`${base}/x`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-a")).toBe("b");
    expect((await answer.arrayBuffer()).byteLength).toBe(2);
    await tick();
  });

  it("accepts a bodiless 204 and 304, and keeps a 599", async () => {
    for (const status of [204, 205, 304, 599]) {
      const { fetch } = scripted(() => ({ ...good, status, body: new ArrayBuffer(0) }));
      expect((await fetch(`${base}/x`)).status).toBe(status);
    }
  });

  it("a duplicate bad reply never throws in the listener", async () => {
    const [near, far] = channel();
    const fetch = fetchOverPort(asPort(near));
    const pending = fetch(`${base}/x`);
    await tick();
    for (let index = 0; index < 3; index += 1) far.postMessage({ type: "openvaultdb/fetch-response", id: 1, ...good, status: 0 });
    await expect(pending).rejects.toBeInstanceOf(PortProtocolError);
    await tick();
  });
});

describe("the serving side refuses malformed requests with a PortProtocolError reply", () => {
  const request = { type: "openvaultdb/fetch-request", id: 5, method: "GET", url: `${base}/x`, headers: [] };
  const bad: readonly [string, Record<string, unknown>][] = [
    ["a numeric method", { method: 1 }],
    ["a missing url", { url: undefined }],
    ["non-array headers", { headers: "a=b" }],
    ["a malformed header pair", { headers: [["a"]] }],
    ["a string body", { body: "text" }],
  ];

  for (const [name, change] of bad) {
    it(name, async () => {
      const [near, far] = channel();
      let served = 0;
      serveFetchOverPort(() => { served += 1; return Promise.resolve(new Response("ok")); }, asPort(far));
      const replies: unknown[] = [];
      near.on("message", (data: unknown) => { replies.push(data); });
      near.postMessage({ ...request, ...change });
      near.postMessage({ ...request, id: 6 });
      await tick(30);
      expect(replies).toMatchObject([
        { id: 5, ok: false, name: "PortProtocolError" },
        { id: 6, ok: true, status: 200 },
      ]);
      expect(served).toBe(1);
    });
  }

  it("ignores a request with an invalid id", async () => {
    const [near, far] = channel();
    serveFetchOverPort(() => Promise.resolve(new Response("ok")), asPort(far));
    const replies: unknown[] = [];
    near.on("message", (data: unknown) => { replies.push(data); });
    for (const id of ["1", 1.5, null, undefined, Number.NaN]) near.postMessage({ ...request, id });
    await tick(30);
    expect(replies).toEqual([]);
  });

  it("a repeated id in flight is refused and the original stays abortable", async () => {
    const [near, far] = channel();
    let seen: AbortSignal | undefined;
    let served = 0;
    serveFetchOverPort((_input, init) => {
      served += 1;
      seen = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }, asPort(far));
    const replies: unknown[] = [];
    near.on("message", (data: unknown) => { replies.push(data); });
    near.postMessage(request);
    near.postMessage(request);
    await tick(30);
    expect(served).toBe(1);
    expect(replies).toMatchObject([{ id: 5, ok: false, name: "PortProtocolError", message: expect.stringContaining("already") as unknown }]);
    expect(seen?.aborted).toBe(false);
    near.postMessage({ type: "openvaultdb/fetch-abort", id: 5 });
    await tick(30);
    expect(seen?.aborted).toBe(true);
  });

  it("the caller of a refused request gets the PortProtocolError the far side reported", async () => {
    const { fetch } = scripted(() => ({ ok: false, name: "PortProtocolError", message: "the request id is already in flight" }));
    await expect(fetch(`${base}/x`)).rejects.toMatchObject({ name: "PortProtocolError", message: "the request id is already in flight" });
    await expect(fetch(`${base}/x`)).rejects.toBeInstanceOf(PortProtocolError);
  });
});

describe("pathological nesting answers 400, not 500", () => {
  const deepArray = (levels: number): string => `${"[".repeat(levels)}${"]".repeat(levels)}`;
  const deepObject = (levels: number): string => `${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`;
  const seeded = (): MapDatabase => new MapDatabase(undefined, { "users/a": { name: "Ann" } });
  const records = "/v1/databases/d/records/users/a";

  it("record bodies, update values and batch data", async () => {
    const call = caller({ databases: { d: seeded() } });
    for (const levels of [100_000, 257]) {
      for (const nested of [deepArray(levels), deepObject(levels)]) {
        expect(await call("PUT", records, `{"data":{"x":${nested}}}`)).toMatchObject({ status: 400, body: refusal("bad_request") });
        expect(await call("POST", records.replace("/a", "/new"), `{"data":{"x":${nested}}}`)).toMatchObject({ status: 400 });
        expect(await call("PATCH", records, `{"updates":[{"fieldName":"x","value":${nested}}]}`)).toMatchObject({ status: 400, body: refusal("bad_request") });
        expect(await call("POST", "/v1/databases/d/batch", `{"ops":[{"op":"set","key":"users/a","data":{"x":${nested}}}]}`)).toMatchObject({ status: 400 });
      }
    }
    expect((await call("PUT", records, `{"data":{"x":${deepArray(200)}}}`)).status).toBe(204);
  });

  it("field paths with very many segments", async () => {
    const call = caller({ databases: { d: seeded() } });
    for (const length of [100_000, 257]) {
      const fieldPath = Array.from({ length }, () => "a");
      expect(await call("PATCH", records, { updates: [{ fieldPath, value: 1 }] })).toMatchObject({ status: 400, body: refusal("bad_request") });
    }
    expect((await call("PATCH", records, { updates: [{ fieldPath: Array.from({ length: 256 }, () => "a"), value: 1 }] })).status).toBe(204);
  });

  it("DTQL documents, as YAML and as JSON, GET and POST", async () => {
    const call = caller({ databases: { d: seeded() } });
    const yaml = (levels: number): string => `from: {name: users}\nwhere: ${'{and: ['.repeat(levels)}{left: {field: name}, op: ==, right: {value: Ann}}${"]}".repeat(levels)}`;
    for (const levels of [5_000, 300]) {
      expect(await call("POST", "/v1/databases/d/dtql", yaml(levels))).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
      expect(await call("POST", "/v1/databases/d/dtql", { query: yaml(levels) }, { "Content-Type": "application/json" }))
        .toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    }
    const flow = `from: {name: users}\nwhere: ${"[".repeat(5_000)}`;
    expect((await call("POST", "/v1/databases/d/dtql", flow)).status).toBe(400);
    const nested = yaml;
    expect((await call("POST", "/v1/databases/d/dtql", nested(100))).status).toBe(200);
  });
});

describe("HEAD never carries a body and reports its own method", () => {
  it("fails with status and headers only, and the 405 names HEAD and the allowed methods", async () => {
    const fetch = createOvdbFetch({ databases: { d: new MapDatabase() } });
    for (const path of ["/v1/databases/d/batch", "/v1/databases/zz", "/v1/databases/d/nowhere", "/other", "/v1/databases/d/reset"]) {
      const answer = await fetch(`${base}${path}`, { method: "HEAD" });
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(await answer.text()).toBe("");
    }
    const refused = await fetch(`${base}/v1/databases/d/batch`, { method: "HEAD" });
    expect(refused.status).toBe(405);
    expect(refused.headers.get("Allow")).toBe("POST");
    expect(await refused.text()).toBe("");
    const message = await fetch(`${base}/v1/databases/d/batch`, { method: "PUT" });
    expect(((await message.json()) as { error: { message: string } }).error.message).toBe("method not allowed: PUT");
    const get = await fetch(`${base}/v1/databases/d/batch`);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    expect(((await get.json()) as { error: { message: string } }).error.message).toBe("method not allowed: GET");
    const query = await fetch(`${base}/v1/databases/d/dtql`, { method: "DELETE" });
    expect(query.headers.get("Allow")).toBe("GET, POST, HEAD");
    expect(((await query.json()) as { error: { message: string } }).error.message).toBe("method not allowed: DELETE");
    const wellKnown = await fetch(`${base}/.well-known/openvaultdb`, { method: "POST" });
    expect(wellKnown.headers.get("Allow")).toBe("GET, HEAD");
    const record = await fetch(`${base}/v1/databases/d/records/users/a`, { method: "OPTIONS" });
    expect(record.status).toBe(405);
    expect(record.headers.get("Allow")).toBe("GET, PUT, POST, PATCH, DELETE, HEAD");
  });
});

describe("__proto__ is not a database id or a collection", () => {
  it("answers 404 for the database and 400 for the collection, never reaching the adapter", async () => {
    const db = new MapDatabase();
    const touched: string[] = [];
    for (const name of ["get", "query", "runReadwriteTransaction"] as const) {
      const original = db[name].bind(db) as (...args: unknown[]) => unknown;
      (db as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { touched.push(name); return original(...args); };
    }
    const call = caller({ databases: { d: db } });
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(await call("GET", `/v1/databases/${id}`)).toMatchObject({ status: 404, body: refusal("not_found") });
      expect(await call("GET", `/v1/databases/${id}/records/users/a`)).toMatchObject({ status: 404 });
    }
    for (const collection of ["__proto__", "constructor", "prototype"]) {
      expect(await call("GET", `/v1/databases/d/records/${collection}/a`)).toMatchObject({ status: 400, body: refusal("invalid_key") });
      expect(await call("PUT", `/v1/databases/d/records/${collection}/a`, { data: {} })).toMatchObject({ status: 400, body: refusal("invalid_key") });
      expect(await call("PUT", `/v1/databases/d/records/users/a/${collection}/b`, { data: {} })).toMatchObject({ status: 400 });
      expect(await call("POST", "/v1/databases/d/batch", { ops: [{ op: "set", key: `${collection}/a`, data: {} }] })).toMatchObject({ status: 400 });
      expect(await call("POST", "/v1/databases/d/query", { collection })).toMatchObject({ status: 400, body: refusal("invalid_key") });
      expect(await call("POST", "/v1/databases/d/dtql", `from: {name: ${collection}}`)).toMatchObject({ status: 400 });
    }
    expect(touched).toEqual([]);
    expect((await call("PUT", "/v1/databases/d/records/users/__proto__", { data: {} })).status).toBe(204);
  });
});
