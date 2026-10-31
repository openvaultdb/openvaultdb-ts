import {
  AlreadyExistsError,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  snapshotQueryMetadata,
  type Codec,
  type Database,
  type Key,
  type QueryPage,
  type QueryMetadata,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dalgo/core";
import {
  OpenVaultDbClient,
  OpenVaultDbHttpError,
  readOpenVaultDbJson,
  translateOpenVaultDbError,
  type OpenVaultDbClientOptions,
} from "./client.js";
import { executeOpenVaultDbQuery, type OpenVaultDbQueryOptions } from "./query.js";

interface RecordResponse extends QueryMetadata {
  readonly key: string;
  readonly data: unknown;
}

interface WireUpdate {
  readonly fieldName?: string;
  readonly fieldPath?: readonly string[];
  readonly value: unknown;
}

interface WireOperation {
  readonly op: "set" | "insert" | "update" | "delete";
  readonly key: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly updates?: readonly WireUpdate[];
}

interface BufferedValue {
  readonly state: "value";
  readonly data: Readonly<Record<string, unknown>>;
}

interface BufferedDeletion {
  readonly state: "deleted";
}

type BufferedRecord = BufferedValue | BufferedDeletion;

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function objectData(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("OpenVaultDB record data must encode to a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function wireUpdates(update: UpdateData): readonly WireUpdate[] {
  return Object.entries(update).map(([path, value]) => {
    const parts = path.split(".");
    if (parts.some((part) => part.length === 0)) throw new TypeError(`invalid update field path: ${path}`);
    return parts.length === 1
      ? { fieldName: path, value }
      : { fieldPath: parts, value };
  });
}

function applyUpdate(data: Readonly<Record<string, unknown>>, update: UpdateData): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...data };
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const child = target[part];
      target[part] = typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...child as Record<string, unknown> }
        : {};
      target = target[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1);
    if (leaf !== undefined) target[leaf] = value;
  }
  return result;
}

async function getRecord<T>(client: OpenVaultDbClient, key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
  try {
    const response = await client.request(client.recordPath(key));
    const raw = await readOpenVaultDbJson(response);
    // Presence, including null/malformed values, cannot be laundered by the
    // legacy metadata snapshot or decoded through the point-read API.
    if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "sourceComposition")) {
      throw new UnsupportedError("OpenVaultDB sourceComposition responses");
    }
    const body = raw as RecordResponse;
    // The generic point-read API has no independent provider plan. Never drop
    // live evidence or mislabel an unverified point read as an admitted result.
    if (body.providerReads !== undefined) throw new UnsupportedError("OpenVaultDB provider point reads require a query plan");
    const evidence = snapshotQueryMetadata(body);
    return {
      key,
      exists: true,
      data: codecOrIdentity(codec).decode(body.data),
      metadata: { source: "openvaultdb", ...evidence },
    };
  } catch (error) {
    if (error instanceof OpenVaultDbHttpError && error.status === 404) {
      return { key, exists: false, metadata: { source: "openvaultdb" } };
    }
    throw translateOpenVaultDbError(error, key);
  }
}

class OpenVaultDbReadwriteTransaction implements ReadwriteTransaction {
  readonly #client: OpenVaultDbClient;
  readonly #operations: WireOperation[] = [];
  readonly #buffer = new Map<string, BufferedRecord>();
  readonly #keys = new Map<string, Key>();

  public constructor(client: OpenVaultDbClient) {
    this.#client = client;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const buffered = this.#buffer.get(key.path);
    if (buffered?.state === "deleted") return { key, exists: false, metadata: { source: "openvaultdb-buffer" } };
    if (buffered?.state === "value") {
      return {
        key,
        exists: true,
        data: codecOrIdentity(codec).decode(buffered.data),
        metadata: { source: "openvaultdb-buffer" },
      };
    }
    return getRecord(this.#client, key, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get(key, codec)));
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const current = this.#buffer.get(key.path);
    if (current?.state === "value") return Promise.reject(new AlreadyExistsError(key));
    const encoded = objectData(codecOrIdentity(codec).encode(data));
    this.addOperation(key, { op: "insert", key: key.path, data: encoded }, { state: "value", data: encoded });
    return Promise.resolve();
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const encoded = objectData(codecOrIdentity(codec).encode(data));
    this.addOperation(key, { op: "set", key: key.path, data: encoded }, { state: "value", data: encoded });
    return Promise.resolve();
  }

  public async update(key: Key, update: UpdateData): Promise<void> {
    let buffered = this.#buffer.get(key.path);
    if (buffered === undefined) {
      const existing = await getRecord<Readonly<Record<string, unknown>>>(this.#client, key);
      if (!existing.exists) throw new NotFoundError(key);
      buffered = { state: "value", data: objectData(existing.data) };
    }
    if (buffered.state === "deleted") throw new NotFoundError(key);
    const data = applyUpdate(buffered.data, update);
    this.addOperation(key, { op: "update", key: key.path, updates: wireUpdates(update) }, { state: "value", data });
  }

  public delete(key: Key): Promise<void> {
    this.addOperation(key, { op: "delete", key: key.path }, { state: "deleted" });
    return Promise.resolve();
  }

  public async commit(): Promise<void> {
    if (this.#operations.length === 0) return;
    try {
      await this.#client.request(this.#client.batchPath(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: this.#operations }),
      });
    } catch (error) {
      if (error instanceof OpenVaultDbHttpError && error.status === 409) {
        const operation = this.#operations.find(({ op }) => op === "insert");
        const key = operation === undefined ? undefined : this.#keys.get(operation.key);
        if (key !== undefined) throw new AlreadyExistsError(key, { cause: error });
      }
      if (error instanceof OpenVaultDbHttpError && error.status === 404) {
        const operation = this.#operations.find(({ op }) => op === "update");
        const key = operation === undefined ? undefined : this.#keys.get(operation.key);
        if (key !== undefined) throw new NotFoundError(key, { cause: error });
      }
      throw translateOpenVaultDbError(error);
    }
  }

  private addOperation(key: Key, operation: WireOperation, buffered: BufferedRecord): void {
    this.#keys.set(key.path, key);
    this.#operations.push(operation);
    this.#buffer.set(key.path, buffered);
  }
}

export type OpenVaultDbDatabaseOptions = OpenVaultDbClientOptions;

export class OpenVaultDbDatabase implements Database {
  readonly #client: OpenVaultDbClient;

  public constructor(options: OpenVaultDbDatabaseOptions) {
    this.#client = new OpenVaultDbClient(options);
  }

  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return getRecord(this.#client, key, codec);
  }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get(key, codec)));
  }

  public query<T>(query: StructuredQuery<T>, options?: OpenVaultDbQueryOptions): Promise<QueryPage<T>> {
    return executeOpenVaultDbQuery(this.#client, query, options);
  }

  public async runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    const transaction = new OpenVaultDbReadwriteTransaction(this.#client);
    const result = await callback(transaction);
    await transaction.commit();
    return result;
  }
}
