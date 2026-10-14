import type { Database, Key, QueryFilter, QueryOperator, QueryOrder, StructuredQuery } from "@dalgo/core";
import { badRequest, invalidKey, OvdbHttpError } from "./http.js";
import { parseKeyPath, validateCollection } from "./keys.js";
import { isObject } from "./updates.js";

type Data = Record<string, unknown>;

/** One row of a query answer: the full key path from the database root and the record data. */
export interface Row {
  readonly key: string;
  readonly data?: Data | undefined;
}

const wireOperators: ReadonlySet<string> = new Set<QueryOperator>([
  "==", "<", "<=", ">", ">=", "in", "array-contains", "array-contains-any",
]);

function prefixed<T>(prefix: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    const refusal = error as OvdbHttpError;
    throw new OvdbHttpError(refusal.status, refusal.code, `${prefix}: ${refusal.message}`);
  }
}

function field(value: unknown, context: string): string {
  if (typeof value !== "string" || value === "") throw badRequest(`${context}: field is required`);
  if (value === "__proto__") throw badRequest(`${context}: field name "__proto__" is not allowed`);
  return value;
}

const isScalar = (value: unknown): boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Checks the operand of a where entry has the shape its operator needs. */
function operand(op: QueryOperator, value: unknown, context: string): void {
  if (op === "in" || op === "array-contains-any") {
    if (!Array.isArray(value) || !value.every(isScalar)) throw badRequest(`${context}: operator ${op} needs an array of scalars`);
  } else if (op === "==") {
    if (value !== null && !isScalar(value)) throw badRequest(`${context}: operator == needs a scalar or null`);
  } else if (!isScalar(value)) {
    throw badRequest(`${context}: operator ${op} needs a scalar`);
  }
}

/** A /query body (docs/api.md, "Query") as a DALgo structured query. */
export interface WireQuery {
  readonly query: StructuredQuery<Data>;
  readonly keysOnly: boolean;
}

export function parseWireQuery(body: unknown): WireQuery {
  if (!isObject(body)) throw badRequest("invalid JSON body: the query must be an object");
  const { collection, parent, where, orderBy, limit, keysOnly } = body;
  if (typeof collection !== "string") throw invalidKey("query: collection: invalid key: empty segment");
  prefixed("query: collection", () => { validateCollection(collection); });
  const parentKey: Key | undefined = parent === undefined || parent === ""
    ? undefined
    : prefixed("query: parent", () => parseKeyPath(typeof parent === "string" ? parent : ""));
  if (where !== undefined && !Array.isArray(where)) throw badRequest("where must be an array");
  if (orderBy !== undefined && !Array.isArray(orderBy)) throw badRequest("orderBy must be an array");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 0)) {
    throw badRequest("limit must be a non-negative integer");
  }
  if (keysOnly !== undefined && typeof keysOnly !== "boolean") throw badRequest("keysOnly must be a boolean");
  const filters = (where ?? []).map((raw: unknown, index): QueryFilter<Data> => {
    const filter = isObject(raw) ? raw : {};
    const name = field(filter.field, `where[${index.toString()}]`);
    if (typeof filter.op !== "string" || !wireOperators.has(filter.op)) {
      throw badRequest(`unsupported operator ${JSON.stringify(filter.op)}`);
    }
    operand(filter.op as QueryOperator, filter.value, `where[${index.toString()}]`);
    return { field: name, operator: filter.op as QueryOperator, value: filter.value };
  });
  const orders = (orderBy ?? []).map((raw: unknown, index): QueryOrder<Data> => {
    const order = isObject(raw) ? raw : {};
    return { field: field(order.field, `orderBy[${index.toString()}]`), direction: order.desc === true ? "desc" : "asc" };
  });
  return {
    keysOnly: keysOnly === true,
    query: {
      source: { kind: "collection", name: collection, ...(parentKey === undefined ? {} : { parent: parentKey }) },
      filters,
      orders,
      ...(limit === undefined || limit === 0 ? {} : { limit: limit as number }),
    },
  };
}

/**
 * Runs a /query read. A keys-only read without an order answers keys sorted,
 * with its limit applied after sorting, as the Go server does.
 */
export async function runWireQuery(db: Database, { query, keysOnly }: WireQuery): Promise<readonly Row[]> {
  if (!keysOnly) return runQuery(db, query);
  const sortKeys = query.orders.length === 0;
  const { limit, ...unlimited } = query;
  const rows = (await runQuery(db, sortKeys ? unlimited : query)).map(({ key }) => ({ key }));
  if (!sortKeys) return rows;
  rows.sort((a, b) => a.key < b.key ? -1 : 1);
  return limit === undefined ? rows : rows.slice(0, limit);
}

export async function runQuery(db: Database, query: StructuredQuery<Data>): Promise<Row[]> {
  const page = await db.query(query);
  return page.records.map((record) => ({ key: record.key.path, data: record.data }));
}
