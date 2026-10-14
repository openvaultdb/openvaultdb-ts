import type { QueryFilter, QueryOperator, QueryOrder, StructuredQuery } from "@dalgo/core";
import { parse as parseYaml } from "yaml";
import { invalidDtql, OvdbHttpError } from "./http.js";
import { validateSegment } from "./keys.js";
import { isObject } from "./updates.js";

type Data = Record<string, unknown>;

/** Bounds of the single-collection DTQL profile (docs/api.md, "DTQL"). */
export const maxLimit = 1000;
export const maxOffset = 10_000;
const maxParameters = 64;
const maxParameterValues = 1000;

/** A document of one plain collection, ready to run through DALgo. */
export interface CollectionDocument {
  readonly query: StructuredQuery<Data>;
  /** The fields of a `columns` projection; undefined reads every field. */
  readonly columns?: readonly string[];
  /** Whether the document set a limit or an offset (paging requires neither). */
  readonly bounded: boolean;
}

/** What the Go server answers a relational document on an engine outside its join engines. */
export function joinEngineUnsupported(databaseId: string): OvdbHttpError {
  return new OvdbHttpError(422, "join_engine_unsupported",
    `the "inprocess" storage engine of database ${JSON.stringify(databaseId)} is not enabled for joins and aggregation`);
}

class Relational extends Error {}

const relational = (): never => {
  throw new Relational();
};

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function bindValue(name: string, value: unknown): Data {
  if (value === null) throw invalidDtql(`parameter ${JSON.stringify(name)} cannot be null`);
  if (Array.isArray(value)) {
    if (value.length > maxParameterValues) throw invalidDtql(`parameter ${JSON.stringify(name)} has too many values`);
    if (!value.every(isScalar)) throw invalidDtql(`parameter ${JSON.stringify(name)} must contain only non-null scalars`);
    return { values: value };
  }
  if (!isScalar(value)) throw invalidDtql(`parameter ${JSON.stringify(name)} must be a scalar or array`);
  return { value };
}

/** Replaces each `{param: Name}` node with its bound value, as bindDTQLParameters does. */
function bind(node: unknown, parameters: Data, used: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => bind(item, parameters, used));
  if (!isObject(node)) return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === "param") {
    const name = String(node.param);
    if (!Object.hasOwn(parameters, name)) throw invalidDtql(`parameter ${JSON.stringify(name)} is not bound`);
    used.add(name);
    return bindValue(name, parameters[name]);
  }
  return Object.fromEntries(keys.map((key) => [key, bind(node[key], parameters, used)]));
}

export function parseYamlDocument(text: string): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    throw invalidDtql(`invalid DTQL YAML: ${(error as Error).message}`);
  }
}

/**
 * Reads the DTQL document of a JSON request (`{"query": "<YAML>", "parameters": {...}}`)
 * and binds its parameters as values, never as text.
 */
export function bindJsonDocument(payload: unknown): unknown {
  if (!isObject(payload) || Object.keys(payload).some((key) => key !== "query" && key !== "parameters")) {
    throw invalidDtql("invalid DTQL JSON: the body holds only query and parameters");
  }
  const { query, parameters = {} } = payload;
  if (typeof query !== "string" || query.trim() === "") throw invalidDtql("query must contain DTQL YAML");
  if (!isObject(parameters)) throw invalidDtql("invalid DTQL JSON: parameters must be an object");
  if (Object.keys(parameters).length > maxParameters) throw invalidDtql("too many DTQL parameters");
  const used = new Set<string>();
  const document = bind(parseYamlDocument(query), parameters, used);
  for (const name of Object.keys(parameters)) {
    if (!used.has(name)) throw invalidDtql(`parameter ${JSON.stringify(name)} is not used`);
  }
  return document;
}

const rootKeys = new Set(["from", "where", "orderBy", "limit", "offset", "columns", "groupBy", "having", "money"]);
const fromKeys = new Set(["database", "schema", "name", "alias", "as", "scan", "joins"]);
const operators: Readonly<Record<string, QueryOperator>> = {
  "==": "==", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=", In: "in", NotIn: "not-in",
};

function given(value: unknown): unknown {
  return value === null || (Array.isArray(value) && value.length === 0) ? undefined : value;
}

function plainField(value: unknown, context: string): string {
  if (!isObject(value)) throw invalidDtql(`${context} must be an object`);
  if (Object.hasOwn(value, "source") || Object.hasOwn(value, "query")) relational();
  if (!Object.hasOwn(value, "field")) relational();
  if (Object.keys(value).length !== 1) throw invalidDtql(`unsupported ${context} key`);
  if (typeof value.field !== "string" || value.field === "") throw invalidDtql(`${context}.field must be a non-empty string`);
  return value.field;
}

function comparison(value: Data): QueryFilter<Data> {
  if (Object.keys(value).some((key) => key !== "op" && key !== "left" && key !== "right")) {
    throw invalidDtql("unsupported where key");
  }
  const op = typeof value.op === "string" && Object.hasOwn(operators, value.op) ? operators[value.op] : undefined;
  if (op === undefined) throw invalidDtql(`unsupported where operator ${String(value.op)}`);
  const field = plainField(value.left, "where.left");
  const right = value.right;
  if (!isObject(right)) throw invalidDtql("where.right must be an object");
  if (!Object.hasOwn(right, "value") && !Object.hasOwn(right, "values")) relational();
  const list = op === "in" || op === "not-in";
  const operand = list ? right.values : right.value;
  if (list ? !Array.isArray(operand) || !operand.every(isScalar) : !isScalar(operand)) {
    throw invalidDtql(list ? "where values must be an array of portable scalars" : "where.right.value must be a portable scalar");
  }
  return { field, operator: op, value: operand };
}

function conditions(value: unknown): QueryFilter<Data>[] {
  if (!isObject(value)) throw invalidDtql("where must be an object");
  if (Object.hasOwn(value, "isNull") || Object.hasOwn(value, "isNotNull") || Object.hasOwn(value, "exists")) relational();
  if (Object.hasOwn(value, "or")) {
    throw new OvdbHttpError(422, "query_unsupported", "the storage engine cannot run this query");
  }
  if (Object.hasOwn(value, "and")) {
    if (!Array.isArray(value.and) || value.and.length === 0) throw invalidDtql("where.and must be a non-empty array");
    return value.and.flatMap(conditions);
  }
  return [comparison(value)];
}

function orders(value: unknown): QueryOrder<Data>[] {
  if (!Array.isArray(value)) throw invalidDtql("orderBy must be an array");
  return value.map((raw: unknown) => {
    if (!isObject(raw)) throw invalidDtql("orderBy entries must be objects");
    const { desc, ...rest } = raw;
    if (desc !== undefined && desc !== null && typeof desc !== "boolean") throw invalidDtql("orderBy.desc must be boolean");
    return { field: plainField(rest, "orderBy"), direction: desc === true ? "desc" : "asc" };
  });
}

function bound(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidDtql(`${name} must be a non-negative safe integer`);
  if ((value as number) > max) throw invalidDtql(`${name} must not exceed ${max.toString()}`);
  return value as number;
}

/**
 * Classifies a DTQL document for a per-database endpoint. A document of one
 * plain collection becomes a DALgo structured query; any relational feature
 * (alias, join, grouping, aggregate, computed or qualified column, null test,
 * subquery) is refused as the Go server refuses it on an engine it does not
 * join on.
 */
export function classifyDocument(document: unknown, databaseId: string): CollectionDocument {
  try {
    return collectionDocument(document, databaseId);
  } catch (error) {
    if (error instanceof Relational) throw joinEngineUnsupported(databaseId);
    throw error;
  }
}

function collectionDocument(document: unknown, databaseId: string): CollectionDocument {
  if (!isObject(document)) throw invalidDtql("invalid or unsupported DTQL query: a document must be a mapping");
  for (const key of Object.keys(document)) if (!rootKeys.has(key)) throw invalidDtql(`unsupported DTQL action key ${key}`);
  const from = document.from;
  if (!isObject(from)) throw invalidDtql("from must be an object");
  for (const key of Object.keys(from)) if (!fromKeys.has(key)) throw invalidDtql(`unsupported from key ${key}`);
  if (given(from.joins) !== undefined || given(from.alias) !== undefined || given(from.as) !== undefined
    || given(from.scan) !== undefined || given(document.groupBy) !== undefined
    || given(document.having) !== undefined || given(document.money) !== undefined) {
    relational();
  }
  if (from.database !== undefined && from.database !== null && from.database !== databaseId) {
    throw invalidDtql(`collection ${JSON.stringify(from.name)} names database ${JSON.stringify(from.database)}; this endpoint reads database ${JSON.stringify(databaseId)}`);
  }
  if (from.schema !== undefined && from.schema !== null) throw invalidDtql("a schema-qualified source is not supported by this engine");
  if (typeof from.name !== "string") throw invalidDtql("from.name must be a string");
  validateSegment(from.name);
  const where = given(document.where);
  const orderBy = given(document.orderBy);
  const rawColumns = given(document.columns);
  if (rawColumns !== undefined && !Array.isArray(rawColumns)) throw invalidDtql("columns must be an array");
  const columns = rawColumns?.map((column: unknown) => plainField(column, "columns"));
  const limit = given(document.limit) === undefined ? 0 : bound(document.limit, "limit", maxLimit);
  const offset = given(document.offset) === undefined ? 0 : bound(document.offset, "offset", maxOffset);
  return {
    query: {
      source: { kind: "collection", name: from.name },
      filters: where === undefined ? [] : conditions(where),
      orders: orderBy === undefined ? [] : orders(orderBy),
      limit: limit === 0 ? maxLimit : limit,
      ...(offset === 0 ? {} : { offset }),
    },
    ...(columns === undefined ? {} : { columns }),
    bounded: limit !== 0 || offset !== 0,
  };
}

/** Keeps the projected fields of a record. */
export function project(data: Data | undefined, columns: readonly string[] | undefined): Data | undefined {
  if (columns === undefined || data === undefined) return data;
  return Object.fromEntries(columns.filter((column) => Object.hasOwn(data, column)).map((column) => [column, data[column]]));
}
