import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDatabaseSchema } from "../src/lib/databaseReadiness.ts";

const provider = { table_schema: "public", table_name: "cloud_connections", column_name: "provider" };

test("existing provider column passes without replaying DDL", async () => {
  const queries: string[] = [];
  await verifyDatabaseSchema(async (sql) => {
    queries.push(sql);
    return { rows: [provider] };
  }, [provider]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /^SELECT /);
  assert.doesNotMatch(queries[0]!, /ALTER|CREATE|INSERT|UPDATE|DELETE/i);
});

test("missing required column fails closed", async () => {
  await assert.rejects(
    verifyDatabaseSchema(async () => ({ rows: [] }), [provider]),
    /missing required columns: public.cloud_connections.provider/,
  );
});

test("additional columns do not block readiness", async () => {
  await verifyDatabaseSchema(async () => ({
    rows: [provider, { ...provider, column_name: "extra" }],
  }), [provider]);
});

test("database errors propagate for startup retry", async () => {
  await assert.rejects(
    verifyDatabaseSchema(async () => { throw new Error("connection timeout"); }, [provider]),
    /connection timeout/,
  );
});

test("empty schema cannot accidentally pass readiness", async () => {
  await assert.rejects(
    verifyDatabaseSchema(async () => ({ rows: [] }), []),
    /No database schema columns configured/,
  );
});
