import { afterEach, describe, expect, it, vi } from "vitest";
import { MapDatabase, writable } from "./fake-database.js";
import { createOvdbFetch } from "../src/index.js";
import { base, caller, refusal, type Call } from "./helpers.js";

const path = "/v1/databases/demo/tugql";

function people(count = 5): MapDatabase {
  const records: Record<string, Record<string, unknown>> = {};
  for (let index = 1; index <= count; index += 1) {
    records[`people/p${index.toString()}`] = { name: `P${index.toString()}`, age: index * 10, city: index % 2 === 0 ? "Oslo" : "Rome" };
  }
  return new MapDatabase(undefined, records);
}

const yaml = { "Content-Type": "application/yaml" };

describe("api.md#tugql: POST|GET /v1/databases/{db}/tugql, a document of one plain collection", () => {
  it("→ 200 {records, complete}: filters, ordering, limit, offset and field projection", async () => {
    const db = people();
    const call = caller({ databases: { demo: db } });
    const document = [
      "from: {name: people, database: demo}",
      "where: {and: [{op: '>=', left: {field: age}, right: {value: 20}}, {op: In, left: {field: city}, right: {values: [Oslo, Rome]}}]}",
      "orderBy: [{field: age, desc: true}]",
      "columns: [{field: name}, {field: missing}]",
      "limit: 2",
      "offset: 1",
    ].join("\n");
    const answer = await call("POST", path, document, yaml);
    expect(answer).toMatchObject({ status: 200, body: { records: [{ key: "people/p4", data: { name: "P4" } }, { key: "people/p3", data: { name: "P3" } }], complete: true } });
    expect(answer.headers.get("Cache-Control")).toBe("no-store");
    expect(db.queries.at(-1)).toEqual({
      source: { kind: "collection", name: "people" },
      filters: [{ field: "age", operator: ">=", value: 20 }, { field: "city", operator: "in", value: ["Oslo", "Rome"] }],
      orders: [{ field: "age", direction: "desc" }],
      limit: 2,
      offset: 1,
    });
  });

  it("limit defaults to 1000; null and empty values mean absent", async () => {
    const db = people(2);
    const call = caller({ databases: { demo: db } });
    const document = "from: {name: people, alias: null, joins: []}\nwhere: null\norderBy: []\ncolumns: []\nlimit: 0\noffset: null\n";
    expect((await call("POST", path, document)).body).toMatchObject({ records: [{ key: "people/p1" }, { key: "people/p2" }] });
    expect(db.queries.at(-1)).toEqual({ source: { kind: "collection", name: "people" }, filters: [], orders: [], limit: 1000 });
  });

  it("maps every TugQL operator to DALgo", async () => {
    const db = people();
    const call = caller({ databases: { demo: db } });
    for (const [op, operator, right] of [
      ["==", "==", "{value: 10}"], ["!=", "!=", "{value: 10}"], ["<", "<", "{value: 10}"], ["<=", "<=", "{value: 10}"],
      [">", ">", "{value: 10}"], ["NotIn", "not-in", "{values: []}"],
    ] as const) {
      expect((await call("POST", path, `from: {name: people}\nwhere: {op: '${op}', left: {field: age}, right: ${right}}`)).status).toBe(200);
      expect(db.queries.at(-1)?.filters[0]?.operator).toBe(operator);
    }
  });

  it("binds JSON parameters as values (POST JSON and GET ?q=&parameters=)", async () => {
    const db = people();
    const call = caller({ databases: { demo: db } });
    const query = "from: {name: people}\nwhere: {and: [{op: '>', left: {field: age}, right: {param: Min}}, {op: In, left: {field: city}, right: {param: Cities}}]}";
    const parameters = { Min: 30, Cities: ["Oslo"] };
    const expected = { records: [{ key: "people/p4" }], complete: true };
    expect(await call("POST", path, { query, parameters }, { "Content-Type": "application/json; charset=utf-8" }))
      .toMatchObject({ status: 200, body: expected });
    const url = `${path}?q=${encodeURIComponent(query)}&parameters=${encodeURIComponent(JSON.stringify(parameters))}`;
    expect(await call("GET", url)).toMatchObject({ status: 200, body: expected });
    expect(await call("GET", `${path}?q=${encodeURIComponent("from: {name: people}")}`)).toMatchObject({ status: 200 });
  });

  const invalid: readonly [string, unknown][] = [
    ["a document that is not a mapping", "[1]"],
    ["an unknown root key", "from: {name: people}\nfoo: 1"],
    ["a from that is not an object", "from: people"],
    ["an unknown from key", "from: {name: people, table: x}"],
    ["another database", "from: {name: people, database: other}"],
    ["a schema", "from: {name: people, schema: main}"],
    ["a from without a name", "from: {database: demo}"],
    ["a where that is not an object", "from: {name: people}\nwhere: [1]"],
    ["an empty and group", "from: {name: people}\nwhere: {and: []}"],
    ["an unknown where key", "from: {name: people}\nwhere: {op: '==', left: {field: a}, right: {value: 1}, x: 1}"],
    ["an unknown operator", "from: {name: people}\nwhere: {op: like, left: {field: a}, right: {value: 1}}"],
    ["an inherited property as operator", "from: {name: people}\nwhere: {op: toString, left: {field: a}, right: {value: 1}}"],
    ["a non-string operator", "from: {name: people}\nwhere: {op: 5, left: {field: a}, right: {value: 1}}"],
    ["a left that is not an object", "from: {name: people}\nwhere: {op: '==', left: a, right: {value: 1}}"],
    ["a field with extra keys", "from: {name: people}\nwhere: {op: '==', left: {field: a, desc: true}, right: {value: 1}}"],
    ["an empty field", "from: {name: people}\nwhere: {op: '==', left: {field: ''}, right: {value: 1}}"],
    ["a right that is not an object", "from: {name: people}\nwhere: {op: '==', left: {field: a}, right: 1}"],
    ["a non-scalar value", "from: {name: people}\nwhere: {op: '==', left: {field: a}, right: {value: [1]}}"],
    ["In without a list", "from: {name: people}\nwhere: {op: In, left: {field: a}, right: {values: 1}}"],
    ["In with a non-scalar", "from: {name: people}\nwhere: {op: In, left: {field: a}, right: {values: [{}]}}"],
    ["an orderBy that is not a list", "from: {name: people}\norderBy: {field: a}"],
    ["an order that is not an object", "from: {name: people}\norderBy: [a]"],
    ["a non-boolean desc", "from: {name: people}\norderBy: [{field: a, desc: yes please}]"],
    ["columns that are not a list", "from: {name: people}\ncolumns: {field: a}"],
    ["a limit over 1000", "from: {name: people}\nlimit: 1001"],
    ["a negative limit", "from: {name: people}\nlimit: -1"],
    ["an offset over 10000", "from: {name: people}\noffset: 10001"],
    ["YAML that does not parse", "from: {name: people"],
  ];
  for (const [name, document] of invalid) {
    it(`400 invalid_tugql for ${name}`, async () => {
      const call = caller({ databases: { demo: people() } });
      expect(await call("POST", path, document)).toMatchObject({ status: 400, body: refusal("invalid_tugql") });
    });
  }

  it("400 invalid_key for an unsafe collection name", async () => {
    const call = caller({ databases: { demo: people() } });
    expect(await call("POST", path, "from: {name: '..'}")).toMatchObject({ status: 400, body: refusal("invalid_key") });
  });

  it("422 query_unsupported for an or group, which a DALgo structured query cannot hold", async () => {
    const call = caller({ databases: { demo: people() } });
    const document = "from: {name: people}\nwhere: {or: [{op: '==', left: {field: a}, right: {value: 1}}]}";
    expect(await call("POST", path, document)).toMatchObject({ status: 422, body: refusal("query_unsupported") });
  });

  it("501 query_unsupported for a database whose capabilities say query:false", async () => {
    const call = caller({ databases: { demo: new MapDatabase({ ...writable, query: false }) } });
    expect(await call("POST", path, "from: {name: people}")).toMatchObject({ status: 501, body: refusal("query_unsupported") });
  });
});

describe("api.md#statuses: a relational document → 422 join_engine_unsupported (joins:false)", () => {
  const relational: readonly [string, string][] = [
    ["a join", "from: {name: people, joins: [{type: inner, from: {name: cities}, on: []}]}"],
    ["a source alias", "from: {name: people, alias: p}"],
    ["an as alias", "from: {name: people, as: p}"],
    ["a scan", "from: {name: people, scan: {orderBy: [{field: a}], limit: 1}}"],
    ["a groupBy", "from: {name: people}\ngroupBy: [{field: city}]"],
    ["a having", "from: {name: people}\nhaving: {op: '>', left: {value: 1}, right: {value: 0}}"],
    ["money", "from: {name: people}\nmoney: {minorUnitScale: 2}"],
    ["a null test", "from: {name: people}\nwhere: {isNull: {field: city}}"],
    ["an exists subquery", "from: {name: people}\nwhere: {exists: {from: {name: cities}}}"],
    ["a qualified field", "from: {name: people}\nwhere: {op: '==', left: {field: a, source: p}, right: {value: 1}}"],
    ["a computed operand", "from: {name: people}\nwhere: {op: '==', left: {value: 1}, right: {value: 1}}"],
    ["a field-to-field comparison", "from: {name: people}\nwhere: {op: '==', left: {field: a}, right: {field: b}}"],
    ["a query-valued comparison", "from: {name: people}\nwhere: {op: In, left: {field: a}, right: {query: {from: {name: x}}}}"],
    ["an aggregate column", "from: {name: people}\ncolumns: [{aggregate: {function: count}}]"],
    ["a qualified order", "from: {name: people}\norderBy: [{field: a, source: p}]"],
  ];
  for (const [name, document] of relational) {
    it(`for ${name}`, async () => {
      const call = caller({ databases: { demo: people() } });
      expect(await call("POST", path, document)).toEqual({
        status: 422,
        headers: expect.any(Headers) as unknown,
        body: { error: { code: "join_engine_unsupported", message: 'the "inprocess" storage engine of database "demo" is not enabled for joins and aggregation' } },
      });
    });
  }
});

describe("api.md#tugql: request forms and parameters", () => {
  const post = (call: Call, body: unknown) => call("POST", path, body, { "Content-Type": "application/json" });
  const query = "from: {name: people}\nwhere: {op: '==', left: {field: city}, right: {param: City}}";

  const invalid: readonly [string, unknown][] = [
    ["a body that is not JSON", "{"],
    ["a JSON body with another key", { query, parameters: { City: "Oslo" }, extra: 1 }],
    ["a JSON body that is not an object", [query]],
    ["an empty query", { query: " " }],
    ["parameters that are not an object", { query, parameters: [] }],
    ["more than 64 parameters", { query, parameters: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`P${index.toString()}`, 1])) }],
    ["an unbound parameter", { query }],
    ["an unused parameter", { query, parameters: { City: "Oslo", Extra: 1 } }],
    ["a null parameter", { query, parameters: { City: null } }],
    ["an object parameter", { query, parameters: { City: {} } }],
    ["an array parameter with a null", { query, parameters: { City: ["Oslo", null] } }],
    ["an array parameter over 1000 values", { query, parameters: { City: Array.from({ length: 1001 }, () => "x") } }],
    ["query YAML that does not parse", { query: "from: [", parameters: {} }],
  ];
  for (const [name, body] of invalid) {
    it(`POST JSON: 400 invalid_tugql for ${name}`, async () => {
      const call = caller({ databases: { demo: people() } });
      expect(await post(call, body)).toMatchObject({ status: 400, body: refusal("invalid_tugql") });
    });
  }

  it("binds a parameter to the values of an In list, inside nested groups", async () => {
    const db = people();
    const call = caller({ databases: { demo: db } });
    const nested = "from: {name: people}\nwhere: {and: [{and: [{op: In, left: {field: age}, right: {param: Ages}}]}]}";
    expect(await post(call, { query: nested, parameters: { Ages: [10, 20] } })).toMatchObject({ status: 200, body: { records: [{ key: "people/p1" }, { key: "people/p2" }] } });
  });

  it("POST: a body without a Content-Type is read as TugQL YAML", async () => {
    const fetch = createOvdbFetch({ databases: { demo: people(1) } });
    const response = await fetch(`${base}${path}`, { method: "POST", body: new TextEncoder().encode("from: {name: people}") });
    expect(await response.json()).toMatchObject({ records: [{ key: "people/p1" }] });
  });

  it("POST: 400 bad_request for an empty body, 413 payload_too_large over the body limit", async () => {
    const call = caller({ databases: { demo: people() }, maxBodyBytes: 1024 });
    expect(await call("POST", path, "")).toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("POST", path, `from: {name: people}\n#${"x".repeat(1024)}`)).toMatchObject({ status: 413, body: refusal("payload_too_large") });
  });

  it("GET: 400 bad_request for a missing or repeated q, another parameter, or bad parameters; 414 over 8 KiB", async () => {
    const call = caller({ databases: { demo: people() } });
    const q = encodeURIComponent(query);
    for (const search of [
      "", "?q=", `?q=${q}&q=${q}`, `?q=${q}&limit=1`, `?q=${q}&parameters=`, `?q=${q}&parameters=%7B&parameters=%7B`,
      `?q=${q}&parameters=%5B`, `?q=${q}&parameters=${encodeURIComponent('{"City":null}')}`,
    ]) {
      expect(await call("GET", `${path}${search}`)).toMatchObject({ status: 400, body: refusal("bad_request") });
    }
    expect(await call("GET", `${path}?q=${"x".repeat(8 << 10)}`)).toMatchObject({ status: 414, body: refusal("bad_request") });
  });
});

describe("api.md#tugql: result snapshot paging", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const document = "from: {name: people}\norderBy: [{field: age}]\ncolumns: [{field: age}]";
  const paging = (size: string, extra: Record<string, string> = {}) => ({ "OVDB-Page-Size": size, ...extra });

  it("pages a captured result: snapshotToken, nextPageToken until the last page, then close → 204", async () => {
    const db = people(5);
    const call = caller({ databases: { demo: db } });
    const first = await call("POST", path, document, paging("2"));
    expect(first).toMatchObject({ status: 200, body: { records: [{ key: "people/p1", data: { age: 10 } }, { key: "people/p2" }] } });
    const page = first.body as { snapshotToken: string; nextPageToken: string; snapshotExpiresAt: string };
    expect(page.snapshotExpiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u);
    expect(db.queries.at(-1)?.limit).toBe(1_000_001);
    await call("DELETE", "/v1/databases/demo/records/people/p3");
    const second = await call("POST", path, document, paging("2", { "OVDB-Page-Token": page.nextPageToken }));
    expect(second.body).toMatchObject({ records: [{ key: "people/p3" }, { key: "people/p4" }] });
    const retried = await call("POST", path, document, paging("2", { "OVDB-Page-Token": page.nextPageToken }));
    expect(retried.body).toEqual(second.body);
    const last = await call("POST", path, document, paging("2", { "OVDB-Page-Token": (second.body as { nextPageToken: string }).nextPageToken }));
    expect(last.body).toMatchObject({ records: [{ key: "people/p5" }], snapshotToken: page.snapshotToken });
    expect(last.body).not.toHaveProperty("nextPageToken");
    const close = paging("2", { "OVDB-Page-Token": page.snapshotToken, "OVDB-Page-Close": "true" });
    expect((await call("POST", path, document, close)).status).toBe(204);
    expect((await call("POST", path, document, close)).status).toBe(204);
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": page.nextPageToken })))
      .toMatchObject({ status: 410, body: refusal("snapshot_expired") });
  });

  it("refuses bad paging headers and bounded documents", async () => {
    const call = caller({ databases: { demo: people() } });
    for (const headers of [paging("0"), paging("1001"), paging("x"), { "OVDB-Page-Token": "t" }, paging("2", { "OVDB-Page-Close": "yes" }), paging("2", { "OVDB-Page-Close": "true" })]) {
      expect(await call("POST", path, document, headers)).toMatchObject({ status: 400, body: refusal("bad_request") });
    }
    expect(await call("POST", path, `${document}\nlimit: 3`, paging("2"))).toMatchObject({ status: 400, body: refusal("invalid_tugql") });
    expect(await call("POST", path, `${document}\noffset: 3`, paging("2"))).toMatchObject({ status: 400, body: refusal("invalid_tugql") });
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": "bad", "OVDB-Page-Close": "true" })))
      .toMatchObject({ status: 400, body: refusal("invalid_page_token") });
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": `${"A".repeat(43)}.0`, "OVDB-Page-Close": "true" })))
      .toMatchObject({ status: 204 });
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": "bad" }))).toMatchObject({ status: 410, body: refusal("snapshot_expired") });
  });

  it("binds a snapshot to its database, credential, document and page size", async () => {
    const call = caller({ databases: { demo: people(), other: people() } });
    const first = await call("POST", path, document, paging("2", { Authorization: "Bearer a" }));
    const { nextPageToken, snapshotToken } = first.body as { nextPageToken: string; snapshotToken: string };
    const at = (extra: Record<string, string>, target = path, body = document) => call("POST", target, body, paging("2", { "OVDB-Page-Token": nextPageToken, Authorization: "Bearer a", ...extra }));
    expect(await at({}, "/v1/databases/other/tugql")).toMatchObject({ status: 403, body: refusal("forbidden") });
    expect(await at({ Authorization: "Bearer b" })).toMatchObject({ status: 403, body: refusal("forbidden") });
    expect(await at({}, path, "from: {name: people}")).toMatchObject({ status: 400, body: refusal("bad_request") });
    expect(await call("POST", path, document, paging("3", { "OVDB-Page-Token": nextPageToken, Authorization: "Bearer a" })))
      .toMatchObject({ status: 400, body: refusal("bad_request") });
    const forged = nextPageToken.replace(/\.\d+$/u, ".99");
    expect(await at({ "OVDB-Page-Token": forged })).toMatchObject({ status: 410, body: refusal("snapshot_expired") });
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": snapshotToken, "OVDB-Page-Close": "true" })))
      .toMatchObject({ status: 403, body: refusal("forbidden") });
  });

  it("holds at most two snapshots → 503 snapshot_capacity; a snapshot expires five minutes after capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const call = caller({ databases: { demo: people() } });
    const first = await call("POST", path, document, paging("2"));
    await call("POST", path, document, paging("2"));
    expect(await call("POST", path, document, paging("2"))).toMatchObject({ status: 503, body: refusal("snapshot_capacity") });
    vi.advanceTimersByTime(5 * 60 * 1000);
    const { nextPageToken } = first.body as { nextPageToken: string };
    expect(await call("POST", path, document, paging("2", { "OVDB-Page-Token": nextPageToken }))).toMatchObject({ status: 410, body: refusal("snapshot_expired") });
    expect(await call("POST", path, document, paging("2"))).toMatchObject({ status: 200 });
  });

  it("413 snapshot_too_large for a capture over 1,000,000 rows", async () => {
    const db = people(1);
    db.query = (query) => Promise.resolve({
      records: Array.from({ length: (query.limit ?? 0) }, (_, index) => ({ key: { path: `people/${index.toString()}` }, exists: true as const, data: {} })) as never,
    });
    const call = caller({ databases: { demo: db } });
    expect(await call("POST", path, document, paging("2"))).toMatchObject({ status: 413, body: refusal("snapshot_too_large") });
  });
});
