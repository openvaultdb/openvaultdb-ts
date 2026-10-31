import {
  DOCUMENT_ID,
  UnsupportedError,
  snapshotQueryMetadata,
  validateProviderReads,
  type ProviderReadPlan,
  type QueryMetadata,
  type QueryPage,
  type StructuredQuery,
} from "@dalgo/core";
import { OpenVaultDbClient, readOpenVaultDbJson, translateOpenVaultDbError } from "./client.js";
import { keyFromOpenVaultDbPath } from "./path.js";

interface WireFilter {
  readonly field: string;
  readonly op: string;
  readonly value: unknown;
}

interface WireOrder {
  readonly field: string;
  readonly desc: boolean;
}

interface WireQuery {
  readonly collection: string;
  readonly parent?: string;
  readonly where?: readonly WireFilter[];
  readonly orderBy?: readonly WireOrder[];
  readonly limit?: number;
}

interface WireQueryResponse extends QueryMetadata {
  readonly records: readonly {
    readonly key: string;
    readonly data: unknown;
  }[];
}

export interface OpenVaultDbQueryOptions {
  /** Independently admitted execution/definition/rights; never derived from the response. */
  readonly providerReadPlan: ProviderReadPlan;
}

function queryResponse(value: unknown): WireQueryResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid OpenVaultDB query response");
  }
  const body = value as Record<string, unknown>;
  // Check the raw field before legacy snapshotting can drop it or rows are read.
  if (Object.hasOwn(body, "sourceComposition")) {
    throw new UnsupportedError("OpenVaultDB sourceComposition responses");
  }
  if (!Array.isArray(body.records)) throw new TypeError("OpenVaultDB records must be an array");
  for (const record of body.records as unknown[]) {
    if (typeof record !== "object" || record === null || Array.isArray(record)
      || typeof (record as Record<string, unknown>).key !== "string"
      || !Object.hasOwn(record, "data")) {
      throw new TypeError("invalid OpenVaultDB query record");
    }
  }
  return body as unknown as WireQueryResponse;
}

function admittedPlan<T>(
  client: OpenVaultDbClient, query: StructuredQuery<T>, options?: OpenVaultDbQueryOptions,
): ProviderReadPlan | undefined {
  const plan = options === undefined ? undefined : structuredClone(options.providerReadPlan);
  if (options !== undefined && plan === undefined) throw new TypeError("provider read plan is required");
  if (plan === undefined) return undefined;
  if (client.expectedServerId === undefined || client.expectedServerId.trim() === "") {
    throw new TypeError("provider reads require expectedServerId");
  }
  if (plan.execution.mode !== "proxy" || plan.sourceRights.length === 0) {
    throw new TypeError("OpenVaultDB provider reads require a proxy source plan");
  }
  if (plan.execution.executorId !== client.expectedServerId) {
    throw new TypeError("provider read executor does not match expectedServerId");
  }
  if (typeof plan.execution.id !== "string" || !/^[a-f0-9]{32}$/u.test(plan.execution.id)) {
    throw new TypeError("provider read execution ID must be 32 lowercase hex characters");
  }
  for (const right of plan.sourceRights) {
    if (right.source.serverId !== client.expectedServerId
      || right.source.databaseId !== client.databaseId
      || right.source.recordset !== query.source.name) {
      throw new TypeError("provider read plan does not match the queried source");
    }
  }
  return plan;
}

export function toOpenVaultDbQuery<T>(query: StructuredQuery<T>): WireQuery {
  if (query.source.kind === "collection-group") throw new UnsupportedError("OpenVaultDB collection-group queries");
  if ((query.offset ?? 0) !== 0) throw new UnsupportedError("OpenVaultDB query offsets");
  if (query.startAt !== undefined || query.startAfter !== undefined
    || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("OpenVaultDB query cursors");
  }
  const where = query.filters.map((filter): WireFilter => {
    if (filter.field === DOCUMENT_ID) throw new UnsupportedError("OpenVaultDB document-id filters");
    if (filter.operator === "!=" || filter.operator === "not-in") {
      throw new UnsupportedError(`OpenVaultDB ${filter.operator} filters`);
    }
    return { field: filter.field, op: filter.operator, value: filter.value };
  });
  const orderBy = query.orders.map((order): WireOrder => {
    if (order.field === DOCUMENT_ID) throw new UnsupportedError("OpenVaultDB document-id ordering");
    return { field: order.field, desc: order.direction === "desc" };
  });
  return {
    collection: query.source.name,
    ...(query.source.parent === undefined ? {} : { parent: query.source.parent.path }),
    ...(where.length === 0 ? {} : { where }),
    ...(orderBy.length === 0 ? {} : { orderBy }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

export async function executeOpenVaultDbQuery<T>(
  client: OpenVaultDbClient,
  query: StructuredQuery<T>,
  options?: OpenVaultDbQueryOptions,
): Promise<QueryPage<T>> {
  try {
    // Freeze both request and independently admitted metadata before the first await.
    const bodyText = JSON.stringify(toOpenVaultDbQuery(query));
    const plan = admittedPlan(client, query, options);
    const codec = query.source.codec;
    const response = await client.request(client.queryPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(plan === undefined ? {} : { "OVDB-Execution-ID": plan.execution.id }),
      },
      body: bodyText,
    });
    if (plan !== undefined && !response.headers.get("Cache-Control")?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store")) {
      void response.body?.cancel().catch(() => undefined);
      throw new TypeError("provider read response requires Cache-Control no-store");
    }
    const body = queryResponse(await readOpenVaultDbJson(response));
    if (body.providerReads !== undefined && plan === undefined) {
      throw new TypeError("provider reads require an independently admitted plan");
    }
    const metadata = plan === undefined
      ? snapshotQueryMetadata(body)
      : await validateProviderReads(body, plan);
    return {
      ...metadata,
      records: body.records.map((record) => ({
        key: keyFromOpenVaultDbPath(record.key),
        exists: true as const,
        data: codec === undefined ? record.data as T : codec.decode(record.data),
        metadata: { source: "openvaultdb" },
      })),
    };
  } catch (error) {
    throw translateOpenVaultDbError(error);
  }
}
