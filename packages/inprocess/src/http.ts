import { AlreadyExistsError, NotFoundError, UnsupportedError } from "@dalgo/core";

/** A refusal answered with the OVDB error envelope `{"error":{"code","message"}}`. */
export class OvdbHttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.headers = headers;
    this.name = "OvdbHttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string): OvdbHttpError => new OvdbHttpError(400, "bad_request", message);
export const invalidKey = (message: string): OvdbHttpError => new OvdbHttpError(400, "invalid_key", message);
export const invalidTugql = (message: string): OvdbHttpError => new OvdbHttpError(400, "invalid_tugql", message);
export const notFound = (message: string): OvdbHttpError => new OvdbHttpError(404, "not_found", message);
export const payloadTooLarge = (limit: number, what = "request body"): OvdbHttpError =>
  new OvdbHttpError(413, "payload_too_large", `${what} exceeds ${limit.toString()} bytes`);
/** No Go equivalent exists: ovdb serve has no per-database read denial, so this server names it read_denied. */
export const readDenied = (): OvdbHttpError => new OvdbHttpError(403, "read_denied", "reads are not allowed on this database");
export const readOnly = (): OvdbHttpError => new OvdbHttpError(403, "read_only", "server is read-only");

const noStore = { "Cache-Control": "no-store" } as const;

export function jsonResponse(value: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...noStore, ...headers },
  });
}

export function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: noStore });
}

export function errorResponse(error: OvdbHttpError): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, error.headers);
}

function hasCode(error: object, pattern: RegExp): boolean {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && pattern.test(code);
}

/**
 * A storage constraint the adapter refused (a unique index, a foreign key, a
 * check). DALgo has no error class for it, so it is recognised by the shapes
 * adapters raise: a `ConstraintViolationError`, a `constraint_violation` or
 * `SQLITE_CONSTRAINT*` code, or SQLite's "constraint failed" text.
 */
export function isConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ConstraintViolationError"
    || hasCode(error, /^(constraint_violation|SQLITE_CONSTRAINT\w*)$/u)
    || /\bconstraint failed\b/iu.test(error.message);
}

/** Maps a DALgo or adapter error to the status and code the Go server answers. */
export function mapError(error: unknown): OvdbHttpError {
  if (error instanceof OvdbHttpError) return error;
  if (error instanceof NotFoundError) return notFound(error.message);
  if (error instanceof AlreadyExistsError) return new OvdbHttpError(409, "already_exists", error.message);
  if (isConstraintViolation(error)) return new OvdbHttpError(409, "constraint_violation", (error as Error).message);
  if (error instanceof UnsupportedError) return new OvdbHttpError(422, "not_supported", error.message);
  return new OvdbHttpError(500, "internal", "internal server error");
}
