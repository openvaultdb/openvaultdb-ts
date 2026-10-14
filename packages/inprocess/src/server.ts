import {
  isCapabilityAware,
  isResettable,
  type CapabilityAware,
  type Database,
  type DatabaseCapabilities,
  type Resettable,
} from "@dalgo/core";
import { bindJsonDocument, classifyDocument, maxLimit, maxOffset, parseYamlDocument, project, type CollectionDocument } from "./dtql.js";
import {
  badRequest,
  emptyResponse,
  errorResponse,
  invalidDtql,
  invalidKey,
  jsonResponse,
  mapError,
  notFound,
  OvdbHttpError,
  payloadTooLarge,
  readDenied,
  readOnly,
} from "./http.js";
import { parseKeyPath } from "./keys.js";
import { applyOps, parseBatch, type WriteOp } from "./ops.js";
import { parseWireQuery, runQuery, runWireQuery } from "./query.js";
import { maxSnapshotRows, SnapshotStore, type SnapshotScope } from "./snapshots.js";
import { rejectProtoKeys, type WireUpdate } from "./updates.js";

/** A DALgo database served in process; it may describe its capabilities and be resettable. */
export type OvdbDatabase = Database & Partial<CapabilityAware> & Partial<Resettable>;

/** The pristine published copy a resettable database restores. */
export interface CanonicalSource {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Whether the local copy of a resettable database differs from its canonical source. */
export interface LocalState {
  readonly modified: boolean;
}

export interface CreateOvdbFetchOptions {
  /** The origin (and optional path prefix) the fetch answers; any other origin is refused. */
  readonly baseUrl?: string;
  readonly databases: Readonly<Record<string, OvdbDatabase>>;
  readonly canonical?: Readonly<Record<string, CanonicalSource>>;
  readonly localState?: (databaseId: string) => LocalState;
  /** The largest request body accepted, in bytes (default 8 MiB); a larger one is answered 413 payload_too_large. */
  readonly maxBodyBytes?: number;
  /**
   * The largest DTQL/YAML document accepted, in bytes (default 256 KiB), checked while
   * reading and before any parsing; a larger one is answered 413 payload_too_large.
   * It also bounds a DTQL body below maxBodyBytes, which still caps record and batch bodies.
   */
  readonly maxDtqlBytes?: number;
}

export const defaultBaseUrl = "https://local.ovdb.invalid";

export const defaultMaxBodyBytes = 8 << 20;
export const defaultMaxDtqlBytes = 256 << 10;
const maxDtqlUrlBytes = 8 << 10;

/** The 405 for `method`, naming the methods the route does allow (a GET route allows HEAD too). */
const methodNotAllowed = (method: string, allowed: readonly string[]): OvdbHttpError => {
  const allow = allowed.includes("GET") ? [...allowed, "HEAD"] : allowed;
  return new OvdbHttpError(405, "bad_request", `method not allowed: ${method}`, { Allow: allow.join(", ") });
};

const recordMethods = ["GET", "PUT", "POST", "PATCH", "DELETE"] as const;

const queryProfile = {
  format: "dtql-yaml+json",
  features: {
    streaming: true,
    completionField: "complete",
    joins: [],
    groupBy: false,
    having: false,
    aggregates: [],
    subqueries: false,
    crossDatabase: false,
    externalSources: false,
    windowFunctions: false,
    protectedDatabases: false,
    fieldNames: "plain",
  },
  limits: { maxRequestBytes: defaultMaxBodyBytes, maxLimit, maxOffset },
  joinEngines: [],
} as const;

async function capabilitiesOf(db: OvdbDatabase): Promise<DatabaseCapabilities> {
  if (isCapabilityAware(db)) return db.capabilities();
  return { read: true, query: true, write: true, delete: true, reset: isResettable(db), persistent: false };
}

/** The capabilities map of a descriptor, keyed as the Go server keys it. */
async function wireCapabilities(db: OvdbDatabase): Promise<Readonly<Record<string, boolean>>> {
  const capabilities = await capabilitiesOf(db);
  return {
    read: capabilities.read,
    query: capabilities.query,
    dtql: capabilities.query,
    dtqlStreaming: capabilities.query,
    dtqlStreamingErrors: false,
    write: capabilities.write,
    delete: capabilities.delete,
    reset: capabilities.reset && isResettable(db),
    persistent: capabilities.persistent,
    joins: false,
    aggregation: false,
  };
}

/**
 * Reads a body and stops as soon as it passes the limit. A streaming body is read chunk by chunk;
 * a request without a `body` stream (Firefox leaves `Request.body` undefined) is read whole with
 * arrayBuffer() and checked afterwards, after the Content-Length check.
 * @internal
 */
export async function readBody(request: Request, limit: number, what?: string): Promise<string> {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > limit) throw payloadTooLarge(limit, what);
  // A missing stream is `null` per spec and `undefined` where Request.body is not implemented.
  const stream = (request as { body?: ReadableStream<Uint8Array> | null }).body;
  if (stream === null) return "";
  if (stream === undefined) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > limit) throw payloadTooLarge(limit, what);
    return new TextDecoder().decode(bytes);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw payloadTooLarge(limit, what);
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

/** @internal */
export async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const text = await readBody(request, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw badRequest(`invalid JSON body: ${(error as Error).message}`);
  }
}

function recordKeyPath(path: string): string {
  const raw = path.replace(/\/$/u, "");
  if (raw === "") throw invalidKey("invalid key: record key missing in path");
  return raw;
}

function pagingHeaders(request: Request): boolean {
  return ["OVDB-Page-Size", "OVDB-Page-Token", "OVDB-Page-Close"].some((name) => request.headers.has(name));
}

class InProcessServer {
  readonly #options: CreateOvdbFetchOptions;
  readonly #base: string;
  readonly #snapshots = new SnapshotStore();
  readonly #limit: number;
  readonly #dtqlLimit: number;

  public constructor(options: CreateOvdbFetchOptions, base: string) {
    this.#options = options;
    this.#base = base;
    this.#limit = options.maxBodyBytes ?? defaultMaxBodyBytes;
    this.#dtqlLimit = Math.min(this.#limit, options.maxDtqlBytes ?? defaultMaxDtqlBytes);
  }

  /** Answers `request`; `method` is what the caller asked, which differs from request.method for a HEAD served as a GET. */
  public async route(request: Request, path: string, url: URL, method = request.method): Promise<Response> {
    if (path === "/.well-known/openvaultdb") {
      if (request.method !== "GET") throw methodNotAllowed(method, ["GET"]);
      return this.#wellKnown();
    }
    const match = /^\/v1\/databases\/([^/]+)(\/.*)?$/u.exec(path);
    if (match === null) throw notFound("not found");
    const id = this.#databaseId(match[1] as string);
    const db = this.#database(id);
    const rest = match[2] ?? "";
    if (rest.startsWith("/records/")) return this.#record(request, db, rest.slice("/records/".length));
    const routes: Readonly<Record<string, readonly string[]>> = {
      "": ["GET"], "/batch": ["POST"], "/query": ["GET", "POST"], "/dtql": ["GET", "POST"], "/reset": ["POST"],
    };
    const methods = routes[rest];
    if (methods === undefined) throw notFound("not found");
    if (!methods.includes(request.method)) throw methodNotAllowed(method, methods);
    switch (rest) {
      case "":
        return this.#descriptor(id, db);
      case "/batch":
        return this.#batch(request, db);
      case "/query":
        return this.#query(request, url, id, db);
      case "/dtql":
        return this.#dtql(request, url, id, db);
      default:
        return this.#reset(id, db);
    }
  }

  #databaseId(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw notFound(`database not found: ${segment}`);
    }
  }

  #database(id: string): OvdbDatabase {
    const db = Object.hasOwn(this.#options.databases, id) ? this.#options.databases[id] : undefined;
    if (db === undefined) throw notFound(`database not found: ${id}`);
    return db;
  }

  async #wellKnown(): Promise<Response> {
    const origin = new URL(this.#base).origin;
    const databases = await Promise.all(Object.keys(this.#options.databases).sort().map(async (id) => ({
      id,
      url: `${origin}/ovdb/dbs/${encodeURIComponent(id)}`,
      apiUrl: `${this.#base}/v1/databases/${encodeURIComponent(id)}`,
      capabilities: await wireCapabilities(this.#database(id)),
    })));
    return jsonResponse({
      name: "OpenVaultDB",
      protocol: "openvaultdb/0.1",
      version: "inprocess",
      authEnabled: false,
      query: queryProfile,
      databases,
    });
  }

  async #descriptor(id: string, db: OvdbDatabase): Promise<Response> {
    const capabilities = await wireCapabilities(db);
    const canonical = this.#options.canonical?.[id];
    const resettable = isResettable(db);
    return jsonResponse({
      id,
      engine: "inprocess",
      schemaMode: "schemaless",
      collections: [],
      capabilities,
      ...(capabilities.dtql === true
        ? { endpoints: { dtql: `${this.#base}/v1/databases/${encodeURIComponent(id)}/dtql` }, queryFormat: "dtql-yaml+json" }
        : {}),
      ...(resettable && canonical !== undefined ? { canonical } : {}),
      ...(resettable && this.#options.localState !== undefined ? { localState: this.#options.localState(id) } : {}),
    });
  }

  async #guardWrites(db: OvdbDatabase): Promise<DatabaseCapabilities> {
    const capabilities = await capabilitiesOf(db);
    if (!capabilities.write) throw readOnly();
    return capabilities;
  }

  async #guardReads(db: OvdbDatabase): Promise<void> {
    if (!(await capabilitiesOf(db)).read) throw readDenied();
  }

  async #apply(db: OvdbDatabase, ops: readonly WriteOp[], capabilities: DatabaseCapabilities): Promise<number> {
    if (!capabilities.delete && ops.some(({ op }) => op === "delete")) throw readOnly();
    return applyOps(db, ops, new Date());
  }

  async #record(request: Request, db: OvdbDatabase, path: string): Promise<Response> {
    const method = request.method;
    if (method === "HEAD") {
      try {
        await this.#guardReads(db);
        const snapshot = await db.get(parseKeyPath(recordKeyPath(path)));
        return emptyResponse(snapshot.exists ? 200 : 404);
      } catch (error) {
        const status = error instanceof OvdbHttpError ? { invalid_key: 400, read_denied: 403 }[error.code] : undefined;
        return emptyResponse(status ?? 404);
      }
    }
    if (method === "GET") {
      await this.#guardReads(db);
      const key = parseKeyPath(recordKeyPath(path));
      const snapshot = await db.get(key);
      if (!snapshot.exists) throw notFound(`record not found: ${key.path}`);
      return jsonResponse({ key: key.path, data: snapshot.data });
    }
    if (!(recordMethods as readonly string[]).includes(method)) throw methodNotAllowed(method, recordMethods);
    const capabilities = await this.#guardWrites(db);
    const key = parseKeyPath(recordKeyPath(path));
    if (method === "DELETE") {
      await this.#apply(db, [{ op: "delete", key }], capabilities);
      return emptyResponse(204);
    }
    const body = await readJsonBody(request, this.#limit);
    if (method === "PATCH") {
      const updates = (body as { readonly updates?: unknown } | null)?.updates;
      if (!Array.isArray(updates) || updates.length === 0) throw badRequest('body must contain a non-empty "updates" array');
      await this.#apply(db, [{ op: "update", key, updates: updates as readonly WireUpdate[] }], capabilities);
      return emptyResponse(204);
    }
    const data = (body as { readonly data?: unknown } | null)?.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw badRequest('body must contain a "data" object');
    rejectProtoKeys(data, "data");
    const insert = method === "POST";
    await this.#apply(db, [{ op: insert ? "insert" : "set", key, data: data as Record<string, unknown> }], capabilities);
    return emptyResponse(insert ? 201 : 204);
  }

  async #batch(request: Request, db: OvdbDatabase): Promise<Response> {
    const capabilities = await this.#guardWrites(db);
    const ops = parseBatch(await readJsonBody(request, this.#limit));
    return jsonResponse({ applied: await this.#apply(db, ops, capabilities) });
  }

  async #guardQueries(id: string, db: OvdbDatabase): Promise<void> {
    if (!(await capabilitiesOf(db)).query) {
      throw new OvdbHttpError(501, "query_unsupported",
        `structured queries are not supported by the "inprocess" storage engine of database ${JSON.stringify(id)}`);
    }
  }

  async #query(request: Request, url: URL, id: string, db: OvdbDatabase): Promise<Response> {
    await this.#guardQueries(id, db);
    await this.#guardReads(db);
    let body: unknown;
    if (request.method === "GET") {
      const q = url.searchParams.getAll("q");
      if (q.length !== 1 || q[0] === "") throw badRequest('query parameter "q" is required');
      try {
        body = JSON.parse(q[0] as string) as unknown;
      } catch (error) {
        throw badRequest(`invalid JSON query: ${(error as Error).message}`);
      }
    } else {
      body = await readJsonBody(request, this.#limit);
    }
    const records = await runWireQuery(db, parseWireQuery(body));
    return jsonResponse({ records, complete: true });
  }

  async #dtqlDocument(request: Request, url: URL): Promise<unknown> {
    if (request.method === "GET") {
      if (url.pathname.length + url.search.length > maxDtqlUrlBytes) {
        throw new OvdbHttpError(414, "bad_request", "DTQL URL exceeds 8 KiB limit");
      }
      for (const name of url.searchParams.keys()) {
        if (name !== "q" && name !== "parameters") throw badRequest(`unsupported DTQL URL parameter ${JSON.stringify(name)}`);
      }
      const q = url.searchParams.getAll("q");
      if (q.length !== 1 || (q[0] as string).trim() === "") throw badRequest("DTQL URL requires exactly one nonempty q parameter");
      const raw = url.searchParams.getAll("parameters");
      let parameters: unknown = {};
      if (raw.length > 0) {
        if (raw.length !== 1 || raw[0] === "") throw badRequest("DTQL URL requires one JSON parameters object");
        try {
          parameters = JSON.parse(raw[0] as string) as unknown;
        } catch {
          throw badRequest("DTQL URL parameters must be a JSON object");
        }
      }
      try {
        return bindJsonDocument({ query: q[0], parameters });
      } catch (error) {
        throw badRequest((error as Error).message);
      }
    }
    const text = await readBody(request, this.#dtqlLimit, "DTQL document (maxDtqlBytes)");
    if (text === "") throw badRequest("body must contain a DTQL YAML document");
    const contentType = (request.headers.get("Content-Type") ?? "").replace(/;.*$/su, "").trim().toLowerCase();
    if (contentType !== "application/json") return parseYamlDocument(text);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw invalidDtql(`invalid DTQL JSON: ${(error as Error).message}`);
    }
    return bindJsonDocument(payload);
  }

  async #dtql(request: Request, url: URL, id: string, db: OvdbDatabase): Promise<Response> {
    await this.#guardQueries(id, db);
    await this.#guardReads(db);
    const document = await this.#dtqlDocument(request, url);
    const classified = classifyDocument(document, id);
    if (pagingHeaders(request)) return this.#pagedDtql(request, id, db, document, classified);
    const rows = await runQuery(db, classified.query);
    return jsonResponse({
      records: rows.map(({ key, data }) => ({ key, data: project(data, classified.columns) })),
      complete: true,
    });
  }

  async #pagedDtql(
    request: Request, id: string, db: OvdbDatabase, document: unknown, classified: CollectionDocument,
  ): Promise<Response> {
    const size = request.headers.get("OVDB-Page-Size") ?? "";
    const pageSize = /^[0-9]{1,4}$/u.test(size) ? Number(size) : 0;
    if (pageSize < 1 || pageSize > 1000) throw badRequest("OVDB-Page-Size must be 1..1000");
    if (classified.bounded) throw invalidDtql("paged DTQL requires limit and offset to be zero");
    const scope: SnapshotScope = {
      databaseId: id,
      queryHash: JSON.stringify(document),
      pageSize,
      actor: request.headers.get("Authorization") ?? "",
    };
    const close = request.headers.get("OVDB-Page-Close");
    if (close !== null && close !== "true") throw badRequest("OVDB-Page-Close must be true");
    const token = request.headers.get("OVDB-Page-Token") ?? "";
    if (close === "true") {
      if (token === "") throw badRequest("OVDB-Page-Token is required to close a snapshot");
      this.#snapshots.close(token, scope);
      return emptyResponse(204);
    }
    if (token !== "") return jsonResponse(this.#snapshots.page(token, scope));
    const release = this.#snapshots.reserve();
    try {
      const rows = await runQuery(db, { ...classified.query, limit: maxSnapshotRows + 1 });
      return jsonResponse(this.#snapshots.capture(scope, rows.map(({ key, data }) => ({ key, data: project(data, classified.columns) }))));
    } finally {
      release();
    }
  }

  async #reset(id: string, db: OvdbDatabase): Promise<Response> {
    if (!isResettable(db)) throw notFound(`database ${id} cannot be reset`);
    if (!(await capabilitiesOf(db)).reset) throw readOnly();
    await db.reset();
    return emptyResponse(204);
  }
}

/**
 * Creates an in-process OpenVaultDB server exposed as a standard `fetch`. It
 * answers requests to `baseUrl` from the given DALgo databases, with the
 * routes, statuses and error envelopes of `ovdb serve`, and never touches the
 * network: a request to any other origin is rejected.
 */
function checkLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
}

export function createOvdbFetch(options: CreateOvdbFetchOptions): typeof globalThis.fetch {
  checkLimit("maxBodyBytes", options.maxBodyBytes);
  checkLimit("maxDtqlBytes", options.maxDtqlBytes);
  const base = new URL(options.baseUrl ?? defaultBaseUrl);
  const prefix = base.pathname.replace(/\/$/u, "");
  const server = new InProcessServer(options, base.origin + prefix);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin) {
      throw new TypeError(`the in-process OpenVaultDB fetch serves ${base.origin} only, not ${url.origin}`);
    }
    const head = request.method === "HEAD";
    let answer: Response;
    try {
      if (!url.pathname.startsWith(`${prefix}/`)) throw notFound("not found");
      const path = url.pathname.slice(prefix.length);
      // HEAD answers like GET on the routes other than a record's, which answers it itself.
      const served = head && !/^\/v1\/databases\/[^/]+\/records\//u.test(path) ? new Request(request, { method: "GET" }) : request;
      answer = await server.route(served, path, url, request.method);
    } catch (error) {
      answer = errorResponse(mapError(error));
    }
    // A HEAD answer, success or failure, is the status and headers only.
    return head ? new Response(null, { status: answer.status, headers: answer.headers }) : answer;
  };
}
