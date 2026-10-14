import type { QueryFilter, QueryOperator, QueryOrder, StructuredQuery } from "@dalgo/core";
import { isMap, isScalar as isYamlScalar, isSeq, parseDocument } from "yaml";
import { invalidDtql, OvdbHttpError } from "./http.js";
import { validateCollection } from "./keys.js";
import { isObject, maxNesting, nestsTooDeep } from "./updates.js";

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

const space = 32;
const isBlank = (code: number): boolean => code === space || code === 9 || code === 13;
const isFlowIndicator = (code: number): boolean => code === 44 || code === 91 || code === 93 || code === 123 || code === 125;

/**
 * Refuses, in one linear pass and before the YAML library sees the text, a DTQL
 * document that nests deeper than maxNesting: flow collections (`[` and `{`)
 * count one level each, block collections one level per distinct indentation
 * (or `- ` marker) on a line. A flow collection opens only where a node can
 * start (line start, after `: `, `- `, `? `, a flow `,`, `[`, `{`, or a tag or
 * anchor prefix), so a bracket inside a plain scalar never counts; quoted
 * scalars, comments and block scalar bodies are skipped too. It never counts
 * more levels than the parsed document has, bar a plain scalar continued on
 * ever deeper lines, so it refuses nothing a sane query holds; the post-parse
 * check stays as the exact one. The library alone would parse the whole
 * document first, which a deep flow body turns into seconds and gigabytes.
 */
export function scanNesting(text: string): void {
  const tooDeep = (): never => {
    throw invalidDtql("invalid DTQL YAML: nesting too deep");
  };
  const indents: number[] = [];
  const end = text.length;
  let flow = 0;
  let quote = 0;
  let canStart = true; // whether the next non-blank character starts a node
  let skipBelow = -1; // a block scalar body is skipped while its lines are indented past this column
  for (let lineStart = 0; lineStart <= end;) {
    let eol = text.indexOf("\n", lineStart);
    if (eol === -1) eol = end;
    let at = lineStart;
    if (quote === 0 && flow === 0) {
      canStart = true;
      while (at < eol && text.charCodeAt(at) === space) at++;
      const column = at - lineStart;
      const blank = at === eol || text.charCodeAt(at) === 13;
      if (skipBelow >= 0 && (blank || column > skipBelow)) {
        lineStart = eol + 1;
        continue;
      }
      skipBelow = -1;
      if (!blank && text.charCodeAt(at) !== 35) {
        while (indents.length > 0 && (indents[indents.length - 1] as number) > column) indents.pop();
        if (indents.length === 0 || (indents[indents.length - 1] as number) < column) indents.push(column);
        // the first marker is the collection of this indent; each further one opens a collection of its own
        const dash = (position: number): boolean => text.charCodeAt(position) === 45 && (position + 1 === eol || isBlank(text.charCodeAt(position + 1)));
        while (dash(at)) {
          at++;
          while (at < eol && isBlank(text.charCodeAt(at))) at++;
          if (dash(at)) indents.push(at - lineStart);
        }
        if (indents.length > maxNesting) tooDeep();
      }
    }
    let contentEnd = eol;
    for (let i = at; i < eol; i++) {
      const code = text.charCodeAt(i);
      const next = i + 1 < eol ? text.charCodeAt(i + 1) : 10;
      if (quote === 39) {
        if (code === 39) {
          if (next === 39) i++;
          else quote = 0;
        }
      } else if (quote === 34) {
        if (code === 92) i++;
        else if (code === 34) quote = 0;
      } else if (code === 35 && (i === lineStart || isBlank(text.charCodeAt(i - 1)))) {
        contentEnd = i;
        break;
      } else if (isBlank(code)) {
        continue;
      } else if (canStart && (code === 33 || code === 38)) {
        // a tag or anchor prefix: the node it decorates still starts after it
        while (i + 1 < eol && !isBlank(text.charCodeAt(i + 1)) && (flow === 0 || !isFlowIndicator(text.charCodeAt(i + 1)))) i++;
      } else if ((code === 39 || code === 34) && canStart) {
        quote = code;
        canStart = false;
      } else if ((code === 91 || code === 123) && (canStart || flow > 0)) {
        flow++;
        canStart = true;
        if (flow + indents.length > maxNesting + 1) tooDeep(); // a root flow line holds one indent level without being a block
      } else if ((code === 93 || code === 125) && flow > 0) {
        flow--;
      } else if ((code === 44 && flow > 0) || (code === 58 && (flow > 0 || isBlank(next) || next === 10)) || (code === 63 && canStart && isBlank(next))) {
        canStart = true;
      } else {
        canStart = false;
      }
    }
    if (quote === 0 && flow === 0) {
      let last = contentEnd;
      while (last > at && isBlank(text.charCodeAt(last - 1))) last--;
      while (last > at && /[+\-0-9]/u.test(text[last - 1] as string)) last--;
      const marker = last > at ? text.charCodeAt(last - 1) : 0;
      if ((marker === 124 || marker === 62) && (last - 1 === at || isBlank(text.charCodeAt(last - 2)))) {
        skipBelow = indents[indents.length - 1] as number; // a line with content has pushed its indent
      }
    }
    lineStart = eol + 1;
  }
}

/**
 * Refuses the first map holding two keys that are equal scalars (the same rule
 * as the library's `uniqueKeys`, whose check compares every pair of keys and
 * so takes quadratic time), in linear time with one Set per map. `1` and `"1"`
 * differ; `.nan` equals nothing, as in the library. Walks with an explicit stack.
 */
function rejectDuplicateKeys(root: unknown): void {
  const stack: unknown[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (isMap(node)) {
      const seen = new Set<unknown>();
      for (const pair of node.items) {
        const key = pair.key;
        if (isYamlScalar(key) && !Number.isNaN(key.value)) {
          if (seen.has(key.value)) throw new Error("duplicate key");
          seen.add(key.value);
        }
        stack.push(key, pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
}

/**
 * Parses a DTQL YAML document with the core schema only: no merge keys, at most
 * 100 aliases, no duplicate keys; any warning is refused, so an unresolved or
 * mismatched tag such as `!!js/function` or `!!float 1` never reaches a loader.
 * (customTags: [] equals the core schema's default and only states the intent.)
 */
export function parseYamlDocument(text: string): unknown {
  scanNesting(text);
  let document: unknown;
  try {
    // uniqueKeys is off because the library's check is quadratic; rejectDuplicateKeys replaces it
    const parsed = parseDocument(text, { schema: "core", customTags: [], merge: false, uniqueKeys: false });
    const problem = parsed.errors[0] ?? parsed.warnings[0];
    if (problem !== undefined) throw problem;
    rejectDuplicateKeys(parsed.contents);
    document = parsed.toJS({ maxAliasCount: 100 }) as unknown;
  } catch (error) {
    throw invalidDtql(`invalid DTQL YAML: ${(error as Error).message}`);
  }
  if (nestsTooDeep(document)) throw invalidDtql("invalid DTQL YAML: nesting too deep");
  return document;
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
  if (value.field === "__proto__") throw invalidDtql(`${context}.field "__proto__" is not allowed`);
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
  validateCollection(from.name);
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
