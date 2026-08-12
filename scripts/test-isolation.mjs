#!/usr/bin/env node
// Phase 2: cross-org isolation test.
//
// Logs in as Org A's EDITOR and Org A's VIEWER, then attempts to read and
// mutate Org B's workflow by id through the public GraphQL API with a real
// JWT (x-hasura-role header selects the editor/viewer role).
//
// Expected behavior (printed as raw request + response per step):
//   - select by Org B id        -> null / empty (filtered, NOT an error)
//   - update Org B workflow     -> affected_rows 0
//   - insert workflow in Org B  -> error (insert check fails)
//   - viewer tries update       -> error (no update permission for viewer)
//   - positive controls on Org A -> data returned (proves filtering, not breakage)
//
// Usage: node scripts/test-isolation.mjs
// Needs env: AUTH_URL, HASURA_ENDPOINT

const AUTH_URL = process.env.AUTH_URL;
const endpoint = process.env.HASURA_ENDPOINT;
if (!AUTH_URL || !endpoint) {
  console.error("Set AUTH_URL and HASURA_ENDPOINT");
  process.exit(1);
}

const b64url = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

async function post(url, body, headers = {}) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        console.log(`  rate limited, backing off (${attempt})...`);
        await new Promise((r) => setTimeout(r, 15000 * attempt));
        continue;
      }
      const parsed = await res.json().catch(() => null);
      if (parsed !== null) return { status: res.status, body: parsed };
    } catch {}
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw new Error("no valid JSON after retries");
}

async function signIn(email, password) {
  const { status, body } = await post(`${AUTH_URL}/v1/signin/email-password`, { email, password });
  if (status !== 200) throw new Error(`signin ${email} failed: ${JSON.stringify(body)}`);
  return body.session.accessToken;
}

function show(label, reqBody, headers, resp) {
  console.log(`\n### ${label}`);
  console.log(`--- request ---`);
  console.log(JSON.stringify({ headers, body: reqBody }, null, 2));
  console.log(`--- response (HTTP ${resp.status}) ---`);
  console.log(JSON.stringify(resp.body, null, 2));
}

async function main() {
  const editorToken = await signIn("a.editor@example.com", "Phase2!Pass123");
  const viewerToken = await signIn("a.viewer@example.com", "Phase2!Pass123");
  const editor = b64url(editorToken.split(".")[1]);
  console.log("=== Org A editor JWT claims ===");
  console.log(JSON.stringify(editor["https://hasura.io/jwt/claims"], null, 2));

  // Org ids + workflow ids (fetched with the admin secret, to target rows directly)
  const adminHeaders = { "x-hasura-admin-secret": process.env.HASURA_ADMIN_SECRET };
  const meta = await post(
    `${endpoint}/v1/graphql`,
    {
      query: `query {
        organizations(order_by: { name: asc }) {
          id name
          workflows { id name }
        }
      }`,
    },
    adminHeaders
  );
  const [orgA, orgB] = meta.body.data.organizations;
  const wfA = orgA.workflows[0];
  const wfB = orgB.workflows[0];
  console.log(`\nSeed rows -> Org A: ${orgA.id} (workflow ${wfA.id}) | Org B: ${orgB.id} (workflow ${wfB.id})\n`);

  const editorHeaders = { Authorization: `Bearer ${editorToken}`, "x-hasura-role": "editor" };
  const viewerHeaders = { Authorization: `Bearer ${viewerToken}`, "x-hasura-role": "viewer" };

  // 1. SELECT Org B workflow by id
  show(
    "1. editor: SELECT Org B workflow by id (must be null)",
    {
      query: `query($id: uuid!) { workflows_by_pk(id: $id) { id name org { name } } }`,
      variables: { id: wfB.id },
    },
    editorHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `query($id: uuid!) { workflows_by_pk(id: $id) { id name org { name } } }`,
      variables: { id: wfB.id },
    }, editorHeaders)
  );

  // 2. SELECT all workflows while scoping to Org B
  show(
    "2. editor: SELECT workflows where org_id = Org B (must be empty array)",
    {
      query: `query($org: uuid!) { workflows(where: { org_id: { _eq: $org } }) { id name } }`,
      variables: { org: orgB.id },
    },
    editorHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `query($org: uuid!) { workflows(where: { org_id: { _eq: $org } }) { id name } }`,
      variables: { org: orgB.id },
    }, editorHeaders)
  );

  // 3. Positive control: SELECT all workflows while scoping to Org A
  show(
    "3. editor: SELECT workflows where org_id = Org A (must return data)",
    {
      query: `query($org: uuid!) { workflows(where: { org_id: { _eq: $org } }) { id name } }`,
      variables: { org: orgA.id },
    },
    editorHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `query($org: uuid!) { workflows(where: { org_id: { _eq: $org } }) { id name } }`,
      variables: { org: orgA.id },
    }, editorHeaders)
  );

  // 4. UPDATE Org B workflow by id
  show(
    "4. editor: UPDATE Org B workflow by id (must affect 0 rows)",
    {
      query: `mutation($id: uuid!, $name: String!) { update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) { id name } }`,
      variables: { id: wfB.id, name: "hacked" },
    },
    editorHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `mutation($id: uuid!, $name: String!) { update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) { id name } }`,
      variables: { id: wfB.id, name: "hacked" },
    }, editorHeaders)
  );

  // 5. INSERT workflow into Org B
  show(
    "5. editor: INSERT workflow with org_id = Org B (must error: insert check)",
    {
      query: `mutation($org: uuid!, $name: String!) { insert_workflows_one(object: { org_id: $org, name: $name }) { id } }`,
      variables: { org: orgB.id, name: "sneaky" },
    },
    editorHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `mutation($org: uuid!, $name: String!) { insert_workflows_one(object: { org_id: $org, name: $name }) { id } }`,
      variables: { org: orgB.id, name: "sneaky" },
    }, editorHeaders)
  );

  // 6. VIEWER tries to update Org A workflow (permission gap check)
  show(
    "6. viewer: UPDATE Org A workflow by id (must error: no update permission)",
    {
      query: `mutation($id: uuid!) { update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: "nope" }) { id } }`,
      variables: { id: wfA.id },
    },
    viewerHeaders,
    await post(`${endpoint}/v1/graphql`, {
      query: `mutation($id: uuid!) { update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: "nope" }) { id } }`,
      variables: { id: wfA.id },
    }, viewerHeaders)
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});