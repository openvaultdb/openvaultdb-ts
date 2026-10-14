import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createOvdbFetch, fetchOverPort, serveFetchOverPort, type FetchPort } from "../src/index.js";
import { MapDatabase } from "./fake-database.js";
import { base } from "./helpers.js";

const opened: MessagePort[] = [];

function channel(): { readonly client: FetchPort; readonly server: FetchPort; readonly raw: readonly [MessagePort, MessagePort] } {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  return { client: port1 as unknown as FetchPort, server: port2 as unknown as FetchPort, raw: [port1, port2] };
}

afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

describe("serveFetchOverPort / fetchOverPort over a Node MessageChannel", () => {
  it("round-trips method, URL, headers and body, and the response status, headers and body", async () => {
    const db = new MapDatabase(undefined, { "users/ann": { name: "Ann" } });
    const { client, server } = channel();
    serveFetchOverPort(createOvdbFetch({ databases: { demo: db } }), server);
    const fetch = fetchOverPort(client);

    const created = await fetch(`${base}/v1/databases/demo/records/users/bob`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { name: "Bob" } }),
    });
    expect(created.status).toBe(201);
    expect(db.store.get("users/bob")?.data).toEqual({ name: "Bob" });

    const read = await fetch(new Request(`${base}/v1/databases/demo/records/users/ann`));
    expect(read.status).toBe(200);
    expect(read.headers.get("Content-Type")).toBe("application/json");
    expect(await read.json()).toEqual({ key: "users/ann", data: { name: "Ann" } });

    const head = await fetch(`${base}/v1/databases/demo/records/users/ann`, { method: "HEAD" });
    expect(head.status).toBe(200);
    const deleted = await fetch(`${base}/v1/databases/demo/records/users/ann`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    const refused = await fetch(`${base}/v1/databases/demo/records/users`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "invalid_key" } });
  });

  it("serves concurrent requests and matches each answer to its request", async () => {
    const { client, server } = channel();
    let calls = 0;
    serveFetchOverPort(async (input) => {
      calls += 1;
      const delay = calls === 1 ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(input instanceof Request ? input.url : input.toString());
    }, server);
    const fetch = fetchOverPort(client);
    const answers = await Promise.all([fetch(`${base}/a`), fetch(`${base}/b`)].map(async (response) => (await response).text()));
    expect(answers).toEqual([`${base}/a`, `${base}/b`]);
  });

  it("rejects with the server-side failure: a TypeError stays a TypeError", async () => {
    const { client, server } = channel();
    serveFetchOverPort(createOvdbFetch({ databases: {} }), server);
    const fetch = fetchOverPort(client);
    await expect(fetch("https://example.com/v1/databases")).rejects.toBeInstanceOf(TypeError);

    const other = channel();
    serveFetchOverPort(() => Promise.reject(new RangeError("out of range")), other.server);
    await expect(fetchOverPort(other.client)(`${base}/x`)).rejects.toMatchObject({ name: "RangeError", message: "out of range" });

    const third = channel();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a fetch that rejects with a non-Error
    serveFetchOverPort(() => Promise.reject("plain string"), third.server);
    await expect(fetchOverPort(third.client)(`${base}/x`)).rejects.toMatchObject({ name: "Error", message: "plain string" });
  });

  it("ignores unrelated messages and answers for unknown requests", async () => {
    const { client, server, raw } = channel();
    let served = 0;
    serveFetchOverPort(() => {
      served += 1;
      return Promise.resolve(new Response("ok"));
    }, server);
    const fetch = fetchOverPort(client);
    raw[0].postMessage("noise");
    raw[0].postMessage(null);
    raw[1].postMessage("noise");
    raw[1].postMessage({ type: "openvaultdb/fetch-response", id: 999, ok: false, name: "Error", message: "stray" });
    expect(await (await fetch(`${base}/x`)).text()).toBe("ok");
    expect(served).toBe(1);
  });

  it("stops waiting on abort, before or during the request; the stop function ends serving", async () => {
    const { client, server } = channel();
    let release: () => void = () => undefined;
    const stop = serveFetchOverPort(() => new Promise<Response>((resolve) => {
      release = () => { resolve(new Response("late")); };
    }), server);
    const fetch = fetchOverPort(client);
    const aborted = new AbortController();
    aborted.abort(new Error("before"));
    await expect(fetch(`${base}/x`, { signal: aborted.signal })).rejects.toThrow("before");

    const during = new AbortController();
    const pending = fetch(`${base}/x`, { signal: during.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    during.abort(new Error("during"));
    await expect(pending).rejects.toThrow("during");
    release();

    stop();
    const unanswered = fetch(`${base}/x`);
    const outcome = await Promise.race([unanswered.then(() => "answered"), new Promise((resolve) => setTimeout(() => { resolve("silent"); }, 30))]);
    expect(outcome).toBe("silent");
  });

  it("works with a port that has no start()", async () => {
    const { client, server } = channel();
    const withoutStart = (port: FetchPort): FetchPort => {
      (port as unknown as { start: () => void }).start();
      return {
        postMessage: (message, transfer) => { port.postMessage(message, transfer); },
        addEventListener: (type, listener) => { port.addEventListener(type, listener); },
        removeEventListener: (type, listener) => { port.removeEventListener(type, listener); },
      };
    };
    serveFetchOverPort(() => Promise.resolve(new Response("bare")), withoutStart(server));
    expect(await (await fetchOverPort(withoutStart(client))(`${base}/x`)).text()).toBe("bare");
  });
});
