import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOvdbFetch, fetchOverPort, PortClosedError, serveFetchOverPort, type FetchPort } from "../src/index.js";
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
      const any = port as unknown as {
        addEventListener: (type: string, listener: unknown) => void;
        removeEventListener: (type: string, listener: unknown) => void;
      };
      return {
        postMessage: (message: unknown, transfer: Transferable[]) => { port.postMessage(message, transfer); },
        addEventListener: (type: string, listener: unknown) => { any.addEventListener(type, listener); },
        removeEventListener: (type: string, listener: unknown) => { any.removeEventListener(type, listener); },
      };
    };
    serveFetchOverPort(() => Promise.resolve(new Response("bare")), withoutStart(server));
    expect(await (await fetchOverPort(withoutStart(client))(`${base}/x`)).text()).toBe("bare");
  });
});

/** A port that records what is posted, can fail to post, and lets a test deliver messages and close events. */
class ScriptedPort implements FetchPort {
  public readonly posted: { message: unknown }[] = [];
  public failPost: (message: unknown, count: number) => boolean = () => false;
  public readonly messageListeners = new Set<(event: MessageEvent) => void>();
  public readonly closeListeners = new Set<() => void>();

  public postMessage(message: unknown): void {
    if (this.failPost(message, this.posted.length)) throw new Error("cannot post");
    this.posted.push({ message });
  }

  public addEventListener(type: "message" | "close", listener: ((event: MessageEvent) => void) & (() => void)): void {
    (type === "message" ? this.messageListeners : this.closeListeners).add(listener);
  }

  public removeEventListener(type: "message" | "close", listener: ((event: MessageEvent) => void) & (() => void)): void {
    (type === "message" ? this.messageListeners : this.closeListeners).delete(listener);
  }

  public deliver(data: unknown): void {
    for (const listener of [...this.messageListeners]) listener({ data } as MessageEvent);
  }

  public close(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}

const tick = async (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("closed ports, timeouts, aborts and failing postMessage", () => {
  it("rejects every pending request with PortClosedError when the far port closes mid-flight", async () => {
    const { client, server, raw } = channel();
    serveFetchOverPort(() => new Promise<Response>(() => undefined), server);
    const fetch = fetchOverPort(client);
    const first = fetch(`${base}/a`);
    const second = fetch(`${base}/b`, { method: "POST", body: "x" });
    await tick();
    raw[1].close();
    await expect(first).rejects.toBeInstanceOf(PortClosedError);
    await expect(second).rejects.toMatchObject({ name: "PortClosedError" });
    await expect(fetch(`${base}/c`)).rejects.toBeInstanceOf(PortClosedError);
  });

  it("dispose() rejects pending requests, stops listening, and is idempotent", async () => {
    const port = new ScriptedPort();
    const fetch = fetchOverPort(port);
    const pending = fetch(`${base}/a`);
    await tick(0);
    expect(port.messageListeners.size).toBe(1);
    expect(port.closeListeners.size).toBe(1);
    fetch.dispose();
    fetch.dispose();
    await expect(pending).rejects.toBeInstanceOf(PortClosedError);
    expect(port.messageListeners.size).toBe(0);
    expect(port.closeListeners.size).toBe(0);
    await expect(fetch(`${base}/b`)).rejects.toBeInstanceOf(PortClosedError);
  });

  it("a port closed or disposed while a body is being read rejects the request without posting it", async () => {
    const port = new ScriptedPort();
    const fetch = fetchOverPort(port);
    const request = fetch(`${base}/a`, { method: "POST", body: "payload" });
    fetch.dispose();
    await expect(request).rejects.toBeInstanceOf(PortClosedError);
    expect(port.posted).toEqual([]);

    const other = new ScriptedPort();
    const controller = new AbortController();
    const aborted = fetchOverPort(other)(`${base}/a`, { method: "POST", body: "payload", signal: controller.signal });
    controller.abort(new Error("while reading"));
    await expect(aborted).rejects.toThrow("while reading");
    expect(other.posted).toEqual([]);
  });

  it("timeoutMs rejects with a TimeoutError and tells the server side to abort", async () => {
    const port = new ScriptedPort();
    const fetch = fetchOverPort(port, { timeoutMs: 15 });
    await expect(fetch(`${base}/slow`)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(port.posted.map(({ message }) => (message as { type: string }).type))
      .toEqual(["openvaultdb/fetch-request", "openvaultdb/fetch-abort"]);
    // A request answered in time clears its timer.
    const quick = fetchOverPort(port, { timeoutMs: 1000 });
    const answered = quick(`${base}/quick`);
    await tick(0);
    port.deliver({ type: "openvaultdb/fetch-response", id: 1, ok: true, status: 200, statusText: "OK", headers: [], body: new ArrayBuffer(0) });
    expect((await answered).status).toBe(200);
  });

  it("removes its abort listener from the signal once the request settles", async () => {
    const added = new Set<unknown>();
    const removed = new Set<unknown>();
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (this: AbortSignal, ...args: Parameters<AbortSignal["addEventListener"]>) {
      if (args[0] === "abort") added.add(args[1]);
      EventTarget.prototype.addEventListener.apply(this, args);
    });
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (this: AbortSignal, ...args: Parameters<AbortSignal["removeEventListener"]>) {
      if (args[0] === "abort") removed.add(args[1]);
      EventTarget.prototype.removeEventListener.apply(this, args);
    });
    try {
      const { client, server } = channel();
      serveFetchOverPort(() => Promise.resolve(new Response("ok")), server);
      const fetch = fetchOverPort(client);
      expect(await (await fetch(`${base}/x`, { signal: new AbortController().signal })).text()).toBe("ok");
      const dead = new ScriptedPort();
      dead.failPost = () => true;
      await expect(fetchOverPort(dead)(`${base}/x`, { signal: new AbortController().signal })).rejects.toThrow("cannot post");
      const ours = [...added].filter((listener) => removed.has(listener));
      expect(ours.length).toBeGreaterThanOrEqual(2);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("turns a postMessage failure into a rejection, even when it throws a non-Error", async () => {
    const port = new ScriptedPort();
    port.failPost = () => true;
    await expect(fetchOverPort(port)(`${base}/x`)).rejects.toThrow("cannot post");
    const odd = new ScriptedPort();
    odd.postMessage = () => { throw "plain" as unknown as Error; };
    await expect(fetchOverPort(odd)(`${base}/x`)).rejects.toThrow("plain");
  });

  it("an abort whose notification cannot be posted still rejects the caller", async () => {
    const port = new ScriptedPort();
    port.failPost = (message) => (message as { type: string }).type === "openvaultdb/fetch-abort";
    const controller = new AbortController();
    const pending = fetchOverPort(port)(`${base}/x`, { signal: controller.signal });
    await tick(0);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("forwards an abort to the serving side, which aborts its fetch and drops the late response", async () => {
    const { client, server, raw } = channel();
    let seen: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    serveFetchOverPort((_input, init) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { finish = () => { resolve(new Response("late")); }; });
    }, server);
    const replies: unknown[] = [];
    raw[0].on("message", (data: unknown) => { replies.push(data); });
    const controller = new AbortController();
    const pending = fetchOverPort(client)(`${base}/x`, { signal: controller.signal });
    await tick();
    expect(seen?.aborted).toBe(false);
    controller.abort(new Error("gone"));
    await expect(pending).rejects.toThrow("gone");
    await tick();
    expect(seen?.aborted).toBe(true);
    finish();
    await tick();
    expect(replies).toEqual([]);
  });

  it("ignores an abort for an unknown request, and stopping aborts running requests", async () => {
    const port = new ScriptedPort();
    let seen: AbortSignal | undefined;
    const stop = serveFetchOverPort((_input, init) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }, port);
    port.deliver({ type: "openvaultdb/fetch-abort", id: 42 });
    port.deliver({ type: "openvaultdb/fetch-request", id: 1, method: "GET", url: `${base}/x`, headers: [] });
    await tick(0);
    expect(seen?.aborted).toBe(false);
    stop();
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(PortClosedError);
  });

  it("the serving side reports a reply it cannot post, and gives up quietly when even that fails", async () => {
    const answer = (): Response => new Response("ok");
    const once = new ScriptedPort();
    once.failPost = (message, count) => count === 0 && (message as { ok: boolean }).ok;
    serveFetchOverPort(() => Promise.resolve(answer()), once);
    once.deliver({ type: "openvaultdb/fetch-request", id: 1, method: "GET", url: `${base}/x`, headers: [] });
    await tick();
    expect(once.posted.map(({ message }) => message)).toMatchObject([{ id: 1, ok: false, message: "cannot post" }]);

    const never = new ScriptedPort();
    never.failPost = () => true;
    serveFetchOverPort(() => Promise.resolve(answer()), never);
    never.deliver({ type: "openvaultdb/fetch-request", id: 2, method: "GET", url: `${base}/x`, headers: [] });
    await tick();
    expect(never.posted).toEqual([]);

    const odd = new ScriptedPort();
    odd.postMessage = () => { throw "plain" as unknown as Error; };
    serveFetchOverPort(() => Promise.resolve(answer()), odd);
    odd.deliver({ type: "openvaultdb/fetch-request", id: 3, method: "GET", url: `${base}/x`, headers: [] });
    await tick();
  });
});
