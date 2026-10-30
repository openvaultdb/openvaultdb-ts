import { AlreadyExistsError, NotFoundError, UnsupportedError, type Key } from "@dalgo/core";

export type AccessTokenProvider = () => string | undefined | Promise<string | undefined>;

/** Fresh 128-bit correlation ID, never admission or authentication. */
export function createOpenVaultDbExecutionId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ordinary bounded response processing; no response or row replay store. */
export async function readOpenVaultDbJson(response: Response): Promise<unknown> {
  return readJson(response, 2 * 1024 * 1024, 10_000);
}

async function readJson(response: Response, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError("OpenVaultDB response body is required");
  const body = new Uint8Array(maxBytes);
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { reject(new TypeError("OpenVaultDB response body deadline exceeded")); }, timeoutMs);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new TypeError("OpenVaultDB response body budget exceeded (maximum 2 MiB)");
      }
      body.set(chunk.value, bytes - chunk.value.byteLength);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, bytes))) as unknown;
  } catch (error) {
    // Cancellation may itself be broken by a custom stream. Do not await it.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export interface OpenVaultDbClientOptions {
  readonly baseUrl: string;
  readonly databaseId: string;
  /** Independently configured gateway identity, required for live evidence. */
  readonly expectedServerId?: string;
  readonly accessToken?: string;
  readonly getAccessToken?: AccessTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
}

export class OpenVaultDbHttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(`OpenVaultDB request failed (${status.toString()} ${code}): ${message}`, options);
    this.name = "OpenVaultDbHttpError";
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("OpenVaultDB base URL must use http or https");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("OpenVaultDB base URL must not contain credentials, query parameters, or a fragment");
  }
  return url.href.replace(/\/$/u, "");
}

async function responseError(response: Response): Promise<OpenVaultDbHttpError> {
  let code = "unknown";
  let message = "request rejected";
  try {
    // Error bodies have a smaller finite byte/time budget and selected fields
    // are validated before constructing any retained Error string.
    const envelope = await readJson(response, 16 * 1024, 1_000);
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new TypeError("invalid error envelope");
    const detail = (envelope as Record<string, unknown>).error;
    if (typeof detail !== "object" || detail === null || Array.isArray(detail)) throw new TypeError("invalid error detail");
    const selected = detail as Record<string, unknown>;
    if (typeof selected.code !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(selected.code)
      || typeof selected.message !== "string" || selected.message.length > 4096) throw new TypeError("invalid error fields");
    code = selected.code;
    message = selected.message;
  } catch {
    // Keep only HTTP status on parse, byte, time, UTF-8 or field validation failure.
  }
  return new OpenVaultDbHttpError(response.status, code, message);
}

export function translateOpenVaultDbError(error: unknown, key?: Key): unknown {
  if (!(error instanceof OpenVaultDbHttpError)) return error;
  if (error.status === 404 && key !== undefined) return new NotFoundError(key, { cause: error });
  if (error.status === 409 && key !== undefined) return new AlreadyExistsError(key, { cause: error });
  if (error.status === 501 || (error.status === 422
    && (error.code === "not_supported" || error.code === "authorization_unsupported"))) {
    return new UnsupportedError(error.code, { cause: error });
  }
  return error;
}

export class OpenVaultDbClient {
  public readonly databaseId: string;
  public readonly expectedServerId: string | undefined;
  readonly #baseUrl: string;
  readonly #databaseId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #accessToken: string | undefined;
  readonly #getAccessToken: AccessTokenProvider | undefined;

  public constructor(options: OpenVaultDbClientOptions) {
    if (options.databaseId.trim().length === 0) throw new TypeError("OpenVaultDB database ID is required");
    if (options.accessToken !== undefined && options.getAccessToken !== undefined) {
      throw new TypeError("provide either accessToken or getAccessToken, not both");
    }
    this.databaseId = options.databaseId;
    this.expectedServerId = options.expectedServerId;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#databaseId = encodeURIComponent(options.databaseId);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#accessToken = options.accessToken;
    this.#getAccessToken = options.getAccessToken;
  }

  public recordPath(key: Key): string {
    return `/v1/databases/${this.#databaseId}/records/${key.path}`;
  }

  public queryPath(): string {
    return `/v1/databases/${this.#databaseId}/query`;
  }

  public batchPath(): string {
    return `/v1/databases/${this.#databaseId}/batch`;
  }

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.#getAccessToken === undefined
      ? this.#accessToken
      : await this.#getAccessToken();
    const headers = new Headers(init.headers);
    if (token !== undefined && token.length > 0) headers.set("Authorization", `Bearer ${token}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }
}
