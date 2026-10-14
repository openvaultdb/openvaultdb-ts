import { AlreadyExistsError, NotFoundError, type Database, type Key } from "@dalgo/core";
import { badRequest, invalidKey } from "./http.js";
import { parseKeyPath } from "./keys.js";
import { applyUpdates, isObject, rejectProtoKeys, type WireUpdate } from "./updates.js";

type Data = Record<string, unknown>;

export type OpName = "set" | "insert" | "update" | "delete";

/** One validated write of a batch (docs/api.md, "Batch (transaction commit)"). */
export interface WriteOp {
  readonly op: OpName;
  readonly key: Key;
  readonly data?: Data;
  readonly updates?: readonly WireUpdate[];
}

const opNames: ReadonlySet<string> = new Set<OpName>(["set", "insert", "update", "delete"]);

/** Validates the body of POST /batch as the Go server does (handleBatch). */
export function parseBatch(body: unknown): readonly WriteOp[] {
  if (!isObject(body) || !Array.isArray(body.ops) || body.ops.length === 0) {
    throw badRequest('body must contain a non-empty "ops" array');
  }
  return body.ops.map((raw: unknown, index): WriteOp => {
    if (!isObject(raw)) throw badRequest(`op ${index.toString()}: must be an object`);
    let key: Key;
    try {
      key = parseKeyPath(typeof raw.key === "string" ? raw.key : "");
    } catch (error) {
      throw invalidKey(`op ${index.toString()}: invalid key ${JSON.stringify(raw.key)}: ${(error as Error).message}`);
    }
    if (typeof raw.op !== "string" || !opNames.has(raw.op)) {
      throw badRequest(`op ${index.toString()}: unknown op ${JSON.stringify(raw.op)}`);
    }
    if (raw.data !== undefined && !isObject(raw.data)) throw badRequest(`op ${index.toString()}: data must be an object`);
    if (raw.data !== undefined) rejectProtoKeys(raw.data, `op ${index.toString()}`);
    if (raw.updates !== undefined && !Array.isArray(raw.updates)) throw badRequest(`op ${index.toString()}: updates must be an array`);
    return {
      op: raw.op as OpName,
      key,
      ...(raw.data === undefined ? {} : { data: raw.data }),
      ...(raw.updates === undefined ? {} : { updates: raw.updates as readonly WireUpdate[] }),
    };
  });
}

/**
 * Applies ops in order in one DALgo read-write transaction: an update reads
 * the record through the transaction, so it sees an earlier write of the
 * batch, and any failure rejects the whole batch.
 */
export async function applyOps(db: Database, ops: readonly WriteOp[], now: Date): Promise<number> {
  await db.runReadwriteTransaction(async (tx) => {
    for (const op of ops) {
      switch (op.op) {
        case "set":
          await tx.set(op.key, op.data ?? {});
          break;
        case "insert":
          // The Go server checks an insert conflict before the write too, so an
          // adapter whose insert would overwrite still answers 409.
          if ((await tx.get(op.key)).exists) throw new AlreadyExistsError(op.key);
          await tx.insert(op.key, op.data ?? {});
          break;
        case "update": {
          const current = await tx.get<Data>(op.key);
          if (!current.exists) throw new NotFoundError(op.key);
          await tx.set(op.key, applyUpdates(current.data, op.updates ?? [], now));
          break;
        }
        case "delete":
          try {
            await tx.delete(op.key);
          } catch (error) {
            // DELETE is idempotent on the wire: 204 even if the record is absent.
            if (!(error instanceof NotFoundError)) throw error;
          }
          break;
      }
    }
  });
  return ops.length;
}
