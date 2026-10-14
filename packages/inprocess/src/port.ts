/**
 * The part of a MessagePort the bridge uses. The DOM and Node
 * (`node:worker_threads`) MessagePorts both satisfy it. Its `close` event lets
 * pending requests fail as soon as the far side goes away.
 */
export interface FetchPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  start?(): void;
}

/** A request failed because the port was closed or disposed before an answer arrived. */
export class PortClosedError extends Error {
  public constructor(message = "the port is closed") {
    super(message);
    this.name = "PortClosedError";
  }
}

export interface FetchOverPortOptions {
  /** Rejects a request that has no answer after this many milliseconds. Off by default. */
  readonly timeoutMs?: number;
}

/** The fetch of `fetchOverPort`, with a way to release the port. */
export type FetchOverPort = typeof globalThis.fetch & {
  /** Stops listening and rejects every pending request with PortClosedError. */
  dispose(): void;
};

const requestType = "openvaultdb/fetch-request";
const responseType = "openvaultdb/fetch-response";
const abortType = "openvaultdb/fetch-abort";

interface PortRequest {
  readonly type: typeof requestType;
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: ArrayBuffer;
}

interface PortAbort {
  readonly type: typeof abortType;
  readonly id: number;
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
 * of `createOvdbFetch` running in a worker). Each request runs with its own
 * AbortSignal, aborted when the other side aborts the request, and a response
 * that finishes after an abort is dropped. Returns a function that stops
 * serving and aborts what is still running. A failed fetch is sent back as a
 * rejection with its name and message.
 */
export function serveFetchOverPort(fetch: typeof globalThis.fetch, port: FetchPort): () => void {
  const running = new Map<number, AbortController>();
  const listener = (event: MessageEvent): void => {
    const message: unknown = event.data;
    if (isMessage<PortAbort>(message, abortType)) {
      running.get(message.id)?.abort(new PortClosedError("the request was aborted"));
      return;
    }
    const request = message;
    if (!isMessage<PortRequest>(request, requestType)) return;
    const controller = new AbortController();
    running.set(request.id, controller);
    void (async () => {
      let reply: PortResponse;
      const transfer: Transferable[] = [];
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers as [string, string][],
          signal: controller.signal,
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
      const dropped = controller.signal.aborted;
      running.delete(request.id);
      if (dropped) return;
      try {
        port.postMessage(reply, transfer);
      } catch (error) {
        // The answer could not be posted; tell the caller instead of leaving it waiting.
        const failure = error instanceof Error ? error : new Error(String(error));
        try {
          port.postMessage({ type: responseType, id: request.id, ok: false, name: failure.name, message: failure.message }, []);
        } catch {
          // The port is unusable: the caller learns from its close event or timeout.
        }
      }
    })();
  };
  port.addEventListener("message", listener);
  port.start?.();
  return () => {
    port.removeEventListener("message", listener);
    for (const controller of running.values()) controller.abort(new PortClosedError("serving stopped"));
    running.clear();
  };
}

interface Waiter {
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A `fetch` that sends each request over `port` to `serveFetchOverPort` on the
 * other side and resolves with the response it answers. Bodies travel as
 * transferred ArrayBuffers. Aborting a request tells the other side to abort
 * it too. Every pending request rejects with `PortClosedError` when the port
 * closes or `dispose()` is called, and with a `TimeoutError` after
 * `timeoutMs` when that option is set.
 */
export function fetchOverPort(port: FetchPort, options: FetchOverPortOptions = {}): FetchOverPort {
  let nextId = 0;
  const state = { closed: false };
  const isClosed = (): boolean => state.closed;
  const pending = new Map<number, Waiter>();
  const onMessage = (event: MessageEvent): void => {
    const reply: unknown = event.data;
    if (!isMessage<PortResponse>(reply, responseType)) return;
    const waiter = pending.get(reply.id);
    if (waiter === undefined) return;
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
  };
  const close = (): void => {
    if (state.closed) return;
    state.closed = true;
    port.removeEventListener("message", onMessage);
    port.removeEventListener("close", close);
    for (const waiter of [...pending.values()]) waiter.reject(new PortClosedError());
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("close", close);
  port.start?.();
  const send = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (isClosed()) throw new PortClosedError();
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    request.signal.throwIfAborted();
    if (isClosed()) throw new PortClosedError();
    nextId += 1;
    const id = nextId;
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        pending.delete(id);
        request.signal.removeEventListener("abort", onAbort);
        clearTimeout(timer);
      };
      const onAbort = (): void => {
        settle();
        notify({ type: abortType, id });
        reject(request.signal.reason as Error);
      };
      pending.set(id, {
        resolve: (response) => { settle(); resolve(response); },
        reject: (error) => { settle(); reject(error); },
      });
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle();
          notify({ type: abortType, id });
          reject(new DOMException(`no answer within ${(options.timeoutMs as number).toString()} ms`, "TimeoutError"));
        }, options.timeoutMs);
      }
      const message: PortRequest = {
        type: requestType, id, method: request.method, url: request.url, headers: [...request.headers],
        ...(body === undefined ? {} : { body }),
      };
      try {
        port.postMessage(message, body === undefined ? [] : [body]);
      } catch (error) {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const notify = (message: PortAbort): void => {
    try {
      port.postMessage(message, []);
    } catch {
      // The far side is unreachable; there is nothing left to abort.
    }
  };
  return Object.assign(send, { dispose: close });
}
