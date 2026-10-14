import { Key } from "@dalgo/core";
import { invalidKey } from "./http.js";

const separators = /[/\\]/u;
// eslint-disable-next-line no-control-regex -- the rule is about control characters
const controlCharacter = /[\u0000-\u001f\u007f]/u;

/** The segment rule of the Go server (core.ValidateSegment). */
export function validateSegment(segment: string): void {
  if (segment === "") throw invalidKey("invalid key: empty segment");
  if (controlCharacter.test(segment)) throw invalidKey(`invalid key: segment ${JSON.stringify(segment)} contains a control character`);
  const parts = segment.split(separators).filter((part) => part !== "");
  if (parts.length === 0) throw invalidKey(`invalid key: segment ${JSON.stringify(segment)} is only path separators`);
  if (parts.some((part) => part === "." || part === "..")) {
    throw invalidKey(`invalid key: segment ${JSON.stringify(segment)} contains a relative path component`);
  }
}

/**
 * Parses a dal-escaped key path ("collection/id[/sub/id...]") as the Go server
 * does: split on "/", percent-unescape each segment, then validate it.
 */
export function parseKeyPath(raw: string): Key<string> {
  const segments = raw.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw invalidKey(`invalid key: invalid key segment ${JSON.stringify(part)}`);
    }
  });
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw invalidKey(`invalid key: key must have an even number of segments (collection/id pairs), got ${segments.length.toString()}`);
  }
  segments.forEach(validateSegment);
  let key: Key<string> | undefined;
  for (let index = 0; index < segments.length; index += 2) {
    key = newKey(segments[index] as string, segments[index + 1] as string, key);
  }
  return key as Key<string>;
}

/** Builds a DALgo key, answering what DALgo refuses (a "/" in a collection) as invalid_key. */
export function newKey(collection: string, id: string, parent?: Key): Key<string> {
  try {
    return new Key(collection, id, parent);
  } catch (error) {
    throw invalidKey(`invalid key: ${(error as Error).message}`);
  }
}
