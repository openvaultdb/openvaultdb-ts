import {
  AlreadyExistsError,
  Key,
  type CapabilityAware,
  type Database,
  type DatabaseCapabilities,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type Resettable,
  type StructuredQuery,
  type UpdateData,
} from "@dalgo/core";

type Data = Record<string, unknown>;
type Store = Map<string, { readonly key: Key; readonly data: Data }>;

export const writable: DatabaseCapabilities = {
  read: true, query: true, write: true, delete: true, reset: false, persistent: false,
};

export const readOnlyCapabilities: DatabaseCapabilities = { ...writable, write: false, delete: false };

function compare(left: unknown, right: unknown): number {
  return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0;
}

function matches(data: Data, { field, operator, value }: QueryFilter<Data>): boolean {
  const actual = data[field];
  switch (operator) {
    case "==": return actual === value;
    case "!=": return actual !== value;
    case "<": return compare(actual, value) < 0;
    case "<=": return compare(actual, value) <= 0;
    case ">": return compare(actual, value) > 0;
    case ">=": return compare(actual, value) >= 0;
    case "in": return (value as unknown[]).includes(actual);
    case "not-in": return !(value as unknown[]).includes(actual);
    case "array-contains": return Array.isArray(actual) && actual.includes(value);
    case "array-contains-any": return Array.isArray(actual) && (value as unknown[]).some((item) => actual.includes(item));
  }
}

function snapshot<T>(store: Store, key: Key): RecordSnapshot<T> {
  const record = store.get(key.path);
  return record === undefined ? { key, exists: false } : { key, exists: true, data: structuredClone(record.data) as T };
}

/** A Map-backed DALgo database: transactions write to a copy that replaces the store on success. */
export class MapDatabase implements Database, CapabilityAware {
  public store: Store = new Map();
  public caps: DatabaseCapabilities;
  public readonly queries: StructuredQuery<Data>[] = [];
  /** Runs before every transactional write, so a test can make the store refuse one. */
  public beforeWrite: ((key: Key, data: Data | undefined) => void) | undefined;

  public constructor(caps: DatabaseCapabilities = writable, records: Readonly<Record<string, Data>> = {}) {
    this.caps = caps;
    for (const [path, data] of Object.entries(records)) {
      const [collection, id] = path.split("/") as [string, string];
      this.store.set(path, { key: new Key(collection, id), data });
    }
  }

  public capabilities(): Promise<DatabaseCapabilities> {
    return Promise.resolve(this.caps);
  }

  public get<T>(key: Key): Promise<RecordSnapshot<T>> {
    return Promise.resolve(snapshot<T>(this.store, key));
  }

  public getMany<T>(keys: readonly Key[]): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get<T>(key)));
  }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    this.queries.push(query as StructuredQuery<Data>);
    const parent = query.source.kind === "collection" ? query.source.parent?.path : undefined;
    let rows = [...this.store.values()].filter(({ key, data }) => key.collection === query.source.name
      && key.parent?.path === parent
      && query.filters.every((filter) => matches(data, filter as QueryFilter<Data>)));
    for (const order of [...query.orders].reverse()) {
      rows = rows.sort((a, b) => compare(a.data[order.field], b.data[order.field]) * (order.direction === "desc" ? -1 : 1));
    }
    const start = query.offset ?? 0;
    rows = rows.slice(start, query.limit === undefined ? undefined : start + query.limit);
    return Promise.resolve({ records: rows.map(({ key, data }) => ({ key, exists: true, data: data as T })) });
  }

  public async runReadwriteTransaction<Result>(callback: (tx: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    const working: Store = new Map(this.store);
    const write = (key: Key, data: Data | undefined): void => {
      this.beforeWrite?.(key, data);
      if (data === undefined) working.delete(key.path);
      else working.set(key.path, { key, data: structuredClone(data) });
    };
    const tx: ReadwriteTransaction = {
      get: <T>(key: Key) => Promise.resolve(snapshot<T>(working, key)),
      getMany: <T>(keys: readonly Key[]) => Promise.resolve(keys.map((key) => snapshot<T>(working, key))),
      insert: (key, data) => {
        if (working.has(key.path)) return Promise.reject(new AlreadyExistsError(key));
        write(key, data as Data);
        return Promise.resolve();
      },
      set: (key, data) => {
        write(key, data as Data);
        return Promise.resolve();
      },
      update: (key: Key, data: UpdateData) => {
        write(key, { ...working.get(key.path)?.data, ...data });
        return Promise.resolve();
      },
      delete: (key) => {
        write(key, undefined);
        return Promise.resolve();
      },
    };
    const result = await callback(tx);
    this.store = working;
    return result;
  }
}

/** A MapDatabase that restores its initial records on reset. */
export class ResettableMapDatabase extends MapDatabase implements Resettable {
  readonly #initial: Store;

  public constructor(caps: DatabaseCapabilities, records: Readonly<Record<string, Data>>) {
    super(caps, records);
    this.#initial = new Map(this.store);
  }

  public reset(): Promise<void> {
    this.store = new Map(this.#initial);
    return Promise.resolve();
  }
}
