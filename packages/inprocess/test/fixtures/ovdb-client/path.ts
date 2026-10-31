import { Key } from "@dalgo/core";

const escapedIdCharacters: Readonly<Record<string, string>> = {
  "%2E": ".",
  "%24": "$",
  "%23": "#",
  "%5B": "[",
  "%5D": "]",
  "%2F": "/",
};

function unescapeId(value: string): string {
  return value.replaceAll(/%[0-9A-Fa-f]{2}/g, (escape) => (
    escapedIdCharacters[escape.toUpperCase()] ?? escape
  ));
}

export function keyFromOpenVaultDbPath(path: string): Key<string> {
  const segments = path.split("/");
  if (segments.length === 0 || segments.length % 2 !== 0 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`invalid OpenVaultDB record path: ${path}`);
  }
  let current: Key<string> | undefined;
  for (let index = 0; index < segments.length; index += 2) {
    const collection = segments[index];
    const id = segments[index + 1];
    if (collection === undefined || id === undefined) throw new TypeError(`invalid OpenVaultDB record path: ${path}`);
    current = new Key(collection, unescapeId(id), current);
  }
  if (current === undefined) throw new TypeError(`invalid OpenVaultDB record path: ${path}`);
  return current;
}
