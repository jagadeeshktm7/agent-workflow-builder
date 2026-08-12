#!/usr/bin/env node
// Phase 1: track all core tables + the org_usage view, then create all
// FK-derived relationships via manual_configuration.
//
// NOTE: on nhost cloud, FK-introspection-based relationship creation
// (and run_sql) are rejected by the metadata gateway, so we declare
// relationships explicitly with column_mapping. The DB-level foreign keys
// still exist (created in the migration) for referential integrity.
//
// Usage: node scripts/track-schema.mjs
// Needs env: HASURA_ENDPOINT (https://<sub>.hasura.<region>.nhost.run)
//           HASURA_ADMIN_SECRET
// Idempotent: safe to re-run.

const endpoint = process.env.HASURA_ENDPOINT;
const adminSecret = process.env.HASURA_ADMIN_SECRET;
if (!endpoint || !adminSecret) {
  console.error("Set HASURA_ENDPOINT and HASURA_ADMIN_SECRET");
  process.exit(1);
}

async function metadata(op) {
  const res = await fetch(`${endpoint}/v1/metadata`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": adminSecret,
    },
    body: JSON.stringify(op),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 600)}`);
  return body;
}

const T = (name, schema = "public") => ({ name, schema });

const tables = [
  "organizations",
  "org_members",
  "workflows",
  "workflow_steps",
  "workflow_triggers",
  "workflow_runs",
  "step_runs",
  "org_usage", // view, exposed read-only by Hasura
];

// Object rel: source table -> one parent ("belongs_to")
const objectRels = [
  { table: "org_members", name: "org", remote: "organizations", map: { org_id: "id" } },
  { table: "org_members", name: "user", remote: "users", remoteSchema: "auth", map: { user_id: "id" } },
  { table: "workflows", name: "org", remote: "organizations", map: { org_id: "id" } },
  { table: "workflow_steps", name: "workflow", remote: "workflows", map: { workflow_id: "id" } },
  { table: "workflow_triggers", name: "workflow", remote: "workflows", map: { workflow_id: "id" } },
  { table: "workflow_runs", name: "workflow", remote: "workflows", map: { workflow_id: "id" } },
  { table: "workflow_runs", name: "org", remote: "organizations", map: { org_id: "id" } },
  { table: "step_runs", name: "workflow_run", remote: "workflow_runs", map: { workflow_run_id: "id" } },
  { table: "step_runs", name: "workflow_step", remote: "workflow_steps", map: { workflow_step_id: "id" } },
  { table: "org_usage", name: "org", remote: "organizations", map: { org_id: "id" } },
];

// Array rel: source table -> children ("has_many")
const arrayRels = [
  { table: "organizations", name: "org_members", remote: "org_members", map: { id: "org_id" } },
  { table: "organizations", name: "workflows", remote: "workflows", map: { id: "org_id" } },
  { table: "organizations", name: "workflow_runs", remote: "workflow_runs", map: { id: "org_id" } },
  { table: "workflows", name: "workflow_steps", remote: "workflow_steps", map: { id: "workflow_id" } },
  { table: "workflows", name: "workflow_triggers", remote: "workflow_triggers", map: { id: "workflow_id" } },
  { table: "workflows", name: "workflow_runs", remote: "workflow_runs", map: { id: "workflow_id" } },
  { table: "workflow_runs", name: "step_runs", remote: "step_runs", map: { id: "workflow_run_id" } },
  { table: "workflow_steps", name: "step_runs", remote: "step_runs", map: { id: "workflow_step_id" } },
  { table: "users", name: "org_members", remote: "org_members", schema: "auth", map: { id: "user_id" } },
  { table: "users", name: "workflows", remote: "workflows", schema: "auth", map: { id: "created_by" } },
  { table: "users", name: "workflow_runs", remote: "workflow_runs", schema: "auth", map: { id: "triggered_by" } },
  { table: "users", name: "step_runs", remote: "step_runs", schema: "auth", map: { id: "approved_by" } },
];

async function main() {
  // 1. Read current metadata state
  const exp = await metadata({ type: "export_metadata", args: {} });
  const db = exp.sources.find((s) => s.name === "default");
  const byName = new Map((db?.tables ?? []).map((t) => [t.table.name, t]));

  // 2. Track what's missing (pg_track_table errors on already-tracked)
  const missing = tables.filter((n) => !byName.has(n));
  for (const name of missing) {
    await metadata({ type: "pg_track_table", args: { source: "default", table: T(name) } });
  }
  console.log(missing.length ? `tracked: ${missing.join(", ")}` : "all objects already tracked");
  for (const n of missing) byName.set(n, { table: { name: n, schema: "public" } });

  const createOps = [];
  for (const r of objectRels) {
    const t = byName.get(r.table);
    if (t?.object_relationships?.some((o) => o.name === r.name)) continue;
    createOps.push({
      type: "pg_create_object_relationship",
      args: {
        source: "default",
        table: T(r.table, r.schema ?? "public"),
        name: r.name,
        using: {
          manual_configuration: {
            remote_table: T(r.remote, r.remoteSchema ?? "public"),
            column_mapping: r.map,
          },
        },
      },
    });
  }
  for (const r of arrayRels) {
    const t = byName.get(r.table);
    if (t?.array_relationships?.some((o) => o.name === r.name)) continue;
    createOps.push({
      type: "pg_create_array_relationship",
      args: {
        source: "default",
        table: T(r.table, r.schema ?? "public"),
        name: r.name,
        using: {
          manual_configuration: {
            remote_table: T(r.remote, r.remoteSchema ?? "public"),
            column_mapping: r.map,
          },
        },
      },
    });
  }

  if (createOps.length) {
    for (const op of createOps) await metadata(op);
    console.log(`created relationships: ${createOps.map((o) => o.args.name).join(", ")}`);
  } else {
    console.log("all relationships already present");
  }

  // 3. Verify final state
  const after = await metadata({ type: "export_metadata", args: {} });
  const dbAfter = after.sources.find((s) => s.name === "default");
  for (const t of dbAfter.tables) {
    const inScope =
      t.table.schema === "public" ||
      (t.table.schema === "auth" && t.table.name === "users");
    if (!inScope) continue;
    const obj = (t.object_relationships ?? []).map((o) => o.name);
    const arr = (t.array_relationships ?? []).map((o) => o.name);
    console.log(`${t.table.schema}.${t.table.name}: obj=[${obj.join(",")}] arr=[${arr.join(",")}]`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});