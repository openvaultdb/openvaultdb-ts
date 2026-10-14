import { expect } from "vitest";
import { createOvdbFetch, type CreateOvdbFetchOptions } from "../src/index.js";

export const base = "https://local.ovdb.invalid";

export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer>;

/** Sends one request to an in-process server and reads the answer: JSON, text, or undefined when empty. */
export function caller(options: CreateOvdbFetchOptions): Call {
  const fetch = createOvdbFetch(options);
  return async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };
}

/** The OVDB error envelope with the given code and any message. */
export function refusal(code: string): unknown {
  return { error: { code, message: expect.any(String) as unknown } };
}
