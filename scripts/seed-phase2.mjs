#!/usr/bin/env node
// Phase 2: seed 2 organizations, each with 3 users (owner / editor / viewer)
// and org membership, plus one workflow per org so the isolation test has
// real rows to target.
//
// Users are created through the nhost auth signup API (proper password
// hashing + JWT roles), NOT raw SQL into auth.users. Memberships go into
// public.org_members via the admin GraphQL API.
//
// Prereq: roles owner / editor / viewer must be enabled in the project:
//   nhost dashboard -> Settings -> Roles and Permissions -> Allowed roles
// (signup returns "role-not-allowed" otherwise - the auth server validates
//  roles against this list at token mint time).
//
// Usage: node scripts/seed-phase2.mjs
// Needs env: AUTH_URL      (https://<sub>.auth.<region>.nhost.run)
//           HASURA_ENDPOINT, HASURA_ADMIN_SECRET
// Idempotent: re-running upserts memberships and keeps existing orgs/users.

const AUTH_URL = process.env.AUTH_URL;
const endpoint = process.env.HASURA_ENDPOINT;
const adminSecret = process.env.HASURA_ADMIN_SECRET;
if (!AUTH_URL || !endpoint || !adminSecret) {
  console.error("Set AUTH_URL, HASURA_ENDPOINT and HASURA_ADMIN_SECRET");
  process.exit(1);
}

const PASSWORD = "Phase2!Pass123";

const ORGS = [
  {
    name: "Org A",
    users: [
      { email: "a.owner@example.com", role: "owner" },
      { email: "a.editor@example.com", role: "editor" },
      { email: "a.viewer@example.com", role: "viewer" },
    ],
  },
  {
    name: "Org B",
    users: [
      { email: "b.owner@example.com", role: "owner" },
      { email: "b.editor@example.com", role: "editor" },
      { email: "b.viewer@example.com", role: "viewer" },
    ],
  },
];

async function authPost(path, body) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${AUTH_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        console.log(`  rate limited, backing off (${attempt})...`);
        await new Promise((r) => setTimeout(r, 15000 * attempt));
        continue;
      }
      const json = await res.json().catch(() => null);
      if (json !== null) return { status: res.status, json };
    } catch {}
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw new Error(`${path}: no valid JSON after retries`);
}

async function gql(query, variables) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${endpoint}/v1/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hasura-admin-secret": adminSecret,
        },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.errors) throw new Error(JSON.stringify(json).slice(0, 500));
      return json;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// Prefer signin (existing user) over signup; signup only when absent.
async function getOrCreateUser(email, role) {
  const displayName = `${email.split("@")[0].split(".")[0].toUpperCase()} ${role}`;
  const si = await authPost("/v1/signin/email-password", { email, password: PASSWORD });
  if (si.status === 200) {
    return { id: si.json.session.user.id, role, created: false };
  }
  const res = await authPost("/v1/signup/email-password", {
    email,
    password: PASSWORD,
    options: { allowedRoles: [role], defaultRole: role, displayName },
  });
  if (res.status === 200 || res.status === 201) {
    return { id: res.json.session.user.id, role, created: true };
  }
  throw new Error(`signup ${email}: ${JSON.stringify(res.json)}`);
}

async function main() {
  // 1. Users
  const usersByOrg = {};
  for (const org of ORGS) {
    const users = [];
    for (const u of org.users) {
      const res = await getOrCreateUser(u.email, u.role);
      users.push({ ...u, ...res });
      console.log(`user ${u.email} (${u.role}): ${res.created ? "created" : "exists"} -> ${res.id}`);
    }
    usersByOrg[org.name] = users;
  }

  // 2. Organizations
  const orgIds = {};
  for (const org of ORGS) {
    const existing = await gql(
      `query($name: String!) { organizations(where: { name: { _eq: $name } }) { id } }`,
      { name: org.name }
    );
    if (existing.data.organizations.length) {
      orgIds[org.name] = existing.data.organizations[0].id;
    } else {
      const created = await gql(
        `mutation($name: String!) { insert_organizations_one(object: { name: $name }) { id } }`,
        { name: org.name }
      );
      orgIds[org.name] = created.data.insert_organizations_one.id;
    }
    console.log(`org ${org.name}: ${orgIds[org.name]}`);
  }

  // 3. Memberships (upsert role on re-run)
  for (const org of ORGS) {
    for (const u of usersByOrg[org.name]) {
      await gql(
        `mutation($o: uuid!, $u: uuid!, $r: String!) {
          insert_org_members_one(
            object: { org_id: $o, user_id: $u, role: $r }
            on_conflict: { constraint: org_members_org_id_user_id_key, update_columns: [role] }
          ) { id }
        }`,
        { o: orgIds[org.name], u: u.id, r: u.role }
      );
    }
    console.log(`memberships ok for ${org.name}`);
  }

  // 4. One workflow per org (created_by = that org's owner)
  for (const org of ORGS) {
    const owner = usersByOrg[org.name].find((u) => u.role === "owner");
    const existing = await gql(
      `query($org: uuid!, $name: String!) { workflows(where: { org_id: { _eq: $org }, name: { _eq: $name } }) { id } }`,
      { org: orgIds[org.name], name: `${org.name} workflow` }
    );
    if (existing.data.workflows.length) {
      console.log(`workflow for ${org.name} exists: ${existing.data.workflows[0].id}`);
      continue;
    }
    const wf = await gql(
      `mutation($org: uuid!, $by: uuid!, $name: String!) {
        insert_workflows_one(object: { org_id: $org, name: $name, created_by: $by }) { id }
      }`,
      { org: orgIds[org.name], by: owner.id, name: `${org.name} workflow` }
    );
    console.log(`workflow for ${org.name}: ${wf.data.insert_workflows_one.id}`);
  }

  console.log("\nSeed complete.");
  console.log(`Credentials (password for all): ${PASSWORD}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});