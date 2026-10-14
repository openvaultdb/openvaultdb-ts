import { badRequest } from "./http.js";

type Data = Record<string, unknown>;

/** One field-level update in wire format (docs/api.md, "Update operation object"). */
export interface WireUpdate {
  readonly fieldName?: unknown;
  readonly fieldPath?: unknown;
  readonly value?: unknown;
  readonly delete?: unknown;
  readonly transform?: unknown;
  readonly serverTimestamp?: unknown;
}

export function isObject(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updatePath(update: WireUpdate, index: number): readonly string[] {
  const byName = update.fieldName !== undefined && update.fieldName !== "";
  const byPath = Array.isArray(update.fieldPath) && update.fieldPath.length > 0;
  if (byName && byPath) throw badRequest(`update ${index.toString()}: fieldName and fieldPath are mutually exclusive`);
  if (!byName && !byPath) throw badRequest(`update ${index.toString()}: one of fieldName or fieldPath is required`);
  const path: readonly unknown[] = byName ? [update.fieldName] : update.fieldPath as readonly unknown[];
  if (!path.every((segment): segment is string => typeof segment === "string" && segment !== "")) {
    throw badRequest(`update ${index.toString()}: empty field path segment`);
  }
  return path;
}

/** Walks to the object holding the last segment, creating objects on the way when create is set. */
function parentAt(data: Data, path: readonly string[], create: boolean): Data | undefined {
  let current = data;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined || child === null) {
      if (!create) return undefined;
      current[segment] = {};
    } else if (!isObject(child)) {
      if (!create) return undefined;
      throw badRequest(`field path segment ${JSON.stringify(segment)} is not an object`);
    }
    current = current[segment] as Data;
  }
  return current;
}

/** Applies wire updates to a copy of data, with the Go server's semantics (core.applyUpdates). */
export function applyUpdates(data: Readonly<Data>, updates: readonly WireUpdate[], now: Date): Data {
  const result = structuredClone(data) as Data;
  updates.forEach((update, index) => {
    if (!isObject(update)) throw badRequest(`update ${index.toString()}: must be an object`);
    const path = updatePath(update, index);
    const leaf = path[path.length - 1] as string;
    if (update.delete === true) {
      const parent = parentAt(result, path, false);
      if (parent !== undefined) Reflect.deleteProperty(parent, leaf);
      return;
    }
    if (update.serverTimestamp === true) {
      (parentAt(result, path, true) as Data)[leaf] = now.toISOString();
      return;
    }
    if (update.transform === "increment") {
      if (typeof update.value !== "number") throw badRequest(`update ${index.toString()}: increment value must be a number`);
      const parent = parentAt(result, path, true) as Data;
      const current = parent[leaf] ?? 0;
      if (typeof current !== "number") throw badRequest(`update ${index.toString()}: cannot increment non-numeric field ${JSON.stringify(leaf)}`);
      parent[leaf] = current + update.value;
      return;
    }
    if (update.transform !== undefined) throw badRequest(`update ${index.toString()}: unknown transform ${JSON.stringify(update.transform)}`);
    (parentAt(result, path, true) as Data)[leaf] = update.value;
  });
  return result;
}
