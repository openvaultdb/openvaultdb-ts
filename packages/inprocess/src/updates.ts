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

/** Keys that would reach Object.prototype or a constructor through a request-controlled path. */
const dangerousSegments: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The deepest nesting of a record body, update value or TugQL document, and the longest field path. */
export const maxNesting = 256;

/**
 * Refuses a record body or update value holding an own `__proto__` key at any
 * depth, or nested deeper than maxNesting. JSON.parse creates such keys as own
 * properties; spread, assign and some storage adapters would turn them into
 * prototype writes. It walks with an explicit stack, so a pathological depth
 * is refused instead of overflowing the call stack.
 */
export function rejectProtoKeys(value: unknown, context: string): void {
  const stack: [unknown, number][] = [[value, 1]];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [node, depth] = entry;
    if (!Array.isArray(node) && !isObject(node)) continue;
    if (depth > maxNesting) throw badRequest(`${context}: nesting too deep`);
    if (Array.isArray(node)) {
      for (const item of node as unknown[]) stack.push([item, depth + 1]);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "__proto__") throw badRequest(`${context}: field name "__proto__" is not allowed`);
      stack.push([child, depth + 1]);
    }
  }
}

/** Whether a parsed document nests arrays or objects deeper than maxNesting (an explicit stack, no recursion). */
export function nestsTooDeep(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [node, depth] = entry;
    if (typeof node !== "object" || node === null) continue;
    if (depth > maxNesting) return true;
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
}

function setOwn(target: Data, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function getOwn(target: Data, key: string): unknown {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

export function isObject(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updatePath(update: WireUpdate, index: number): readonly string[] {
  const byName = update.fieldName !== undefined && update.fieldName !== "";
  const byPath = Array.isArray(update.fieldPath) && update.fieldPath.length > 0;
  if (byName && byPath) throw badRequest(`update ${index.toString()}: fieldName and fieldPath are mutually exclusive`);
  if (!byName && !byPath) throw badRequest(`update ${index.toString()}: one of fieldName or fieldPath is required`);
  if (byPath && (update.fieldPath as readonly unknown[]).length > maxNesting) {
    throw badRequest(`update ${index.toString()}: field path nesting too deep`);
  }
  const path: readonly unknown[] = byName ? [update.fieldName] : update.fieldPath as readonly unknown[];
  if (!path.every((segment): segment is string => typeof segment === "string" && segment !== "")) {
    throw badRequest(`update ${index.toString()}: empty field path segment`);
  }
  const forbidden = path.find((segment) => dangerousSegments.has(segment));
  if (forbidden !== undefined) throw badRequest(`update ${index.toString()}: field path segment ${JSON.stringify(forbidden)} is not allowed`);
  return path;
}

/** Walks to the object holding the last segment, creating objects on the way when create is set. */
function parentAt(data: Data, path: readonly string[], create: boolean): Data | undefined {
  let current = data;
  for (const segment of path.slice(0, -1)) {
    const child = getOwn(current, segment);
    if (child === undefined || child === null) {
      if (!create) return undefined;
      setOwn(current, segment, {});
    } else if (!isObject(child)) {
      if (!create) return undefined;
      throw badRequest(`field path segment ${JSON.stringify(segment)} is not an object`);
    }
    current = getOwn(current, segment) as Data;
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
      setOwn(parentAt(result, path, true) as Data, leaf, now.toISOString());
      return;
    }
    if (update.transform === "increment") {
      if (typeof update.value !== "number") throw badRequest(`update ${index.toString()}: increment value must be a number`);
      const parent = parentAt(result, path, true) as Data;
      const current = getOwn(parent, leaf) ?? 0;
      if (typeof current !== "number") throw badRequest(`update ${index.toString()}: cannot increment non-numeric field ${JSON.stringify(leaf)}`);
      setOwn(parent, leaf, current + update.value);
      return;
    }
    if (update.transform !== undefined) throw badRequest(`update ${index.toString()}: unknown transform ${JSON.stringify(update.transform)}`);
    rejectProtoKeys(update.value, `update ${index.toString()}`);
    setOwn(parentAt(result, path, true) as Data, leaf, update.value);
  });
  return result;
}
