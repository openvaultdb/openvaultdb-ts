import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { createOvdbFetch } from "../src/index.js";
import { MapDatabase, readOnlyCapabilities } from "./fake-database.js";
import { OpenVaultDbDatabase, OpenVaultDbHttpError } from "./ovdb-client.js";

interface User {
  readonly name: string;
  readonly age: number;
  readonly profile?: { readonly city?: string };
}

const users = collection<User>("users");

function connect(db: MapDatabase, databaseId = "demo"): OpenVaultDbDatabase {
  return new OpenVaultDbDatabase({
    baseUrl: "https://local.ovdb.invalid",
    databaseId,
    fetch: createOvdbFetch({ databases: { [databaseId]: db } }),
  });
}

describe("@openvaultdb/client against createOvdbFetch", () => {
  it("api.md#records: GET reads a record and a 404 is a missing snapshot", async () => {
    const client = connect(new MapDatabase(undefined, { "users/ann": { name: "Ann", age: 30 } }));
    const ann = await client.get<User>(users.key("ann"));
    expect(ann.exists && ann.data).toEqual({ name: "Ann", age: 30 });
    expect((await client.get(users.key("bob"))).exists).toBe(false);
  });

  it("api.md#batch-transaction-commit: insert, set, update and delete commit as one batch", async () => {
    const db = new MapDatabase(undefined, { "users/ann": { name: "Ann", age: 30 }, "users/old": { name: "Old", age: 99 } });
    const client = connect(db);
    await client.runReadwriteTransaction(async (tx) => {
      await tx.insert<User>(users.key("bob"), { name: "Bob", age: 20 });
      await tx.set<User>(users.key("cid"), { name: "Cid", age: 40 });
      await tx.update(users.key("ann"), { age: 31, "profile.city": "Oslo" });
      await tx.delete(users.key("old"));
    });
    expect(Object.fromEntries([...db.store].map(([path, { data }]) => [path, data]))).toEqual({
      "users/ann": { name: "Ann", age: 31, profile: { city: "Oslo" } },
      "users/bob": { name: "Bob", age: 20 },
      "users/cid": { name: "Cid", age: 40 },
    });
  });

  it("api.md#batch-transaction-commit: an update reads its record through the server first", async () => {
    const client = connect(new MapDatabase());
    await expect(client.runReadwriteTransaction(async (tx) => { await tx.update(users.key("ghost"), { age: 1 }); }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("api.md#conventions: 409 already_exists rejects the whole batch as AlreadyExistsError", async () => {
    const db = new MapDatabase(undefined, { "users/ann": { name: "Ann", age: 30 } });
    const client = connect(db);
    const commit = client.runReadwriteTransaction(async (tx) => {
      await tx.set<User>(users.key("bob"), { name: "Bob", age: 20 });
      await tx.insert<User>(users.key("ann"), { name: "Again", age: 1 });
    });
    await expect(commit).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(db.store.has("users/bob")).toBe(false);
  });

  it("api.md#conventions: 409 constraint_violation is answered for a refused unique index", async () => {
    const db = new MapDatabase();
    db.beforeWrite = () => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.name"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    };
    const commit = connect(db).runReadwriteTransaction(async (tx) => {
      await tx.set<User>(users.key("bob"), { name: "Bob", age: 20 });
    });
    await expect(commit).rejects.toMatchObject({ status: 409, code: "constraint_violation" });
  });

  it("api.md#query: 422 not_supported from the adapter surfaces as UnsupportedError", async () => {
    const db = new MapDatabase();
    db.query = () => Promise.reject(new UnsupportedError("collection-group queries"));
    await expect(connect(db).query(users.query().build())).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("api.md#query: a structured query returns full key paths", async () => {
    const db = new MapDatabase(undefined, {
      "users/ann": { name: "Ann", age: 30 }, "users/bob": { name: "Bob", age: 20 }, "users/cid": { name: "Cid", age: 40 },
    });
    db.store.set("spaces/s1/users/dan", { key: key("spaces", "s1").child("users", "dan"), data: { name: "Dan", age: 50 } });
    const client = connect(db);
    const page = await client.query(users.query().where("age", ">", 25).orderBy("age", "desc").limit(10).build());
    expect(page.records.map((record) => record.key.path)).toEqual(["users/cid", "users/ann"]);
    const nested = await client.query(users.in(key("spaces", "s1")).query().build());
    expect(nested.records.map((record) => record.key.path)).toEqual(["spaces/s1/users/dan"]);
  });

  it("api.md#query: 403 read_only on every write of a database whose capabilities say write:false", async () => {
    const db = new MapDatabase(readOnlyCapabilities, { "users/ann": { name: "Ann", age: 30 } });
    const client = connect(db);
    const commit = client.runReadwriteTransaction(async (tx) => { await tx.delete(users.key("ann")); });
    await expect(commit).rejects.toBeInstanceOf(OpenVaultDbHttpError);
    await expect(commit).rejects.toMatchObject({ status: 403, code: "read_only" });
    expect((await client.get(users.key("ann"))).exists).toBe(true);
  });

  it("api.md#server--databases: an unknown database is 404 not_found", async () => {
    const client = new OpenVaultDbDatabase({
      baseUrl: "https://local.ovdb.invalid",
      databaseId: "missing",
      fetch: createOvdbFetch({ databases: {} }),
    });
    await expect(client.query(users.query().build())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
