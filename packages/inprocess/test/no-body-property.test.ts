import { describe, expect, it } from "vitest";
import { readBody, readJsonBody } from "../src/server.js";
import { OvdbHttpError } from "../src/http.js";
import { caller, refusal } from "./helpers.js";
import { MapDatabase } from "./fake-database.js";

/** A Request-like object as Firefox gives it: no `body` stream, only arrayBuffer(). */
function firefoxRequest(text: string | null, headers: Record<string, string> = {}): Request {
  const bytes = text === null ? new Uint8Array(0) : new TextEncoder().encode(text);
  return {
    headers: new Headers(headers),
    body: undefined,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as Request;
}

const seeded = (): MapDatabase => new MapDatabase(undefined, { "users/a": { name: "Ann", n: 1 } });

describe("readBody without Request.body (Firefox)", () => {
  it("reads the whole body", async () => {
    expect(await readBody(firefoxRequest('{"a":"é"}'), 100)).toBe('{"a":"é"}');
  });

  it("reads an empty body as an empty string", async () => {
    expect(await readBody(firefoxRequest(null), 100)).toBe("");
  });

  it("refuses an oversized body after reading it, as 413 payload_too_large", async () => {
    const error = await readBody(firefoxRequest("x".repeat(101)), 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OvdbHttpError);
    expect(error).toMatchObject({ status: 413, code: "payload_too_large" });
  });

  it("refuses on Content-Length before reading at all", async () => {
    const request = firefoxRequest("x", { "Content-Length": "101" });
    request.arrayBuffer = () => Promise.reject(new Error("must not be read"));
    await expect(readBody(request, 100)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });

  it("accepts a body of exactly the limit", async () => {
    expect(await readBody(firefoxRequest("x".repeat(100)), 100)).toHaveLength(100);
  });
});

describe("readBody with a null body", () => {
  it("returns an empty string", async () => {
    expect(await readBody(new Request("https://x.invalid/", { method: "POST" }), 100)).toBe("");
  });
});

describe("readJsonBody without Request.body (Firefox)", () => {
  it("parses JSON", async () => {
    expect(await readJsonBody(firefoxRequest('{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it("answers malformed JSON as 400 bad_request", async () => {
    await expect(readJsonBody(firefoxRequest("{nope"), 100)).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});

describe("the whole server when Request.body is not implemented", () => {
  it("serves POST /query and /batch and enforces maxBodyBytes", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Request.prototype, "body");
    Object.defineProperty(Request.prototype, "body", { configurable: true, get: () => undefined });
    try {
      const call = caller({ databases: { d: seeded() }, maxBodyBytes: 400 });
      const query = await call("POST", "/v1/databases/d/query", { collection: "users" });
      expect(query.status).toBe(200);
      const batch = await call("POST", "/v1/databases/d/batch", { ops: [{ op: "set", key: "users/b", data: { name: "Bo" } }] });
      expect(batch.status).toBe(200);
      const big = await call("POST", "/v1/databases/d/query", { collection: "users", pad: "x".repeat(600) });
      expect(big).toMatchObject({ status: 413, body: refusal("payload_too_large") });
    } finally {
      if (descriptor) Object.defineProperty(Request.prototype, "body", descriptor);
    }
  });
});
