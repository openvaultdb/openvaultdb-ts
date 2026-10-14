/**
 * The part of a MessagePort the bridge uses. The DOM and Node
 * (`node:worker_threads`) MessagePorts both satisfy it.
 */
export interface FetchPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}

const requestType = "openvaultdb/fetch-request";
const responseType = "openvaultdb/fetch-response";

interface PortRequest {
  readonly type: typeof requestType;
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: ArrayBuffer;
}

type PortResponse = {
  readonly type: typeof responseType;
  readonly id: number;
} & ({
  readonly ok: true;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: ArrayBuffer;
} | {
  readonly ok: false;
  readonly name: string;
  readonly message: string;
});

function isMessage<T extends { readonly type: string }>(data: unknown, type: T["type"]): data is T {
  return typeof data === "object" && data !== null && (data as { readonly type?: unknown }).type === type;
}

/** Statuses whose responses carry no body (the Fetch spec's "null body status"). */
const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

/**
 * Answers requests that arrive on `port` with `fetch` (for example the fetch
 * of `createOvdbFetch` running in a worker). Returns a function that stops
 * serving. A failed fetch is sent back as a rejection with its name and message.
 */
export function serveFetchOverPort(fetch: typeof globalThis.fetch, port: FetchPort): () => void {
  const listener = (event: MessageEvent): void => {
    const request: unknown = event.data;
    if (!isMessage<PortRequest>(request, requestType)) return;
    void (async () => {
      let reply: PortResponse;
      const transfer: Transferable[] = [];
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers as [string, string][],
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        const body = await response.arrayBuffer();
        transfer.push(body);
        reply = {
          type: responseType, id: request.id, ok: true,
          status: response.status, statusText: response.statusText, headers: [...response.headers], body,
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        reply = { type: responseType, id: request.id, ok: false, name: failure.name, message: failure.message };
      }
      port.postMessage(reply, transfer);
    })();
  };
  port.addEventListener("message", listener);
  port.start?.();
  return () => {
    port.removeEventListener("message", listener);
  };
}

/**
 * A `fetch` that sends each request over `port` to `serveFetchOverPort` on the
 * other side and resolves with the response it answers. Bodies travel as
 * transferred ArrayBuffers.
 */
export function fetchOverPort(port: FetchPort): typeof globalThis.fetch {
  let nextId = 0;
  const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();
  port.addEventListener("message", (event: MessageEvent) => {
    const reply: unknown = event.data;
    if (!isMessage<PortResponse>(reply, responseType)) return;
    const waiter = pending.get(reply.id);
    if (waiter === undefined) return;
    pending.delete(reply.id);
    if (!reply.ok) {
      const error = reply.name === "TypeError" ? new TypeError(reply.message) : new Error(reply.message);
      error.name = reply.name;
      waiter.reject(error);
      return;
    }
    waiter.resolve(new Response(nullBodyStatuses.has(reply.status) ? null : reply.body, {
      status: reply.status,
      statusText: reply.statusText,
      headers: reply.headers as [string, string][],
    }));
  });
  port.start?.();
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    nextId += 1;
    const id = nextId;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // The other side keeps running; an abort only stops waiting for its answer.
      request.signal.addEventListener("abort", () => {
        pending.delete(id);
        reject(request.signal.reason as Error);
      }, { once: true });
      const message: PortRequest = {
        type: requestType, id, method: request.method, url: request.url, headers: [...request.headers],
        ...(body === undefined ? {} : { body }),
      };
      port.postMessage(message, body === undefined ? [] : [body]);
    });
  };
}
