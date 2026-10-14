import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseYamlDocument, scanNesting } from "../src/dtql.js";
import { createOvdbFetch, defaultMaxDtqlBytes } from "../src/index.js";
import { MapDatabase } from "./fake-database.js";
import { base, caller, refusal } from "./helpers.js";

const path = "/v1/databases/d/dtql";
const seeded = (): MapDatabase => new MapDatabase(undefined, { "users/a": { name: "Ann", n: 1 }, "users/b": { name: "Bob", n: 2 } });
const jsonType = { "Content-Type": "application/json" };

// Time budgets are generous: the refusals take a few ms and a 256 KiB valid
// document well under a second locally; the bounds leave a large CI margin.
async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number; heapMb: number }> {
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started, heapMb: (process.memoryUsage().heapUsed - heap) / (1 << 20) };
}

const nesting = (text: string): string | undefined => {
  try {
    scanNesting(text);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("DTQL document size cap (maxDtqlBytes), before any parsing", () => {
  it("defaults to 256 KiB and refuses an 8 MiB flow-nesting body with 413 at once, reading little", async () => {
    expect(defaultMaxDtqlBytes).toBe(256 << 10);
    const fetch = createOvdbFetch({ databases: { d: seeded() } });
    const flow = "[".repeat((8 << 20) - 1);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 << 10).fill(91));
        if (pulled === 128) controller.close();
      },
    });
    for (const body of [flow, stream]) {
      const { result, ms, heapMb } = await timed(() => fetch(`${base}${path}`, { method: "POST", body, duplex: "half" } as RequestInit));
      expect(result.status).toBe(413);
      const error = ((await result.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("payload_too_large");
      expect(error.message).toBe(`DTQL document (maxDtqlBytes) exceeds ${defaultMaxDtqlBytes.toString()} bytes`);
      expect(ms).toBeLessThan(500);
      expect(heapMb).toBeLessThan(64);
    }
    expect(pulled).toBeLessThan(20); // the stream was cancelled, not drained
  });

  it("accepts a body of exactly the cap and refuses one byte more, as YAML and as JSON", async () => {
    const cap = 1024;
    const call = caller({ databases: { d: seeded() }, maxDtqlBytes: cap });
    const head = "from: {name: users}\n#";
    const pad = (bytes: number): string => `${head}${"x".repeat(bytes - head.length)}`;
    expect((await call("POST", path, pad(cap))).status).toBe(200);
    expect(await call("POST", path, pad(cap + 1))).toMatchObject({ status: 413, body: refusal("payload_too_large") });
    const json = (query: string): string => JSON.stringify({ query });
    const fit = json(pad(cap - 13)); // the JSON envelope and the escaped newline cost bytes
    const size = new TextEncoder().encode(fit).length;
    expect(size).toBeLessThanOrEqual(cap);
    expect((await call("POST", path, fit, jsonType)).status).toBe(200);
    expect((await call("POST", path, json(pad(cap + 1)), jsonType)).status).toBe(413);
  });

  it("is bounded by maxBodyBytes when that is smaller, and leaves record bodies on maxBodyBytes", async () => {
    const small = caller({ databases: { d: seeded() }, maxBodyBytes: 100, maxDtqlBytes: 5000 });
    expect((await small("POST", path, `from: {name: users}\n#${"x".repeat(100)}`)).status).toBe(413);
    const wide = caller({ databases: { d: seeded() }, maxDtqlBytes: 100 });
    expect((await wide("PUT", "/v1/databases/d/records/users/c", { data: { pad: "x".repeat(5000) } })).status).toBe(204);
    expect((await wide("POST", path, `from: {name: users}\n#${"x".repeat(100)}`)).status).toBe(413);
  });
});

describe("nesting scan before parsing", () => {
  it("refuses a 255 KB deep flow body with 400 quickly, as YAML and as JSON", async () => {
    const call = caller({ databases: { d: seeded() } });
    const bodies = ["[".repeat(255_000), "{a: ".repeat(60_000), `${"[".repeat(125_000)}${"]".repeat(125_000)}`];
    for (const body of bodies) {
      for (const answer of [
        await timed(() => call("POST", path, body)),
        await timed(() => call("POST", path, { query: body }, jsonType)),
      ]) {
        if (answer.result.status === 413) continue; // the JSON envelope pushed it over the cap: refused even earlier
        expect(answer.result).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
        expect((answer.result.body as { error: { message: string } }).error.message).toContain("nesting too deep");
        expect(answer.ms).toBeLessThan(500);
      }
    }
  });

  it("refuses deep block nesting by indentation and by compact sequence markers", () => {
    const indented = Array.from({ length: 300 }, (_, level) => `${" ".repeat(level)}k${level.toString()}:`).join("\n");
    expect(nesting(indented)).toContain("nesting too deep");
    expect(nesting(`${"- ".repeat(300)}x`)).toContain("nesting too deep");
    expect(nesting(`-\n${"- ".repeat(300)}x`)).toContain("nesting too deep");
    const flowInBlock = `${Array.from({ length: 100 }, (_, level) => `${" ".repeat(level)}k:`).join("\n")}\n${" ".repeat(100)}v: ${"[".repeat(200)}`;
    expect(nesting(flowInBlock)).toContain("nesting too deep");
  });

  it("boundary: 256 levels pass the scan, 257 do not", () => {
    expect(nesting("[".repeat(256))).toBeUndefined();
    expect(nesting("[".repeat(257))).toContain("nesting too deep");
    expect(nesting("{a: ".repeat(256))).toBeUndefined();
    expect(nesting("{a: ".repeat(257))).toContain("nesting too deep");
    const block = (levels: number): string => Array.from({ length: levels }, (_, level) => `${" ".repeat(level)}k:`).join("\n");
    expect(nesting(block(256))).toBeUndefined();
    expect(nesting(block(257))).toContain("nesting too deep");
  });

  it("never refuses a realistic query: quoted brackets, comments, multi-line flow lists, block scalars", async () => {
    const documents = [
      "from: {name: users}\nwhere: {op: ==, left: {field: name}, right: {value: \"[[[[[[[\"}}\n",
      `from: {name: users}\nwhere: {op: ==, left: {field: name}, right: {value: '${"{".repeat(400)}'}}\n`,
      `from: {name: users}\nwhere: {op: ==, left: {field: name}, right: {value: "${"[".repeat(400)} \\" ${"[".repeat(400)}"}}\n`,
      `from: {name: users}\nwhere: {op: ==, left: {field: name}, right: {value: 'it''s ${"[".repeat(400)}'}}\n`,
      `# ${"[".repeat(500)}\nfrom: {name: users} # ${"{".repeat(500)}\n`,
      `from: {name: users}\nwhere:\n  op: ==\n  left: {field: name}\n  right: {value: don't} # ${"[".repeat(500)}\n`,
      "from: {name: users}\nwhere: {and: [\n  {op: '>=', left: {field: n}, right: {value: 1}},\n  # a comment [[[\n  {op: In, left: {field: name}, right: {values: [\n    Ann,\n    Bob\n  ]}}\n ]}\norderBy:\n  - field: name\n    desc: true\ncolumns:\n  - {field: name}\n",
      `from: {name: users}\nwhere:\n  op: ==\n  left: {field: name}\n  right:\n    value: |\n      ${"[".repeat(400)}\n        ${"{".repeat(400)}\n    \n      more\n`,
      "from: {name: users}\r\nwhere:\r\n  op: ==\r\n  left: {field: name}\r\n  right:\r\n    value: x[1] y{2}\r\n",
      "---\nfrom: {name: users}\n",
      "from:\n  name: users\nwhere:\n  and:\n    - op: ==\n      left:\n        field: name\n      right:\n        value: Ann\n",
    ];
    const call = caller({ databases: { d: seeded() } });
    for (const document of documents) {
      expect(nesting(document)).toBeUndefined();
      const answer = await call("POST", path, document);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    }
  });

  it("a bracket in a block scalar or a multi-line quote does not leak into later lines", () => {
    const text = `a: >-\n  ${"[".repeat(400)}\nb: "multi\n  ${"[".repeat(400)}\n  line"\nc: 'x\n  ${"{".repeat(400)}'\nd: 1\n`;
    expect(nesting(text)).toBeUndefined();
    expect(nesting(`a: |2+ # note\n  ${"[".repeat(400)}\nb: 1\n`)).toBeUndefined();
    expect(nesting("[".repeat(300))).toContain("nesting too deep");
    expect(nesting(`a: |\n  x\n${"[".repeat(300)}`)).toContain("nesting too deep");
    expect(nesting("]]]}}} a: ]")).toBeUndefined();
    // brackets inside a plain scalar neither open nor close a flow collection
    expect(nesting(`a: x${"[".repeat(400)}\nb: y${"{".repeat(400)}z\n`)).toBeUndefined();
    expect(nesting(`a: x${"]".repeat(300)}\nb: ${"[".repeat(300)}`)).toContain("nesting too deep");
  });

  it("the exact post-parse depth check still backs the scan up", async () => {
    // the scan tolerates one level more than the parsed document (a root flow line holds an indent level)
    const call = caller({ databases: { d: seeded() } });
    const deep = (levels: number): string => `a: ${"[".repeat(levels)}${"]".repeat(levels)}`;
    expect(nesting(deep(256))).toBeUndefined();
    const answer = await call("POST", path, deep(256));
    expect(answer).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    expect((answer.body as { error: { message: string } }).error.message).toContain("nesting too deep");
  });
});

describe("YAML parser options", () => {
  const call = caller({ databases: { d: seeded() } });

  it("does not process merge keys: << stays an ordinary, unsupported key", async () => {
    const answer = await call("POST", path, "from: {<<: &b {name: users}}\n");
    expect(answer).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
  });

  it("refuses custom and js tags instead of resolving them", async () => {
    for (const document of [
      "from: {name: !!js/function 'function () { throw 1 }'}",
      "from: {name: !custom users}",
      "from: !!js/regexp {name: users}",
      "!!python/object:os.system {from: {name: users}}",
    ]) {
      expect(await call("POST", path, document)).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    }
  });

  it("refuses duplicate keys, and alias bombs fast", async () => {
    expect(await call("POST", path, "from: {name: users}\nfrom: {name: users}")).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    let bomb = "a: &a [x, x, x, x, x, x, x, x, x, x]\n";
    for (const [name, previous] of [["b", "a"], ["c", "b"], ["d", "c"], ["e", "d"], ["f", "e"], ["g", "f"], ["h", "g"]] as const) {
      bomb += `${name}: &${name} [${Array.from({ length: 10 }, () => `*${previous}`).join(", ")}]\n`;
    }
    const many = `from: {name: users}\nwhere: {and: [&w {op: ==, left: {field: name}, right: {value: Ann}}, ${Array.from({ length: 150 }, () => "*w").join(", ")}]}`;
    expect(await call("POST", path, many)).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    const { result, ms } = await timed(() => call("POST", path, bomb));
    expect(result).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
    expect(ms).toBeLessThan(500);
  });
});

describe("a large but valid document at the cap", () => {
  it("parses a 256 KiB valid query within a generous time bound", async () => {
    const call = caller({ databases: { d: seeded() } });
    const head = "from: {name: users}\nwhere: {op: In, left: {field: name}, right: {values: [";
    const tail = "]}}\n";
    const values: string[] = [];
    let size = head.length + tail.length;
    for (let index = 0; size + 8 < defaultMaxDtqlBytes; index += 1) {
      const value = `v${index.toString()}, `;
      values.push(value);
      size += value.length;
    }
    const document = `${head}${values.join("")}Ann${tail}`;
    expect(new TextEncoder().encode(document).length).toBeLessThanOrEqual(defaultMaxDtqlBytes);
    const { result, ms } = await timed(() => call("POST", path, document));
    // the values list exceeds the 1000-value parameter bound only for parameters; a document list is plain
    expect([200, 400, 422]).toContain(result.status);
    expect(ms).toBeLessThan(2000);
  });
});

/** Fills a document up to the DTQL cap with repeated items. */
function filled(head: string, item: (index: number) => string, tail: string): string {
  const out: string[] = [];
  let size = head.length + tail.length;
  for (let index = 0; ; index += 1) {
    const text = item(index);
    if (size + text.length > defaultMaxDtqlBytes) break;
    out.push(text);
    size += text.length;
  }
  return head + out.join("") + tail;
}

describe("worst-case documents at the cap stay linear (the library's own duplicate-key check is quadratic)", () => {
  const shapes: Record<string, { text: string; refused: boolean }> = {
    "flow set {a,a,...}": { text: filled("{", () => "a,", "}"), refused: true },
    "block map k0: 1 ...": { text: filled("", (i) => `k${i.toString()}: 1\n`, ""), refused: false },
    "flow map k0: 1, ...": { text: filled("{", (i) => `k${i.toString()}: 1,`, "}"), refused: false },
    "flow {0:1,1:1,...}": { text: filled("{", (i) => `${i.toString()}:1,`, "}"), refused: false },
    "anchors k0: &a0 1 ...": { text: filled("", (i) => `k${i.toString()}: &a${i.toString()} 1\n`, ""), refused: false },
    "same key with anchors": { text: filled("", (i) => `k: &a${i.toString()} 1\n`, ""), refused: true },
  };
  for (const [name, { text, refused }] of Object.entries(shapes)) {
    it(`${name}: ${refused ? "refused as a duplicate" : "parsed, then refused as a DTQL document"} in under 3 s`, async () => {
      expect(text.length).toBeGreaterThan(defaultMaxDtqlBytes - 64);
      const call = caller({ databases: { d: seeded() } });
      const { result, ms } = await timed(() => call("POST", path, text));
      expect(result).toMatchObject({ status: 400, body: refusal("invalid_dtql") });
      if (refused) expect((result.body as { error: { message: string } }).error.message).toContain("duplicate key");
      // before the fix these took 9-39 s; now 0.1-0.8 s locally
      expect(ms).toBeLessThan(3000);
    });
  }
});

describe("duplicate keys are refused as the library's uniqueKeys refuses them", () => {
  const refuses = (text: string): string | undefined => {
    try {
      parseYamlDocument(text);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("flow, block, nested, quoted and unquoted equal keys, numbers, null keys", () => {
    for (const text of [
      "a: 1\na: 2", "{a: 1, a: 2}", "x: {a: 1, a: 2}", "x: [{a: 1, a: 2}]", "a: 1\n\"a\": 2", "'a': 1\na: 2", "1: x\n1: y", "1: x\n1.0: y",
      "~: 1\nnull: 2", "? ~\n: 1\n? null\n: 2", "true: 1\ntrue: 2", "{a, a}", "x:\n  y:\n    a: 1\n    a: 2",
    ]) expect(refuses(text), text).toContain("duplicate key");
    for (const text of ["1: x\n\"1\": y", "a: 1\nb: 1", "x: {a: 1}\ny: {a: 1}", ".nan: 1\n.nan: 2", "true: 1\n\"true\": 2", "{a: 1}", ""]) {
      expect(refuses(text), text).toBeUndefined();
    }
  });

  it("agrees with the library's own uniqueKeys check on random small documents", () => {
    let state = 20_261_014;
    const random = (limit: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % limit);
    };
    const keys = ["a", '"a"', "'a'", "b", "1", '"1"', "1.0", "~", "null", '"null"', "true", '"true"', ".nan", "0", "-0", "0x1", "1e0"];
    const value = (depth: number): string => (depth > 2 || random(3) === 0 ? String(random(9)) : collection(depth + 1));
    const collection = (depth: number): string => {
      const count = 1 + random(4);
      const pairs = Array.from({ length: count }, () => `${keys[random(keys.length)] as string}: ${value(depth)}`);
      return random(2) === 0 ? `{${pairs.join(", ")}}` : `[${pairs.map((pair) => `{${pair}}`).join(", ")}, {${pairs.join(", ")}}]`;
    };
    let duplicates = 0;
    let clean = 0;
    for (let round = 0; round < 600; round += 1) {
      const block = random(3) === 0;
      const text = block
        ? Array.from({ length: 1 + random(5) }, () => `${keys[random(keys.length)] as string}: ${value(2)}`).join("\n")
        : collection(0);
      const loose = parseDocument(text, { schema: "core", uniqueKeys: false });
      if (loose.errors.length > 0) continue;
      const library = parseDocument(text, { schema: "core", uniqueKeys: true }).errors.some((error) => error.message.includes("Map keys must be unique"));
      const ours = refuses(text);
      expect(ours?.includes("duplicate key") ?? false, text).toBe(library);
      if (library) duplicates += 1;
      else clean += 1;
    }
    expect(duplicates).toBeGreaterThan(40);
    expect(clean).toBeGreaterThan(40);
  }, 30_000);
});

describe("a bracket inside a plain scalar never opens a flow collection", () => {
  it("many scalars with an unclosed bracket stay 400-free", async () => {
    const call = caller({ databases: { d: seeded() } });
    const inline = Array.from({ length: 300 }, (_, index) => `k${index.toString()}: a [b`).join("\n");
    expect(nesting(inline)).toBeUndefined();
    const sequence = `values:\n${Array.from({ length: 300 }, (_, index) => `  - note ${index.toString()} see [1`).join("\n")}`;
    expect(nesting(sequence)).toBeUndefined();
    for (const text of [`${inline}\n`, sequence]) expect(parseDocument(text).errors).toHaveLength(0);
    expect(nesting(Array.from({ length: 300 }, () => "k: x{y").join("\n"))).toBeUndefined();
    // the real query: an unclosed bracket in a value, behind many other lines
    const query = `from: {name: users}\nwhere: {op: ==, left: {field: name}, right: {value: "Ann [x"}}\n${Array.from({ length: 300 }, (_, index) => `# see [${index.toString()}`).join("\n")}\n`;
    expect((await call("POST", path, query)).status).toBe(200);
  });

  it("opens only where a node can start: line start, after `: `, `- `, `? `, `,`, tags and anchors", () => {
    const deep = "[".repeat(300);
    for (const prefix of ["", "k: ", "- ", "? ", "k: !!seq ", "k: &x ", "k: !t &x ", "- - "]) expect(nesting(prefix + deep), prefix).toContain("nesting too deep");
    expect(nesting(`{a: ${"[".repeat(300)}`)).toContain("nesting too deep");
    expect(nesting(`[a, ${"[".repeat(300)}`)).toContain("nesting too deep");
    expect(nesting(`{"a":${"[".repeat(300)}`)).toContain("nesting too deep");
    // an apostrophe inside a plain scalar opens no quote, so the deep line after it is still seen
    expect(nesting(`k: it's x\n${deep}`)).toContain("nesting too deep");
    // a quote opens after a flow comma
    expect(nesting(`[a, '${deep}']`)).toBeUndefined();
    expect(nesting(`k: x${deep}`)).toBeUndefined();
    expect(nesting(`k: x ${deep}`)).toBeUndefined();
    expect(nesting(`k: x:y ${deep}`)).toBeUndefined();
    expect(nesting(`k: ?x ${deep}`)).toBeUndefined();
  });

  it("agrees with the parser on seeded random documents with brackets in plain, quoted and commented text", () => {
    let state = 7;
    const random = (limit: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (state >>> 8) % limit;
    };
    const scalars = ["a [b", "see [1", "x{y", "plain # [[[", '"[[[ \\" {{"', "'{{ it''s [['", "1", "[1, [2], {a: 3}]", "{a: [1, 2]}", "it's [", "a]b}c", "k [ 'q' ]", "!!str [x", "&anc [y"];
    for (let round = 0; round < 200; round += 1) {
      const lines: string[] = [];
      for (let line = 0; line < 280 + random(60); line += 1) {
        const scalar = scalars[random(scalars.length)] as string;
        lines.push(random(2) === 0 ? `k${line.toString()}: ${scalar}` : random(2) === 0 ? `# [[ ${scalar}` : `k${line.toString()}:\n  - ${scalar}`);
      }
      const text = lines.join("\n");
      if (parseDocument(text, { schema: "core" }).errors.length > 0) continue;
      expect(nesting(text), text.slice(0, 200)).toBeUndefined();
    }
  }, 30_000);
});

describe("the scanner's depth equals the parsed depth at the limit", () => {
  it("accepts 256 nested sequences, refuses 257", () => {
    expect(nesting(`${"- ".repeat(256)}x`)).toBeUndefined();
    expect(nesting(`${"- ".repeat(257)}x`)).toContain("nesting too deep");
    expect(() => parseYamlDocument(`${"- ".repeat(256)}x`)).not.toThrow();
    expect(() => parseYamlDocument(`${"- ".repeat(257)}x`)).toThrow(/nesting too deep/u);
  });
});

describe("size options are validated", () => {
  it("rejects NaN, negative, zero, fractional and infinite limits with a TypeError", () => {
    for (const name of ["maxBodyBytes", "maxDtqlBytes"] as const) {
      for (const bad of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => createOvdbFetch({ databases: {}, [name]: bad }), `${name}=${String(bad)}`).toThrow(TypeError);
      }
      expect(() => createOvdbFetch({ databases: {}, [name]: 1 })).not.toThrow();
    }
    expect(() => createOvdbFetch({ databases: {}, maxDtqlBytes: Number.NaN })).toThrow(/maxDtqlBytes must be a positive safe integer/u);
  });
});

describe("an over-limit body is cancelled, not drained", () => {
  it("cancels the stream once the DTQL cap is passed", async () => {
    const fetch = createOvdbFetch({ databases: { d: seeded() }, maxDtqlBytes: 100 });
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 50; index += 1) controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const response = await fetch(`${base}${path}`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(1);
  });
});
