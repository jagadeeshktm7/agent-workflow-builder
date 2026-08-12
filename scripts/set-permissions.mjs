#!/usr/bin/env node
// Phase 2: Hasura row-level permissions for roles owner / editor / viewer.
//
// No session variable claims are used. Instead, every rule enforces REAL
// membership through the org_members table:
//   - owner  : full CRUD on every table, but only for rows whose org the
//              calling user is a member of (including org_members itself)
//   - editor : select/insert/update on workflows, steps, triggers, runs;
//              select-only on org_members; select on organizations
//   - viewer : select-only everywhere
//
// The org the client wants to operate in is passed as a normal GraphQL
// variable (org switcher) - Hasura verifies membership on every request via
// the org_members _exists check, so a spoofed org id is never trusted.
//
// Tables without a direct org_id column reach it through relationships:
//   workflow_steps/workflow_triggers -> workflow -> org
//   step_runs -> workflow_run -> org
//
// Usage: node scripts/set-permissions.mjs
// Needs env: HASURA_ENDPOINT, HASURA_ADMIN_SECRET. Idempotent.

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

const T = (name) => ({ name, schema: "public" });

// org_members membership path per table (relationship traversal from a row
// to "is the current user a member of this row's org").
const M = {
  organizations: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } },
  org_members: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } },
  workflows: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } },
  workflow_runs: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } },
  workflow_steps: { workflow: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } } },
  workflow_triggers: { workflow: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } } },
  step_runs: { workflow_run: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } } },
  org_usage: { org: { org_members: { user_id: { _eq: "X-Hasura-User-Id" } } } },
};

const ALL = ["select", "insert", "update", "delete"];
const RWD = ["select", "insert", "update"];

const PERMS = {
  owner: {
    organizations: ALL,
    org_members: ALL,
    workflows: ALL,
    workflow_steps: ALL,
    workflow_triggers: ALL,
    workflow_runs: ALL,
    step_runs: ALL,
    org_usage: ["select"],
  },
  editor: {
    organizations: ["select"],
    org_members: ["select"],
    workflows: RWD,
    workflow_steps: RWD,
    workflow_triggers: RWD,
    workflow_runs: RWD,
    step_runs: RWD,
    org_usage: ["select"],
  },
  viewer: {
    organizations: ["select"],
    org_members: ["select"],
    workflows: ["select"],
    workflow_steps: ["select"],
    workflow_triggers: ["select"],
    workflow_runs: ["select"],
    step_runs: ["select"],
    org_usage: ["select"],
  },
};

function buildPermission(op, filter) {
  switch (op) {
    case "select":
      return { columns: "*", filter, allow_aggregations: false };
    case "insert":
      return { columns: "*", check: filter };
    case "update":
      return { columns: "*", filter, check: filter, allow_aggregations: false };
    case "delete":
      return { filter };
  }
}

async function main() {
  const exp = await metadata({ type: "export_metadata", args: {} });
  const db = exp.sources.find((s) => s.name === "default");
  const byName = new Map((db?.tables ?? []).map((t) => [t.table.name, t]));

  let created = 0;
  let skipped = 0;
  for (const [role, tables] of Object.entries(PERMS)) {
    for (const [table, ops] of Object.entries(tables)) {
      const tracked = byName.get(table);
      if (!tracked) throw new Error(`table ${table} is not tracked`);
      const existing = tracked.permissions ?? {};
      for (const op of ops) {
        const list = existing[`${op}_permissions`] ?? [];
        const have = list.find((p) => p.role === role);
        const want = buildPermission(op, M[table]);
        if (have && JSON.stringify(have.permission) === JSON.stringify(want)) {
          skipped++;
          continue;
        }
        if (have) {
          await metadata({
            type: `pg_drop_${op}_permission`,
            args: { source: "default", table: T(table), role },
          });
        }
        await metadata({
          type: `pg_create_${op}_permission`,
          args: {
            source: "default",
            table: T(table),
            role,
            permission: want,
          },
        });
        created++;
        console.log(`${role}.${table}:${op} created`);
      }
    }
  }
  console.log(`done - created ${created}, unchanged ${skipped}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});