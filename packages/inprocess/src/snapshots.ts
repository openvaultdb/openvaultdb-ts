import { OvdbHttpError } from "./http.js";
import type { Row } from "./query.js";

/** Bounds of result snapshot paging (docs/api.md, "DTQL", and dtql_pages.go). */
const lifetimeMs = 5 * 60 * 1000;
const maxSnapshots = 2;
export const maxSnapshotRows = 1_000_000;

const tokenPattern = /^([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]*)$/u;

/** What binds a snapshot: its database, document, page size and credential. */
export interface SnapshotScope {
  readonly databaseId: string;
  readonly queryHash: string;
  readonly pageSize: number;
  readonly actor: string;
}

interface Snapshot extends SnapshotScope {
  readonly id: string;
  readonly rows: readonly Row[];
  readonly expiresAt: number;
}

export interface SnapshotPage {
  readonly records: readonly Row[];
  readonly snapshotToken: string;
  readonly nextPageToken?: string;
  readonly snapshotExpiresAt: string;
}

const expired = (message: string): OvdbHttpError => new OvdbHttpError(410, "snapshot_expired", message);
const foreign = (): OvdbHttpError => new OvdbHttpError(403, "forbidden", "query snapshot belongs to another database or credential");

function newId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * Captured DTQL results served page by page. The Go server spools a capture to
 * a private file; an in-process capture is the rows in memory, released on
 * close, on expiry five minutes after capture, or when the fetch is dropped.
 */
export class SnapshotStore {
  readonly #snapshots = new Map<string, Snapshot>();

  /** Reserves a slot before the capture runs, so a full store refuses before reading. */
  public reserve(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.#snapshots) if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    if (this.#snapshots.size >= maxSnapshots) {
      throw new OvdbHttpError(503, "snapshot_capacity", "too many active query snapshots");
    }
  }

  public capture(scope: SnapshotScope, rows: readonly Row[]): SnapshotPage {
    if (rows.length > maxSnapshotRows) {
      throw new OvdbHttpError(413, "snapshot_too_large", "query snapshot exceeds its row or disk size limit");
    }
    const snapshot: Snapshot = { ...scope, id: newId(), rows, expiresAt: Date.now() + lifetimeMs };
    this.#snapshots.set(snapshot.id, snapshot);
    return this.#page(snapshot, 0);
  }

  public page(token: string, scope: SnapshotScope): SnapshotPage {
    const match = tokenPattern.exec(token);
    const snapshot = match === null ? undefined : this.#snapshots.get(match[1] as string);
    if (snapshot === undefined || snapshot.expiresAt <= Date.now()) {
      if (snapshot !== undefined) this.#snapshots.delete(snapshot.id);
      throw expired("query snapshot expired; restart the query");
    }
    if (snapshot.databaseId !== scope.databaseId || snapshot.actor !== scope.actor) throw foreign();
    if (snapshot.queryHash !== scope.queryHash || snapshot.pageSize !== scope.pageSize) {
      throw new OvdbHttpError(400, "bad_request", "query or page size does not match the snapshot");
    }
    const offset = Number((match as RegExpExecArray)[2]);
    if (offset > snapshot.rows.length) throw expired("query page token is invalid; restart the query");
    return this.#page(snapshot, offset);
  }

  /** Releases a snapshot. Closing a released snapshot again is a successful no-op. */
  public close(token: string, scope: SnapshotScope): void {
    const match = tokenPattern.exec(token);
    if (match === null) throw new OvdbHttpError(400, "invalid_page_token", "query page token is invalid");
    const snapshot = this.#snapshots.get(match[1] as string);
    if (snapshot === undefined) return;
    if (snapshot.databaseId !== scope.databaseId || snapshot.actor !== scope.actor
      || snapshot.queryHash !== scope.queryHash || snapshot.pageSize !== scope.pageSize) {
      throw foreign();
    }
    this.#snapshots.delete(snapshot.id);
  }

  #page(snapshot: Snapshot, offset: number): SnapshotPage {
    const end = offset + snapshot.pageSize;
    return {
      records: snapshot.rows.slice(offset, end),
      snapshotToken: `${snapshot.id}.0`,
      ...(end < snapshot.rows.length ? { nextPageToken: `${snapshot.id}.${end.toString()}` } : {}),
      snapshotExpiresAt: new Date(snapshot.expiresAt).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    };
  }
}
