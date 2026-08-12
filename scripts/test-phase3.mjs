import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function loadEnv(file) {
  try {
    const content = readFileSync(file, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return vars;
  } catch {
    return {};
  }
}

const nhostEnv = loadEnv(join(repoRoot, 'nhost', '.env'));
const mltEnv = loadEnv('C:\\Users\\Asus\\Documents\\Default Project\\mlt-ai-app\\server\\.env');

const HASURA = process.env.HASURA_ENDPOINT || 'https://pgqeznozctfsgrgpgxwg.hasura.ap-south-1.nhost.run/v1/graphql';
const ADMIN = process.env.HASURA_ADMIN_SECRET || nhostEnv.HASURA_GRAPHQL_ADMIN_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY || mltEnv.GEMINI_API_KEY;

process.env.NHOST_ADMIN_SECRET = ADMIN;
process.env.NHOST_HASURA_URL = HASURA.replace(/\/v1\/graphql$/, '');
process.env.GEMINI_API_KEY = GEMINI_KEY;
process.env.RUN_TIME_BUDGET_MS = '30000';

const { default: handler } = await import('../functions/trigger-workflow-run.js');
const { default: approveHandler } = await import('../functions/approve-step.js');

const gql = async (query, variables) => {
  const res = await fetch(HASURA, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

const ORG_A = 'c58b68ba-0712-46e7-a71f-3a1b05a7c619';
const ORG_B = '5cb85831-8b27-48de-8d45-1dfe6fed7b9e';
const USERS = {
  a_owner: '56bed534-e2cb-48a6-ad33-8798d3f665c7',
  a_editor: '64869a62-678b-492d-8111-ff7fbddd2fb5',
  a_viewer: '30d8b308-ea9f-436b-982f-5820b5f82a33',
  b_owner: 'b13434a1-fbd2-46bb-bdfa-91da62602ee7',
};

async function invokeAction(workflowId, userId, role) {
  const req = {
    body: {
      action: { name: 'triggerWorkflowRun' },
      input: { workflow_id: workflowId },
      session_variables: {
        'x-hasura-role': role,
        'x-hasura-user-id': userId,
        'x-hasura-allowed-roles': `[${role}]`,
      },
    },
  };
  const res = { code: 0, body: null };
  const respond = { status: (code) => ({ json: (body) => { res.code = code; res.body = body; } }) };
  await handler(req, respond);
  return res;
}

async function invokeApprove(stepRunId, userId, role) {
  const req = {
    body: {
      action: { name: 'approveStep' },
      input: { step_run_id: stepRunId },
      session_variables: {
        'x-hasura-role': role,
        'x-hasura-user-id': userId,
        'x-hasura-allowed-roles': `[${role}]`,
      },
    },
  };
  const res = { code: 0, body: null };
  const respond = { status: (code) => ({ json: (body) => { res.code = code; res.body = body; } }) };
  await approveHandler(req, respond);
  return res;
}

async function ensureWorkflow(name, steps) {
  const existing = await gql(`query ($name: String!, $orgId: uuid!) { workflows(where: { name: { _eq: $name }, org_id: { _eq: $orgId } }) { id } }`, { name, orgId: ORG_A });
  if (existing.workflows.length) return existing.workflows[0].id;
  const created = await gql(
    `mutation ($name: String!, $orgId: uuid!, $steps: [workflow_steps_insert_input!]!) {
      insert_workflows_one(object: { name: $name, org_id: $orgId, description: "phase 3 demo", workflow_steps: { data: $steps } }) { id }
    }`,
    { name, orgId: ORG_A, steps }
  );
  return created.insert_workflows_one.id;
}

async function getQuota() {
  const data = await gql(`query ($orgId: uuid!) { organizations_by_pk(id: $orgId) { quota_used quota_limit } }`, { orgId: ORG_A });
  return data.organizations_by_pk;
}

async function latestRun(workflowId) {
  const data = await gql(
    `query ($workflowId: uuid!) {
      workflow_runs(where: { workflow_id: { _eq: $workflowId } }, order_by: { started_at: desc }, limit: 1) {
        id status triggered_by trigger_type
      }
    }`,
    { workflowId }
  );
  return data.workflow_runs[0] || null;
}

async function getRun(runId) {
  return gql(
    `query ($id: uuid!) {
      workflow_runs_by_pk(id: $id) { id status triggered_by trigger_type }
      step_runs(where: { workflow_run_id: { _eq: $id } }, order_by: { id: asc }) {
        id status attempt_count error output approved_by approved_at
        workflow_step { type config position }
      }
    }`,
    { id: runId }
  );
}

async function cleanupRuns() {
  await gql(`mutation { delete_workflow_runs(where: { org_id: { _eq: "${ORG_A}" } }) { affected_rows } }`);
}

async function cleanupDemoWorkflows() {
  await gql(`mutation { delete_workflows(where: { org_id: { _eq: "${ORG_A}" }, name: { _ilike: "Demo:%" } }) { affected_rows } }`);
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`); };

const stub = createServer((req, res) => {
  const hit = req.url;
  stub.hits[hit] = (stub.hits[hit] || 0) + 1;
  const failures = hit === '/always-fail' ? Infinity : hit === '/retry-once' ? 1 : 0;
  if (stub.hits[hit] <= failures) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'stub failure', n: stub.hits[hit] }));
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hit: stub.hits[hit] }));
  }
});
stub.hits = {};
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;
console.log('stub server at', STUB);

try {
  await cleanupRuns();
  await cleanupDemoWorkflows();
  await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: 0 }) { id } }`, { orgId: ORG_A });

  const wfApproval = await ensureWorkflow('Demo: approval gate', [
    { position: 1, type: 'llm_call', config: { prompt: 'Say the single word: yes', system: 'Reply with exactly one word.' } },
    { position: 2, type: 'approval_gate', config: { note: 'human must approve before proceeding' } },
  ]);

  const wfPipeline = await ensureWorkflow('Demo: full pipeline', [
    { position: 1, type: 'db_write', config: { note: 'hello' } },
    { position: 2, type: 'conditional_branch', config: { equals: 'yes' } },
    { position: 3, type: 'notify', config: { channel: 'email', note: 'this should be skipped' } },
    { position: 4, type: 'http_request', config: { url: `${STUB}/pipeline`, method: 'GET' } },
    { position: 5, type: 'db_write', config: { note: 'real insert patched after workflow id known' } },
  ]);
  await gql(
    `mutation ($workflowId: uuid!) {
      update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "db_write" }, position: { _eq: 5 } },
        _set: { config: { table: "workflow_triggers", data: { workflow_id: $workflowId, type: "webhook" } } }) { affected_rows }
    }`,
    { workflowId: wfPipeline }
  );
  await gql(
    `mutation ($workflowId: uuid!, $url: String!) {
      update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "http_request" }, position: { _eq: 4 } },
        _set: { config: { url: $url, method: "GET" } }) { affected_rows }
    }`,
    { workflowId: wfPipeline, url: `${STUB}/pipeline` }
  );

  const wfRetry = await ensureWorkflow('Demo: retry and fail', [
    { position: 1, type: 'http_request', config: { url: `${STUB}/retry-once`, method: 'GET' } },
  ]);
  await gql(
    `mutation ($workflowId: uuid!, $url: String!) {
      update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "http_request" } },
        _set: { config: { url: $url, method: "GET" } }) { affected_rows }
    }`,
    { workflowId: wfRetry, url: `${STUB}/retry-once` }
  );

  const wfAlwaysFail = await ensureWorkflow('Demo: hard failure', [
    { position: 1, type: 'http_request', config: { url: `${STUB}/always-fail`, method: 'GET' } },
  ]);
  await gql(
    `mutation ($workflowId: uuid!, $url: String!) {
      update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "http_request" } },
        _set: { config: { url: $url, method: "GET" } }) { affected_rows }
    }`,
    { workflowId: wfAlwaysFail, url: `${STUB}/always-fail` }
  );

  const wfDoubleGate = await ensureWorkflow('Demo: double gate', [
    { position: 1, type: 'db_write', config: { note: 'hello' } },
    { position: 2, type: 'approval_gate', config: { note: 'first gate' } },
    { position: 3, type: 'llm_call', config: { prompt: 'Say the single word: ok', system: 'Reply with exactly one word.' } },
    { position: 4, type: 'approval_gate', config: { note: 'second gate' } },
  ]);

  const q0 = await getQuota();

  let r = await invokeAction(wfApproval, USERS.a_viewer, 'viewer');
  check('S1 viewer rejected', r.code === 400 && r.body.extensions.code === 'not-authorized', JSON.stringify(r.body));

  r = await invokeAction(wfApproval, USERS.b_owner, 'owner');
  check('S1b foreign org member rejected', r.code === 400 && r.body.extensions.code === 'not-authorized', JSON.stringify(r.body));

  await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: ${q0.quota_limit} }) { id } }`, { orgId: ORG_A });
  r = await invokeAction(wfApproval, USERS.a_owner, 'owner');
  check('S2 quota exceeded rejected', r.code === 400 && r.body.extensions.code === 'quota-exceeded', JSON.stringify(r.body));
  await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: 0 }) { id } }`, { orgId: ORG_A });

  r = await invokeAction(wfApproval, USERS.a_owner, 'owner');
  const runApproval = r.body?.workflow_run_id;
  const stateApproval = runApproval ? await getRun(runApproval) : null;
  check('S3 approval pauses run', r.code === 200 && r.body.status === 'paused', JSON.stringify(r.body));
  check('S3b run status paused in DB', stateApproval?.workflow_runs_by_pk?.status === 'paused', JSON.stringify(stateApproval?.workflow_runs_by_pk));
  const gateStep = stateApproval?.step_runs.find((s) => s.workflow_step.type === 'approval_gate');
  const llmStep = stateApproval?.step_runs.find((s) => s.workflow_step.type === 'llm_call');
  check('S3c llm step completed, gate still running', llmStep?.status === 'completed' && gateStep?.status === 'running', `llm=${llmStep?.status} gate=${gateStep?.status}`);
  const qAfterApproval = await getQuota();
  check('S3d quota not consumed by paused run', qAfterApproval.quota_used === 0, `quota_used=${qAfterApproval.quota_used}`);

  r = await invokeAction(wfPipeline, USERS.a_editor, 'editor');
  const runPipeline = r.body?.workflow_run_id;
  const statePipeline = runPipeline ? await getRun(runPipeline) : null;
  check('S4 full pipeline completes', r.code === 200 && r.body.status === 'completed', JSON.stringify(r.body));
  const byType = Object.fromEntries(statePipeline?.step_runs.map((s) => [s.workflow_step.type, s.status]) || []);
  check('S4b notify skipped by branch', byType.notify === 'skipped', JSON.stringify(byType));
  check('S4c db/http/db completed', byType.db_write === 'completed' && byType.http_request === 'completed', JSON.stringify(byType));
  const branch = statePipeline?.step_runs.find((s) => s.workflow_step.type === 'conditional_branch');
  check('S4d branch output records mismatch', branch?.output?.matched === false, JSON.stringify(branch?.output));
  const insertedTrigger = statePipeline?.step_runs.find((s) => s.output?.inserted);
  check('S4e real db_write inserted a row', !!insertedTrigger?.output?.id, JSON.stringify(insertedTrigger?.output));
  const qAfterPipeline = await getQuota();
  check('S4f quota incremented once', qAfterPipeline.quota_used === 1, `quota_used=${qAfterPipeline.quota_used}`);

  r = await invokeAction(wfRetry, USERS.a_owner, 'owner');
  console.log('[harness] S5 response:', JSON.stringify(r), 'stub hits:', JSON.stringify(stub.hits));
  const runRetry = r.body?.workflow_run_id;
  const stateRetry = runRetry ? await getRun(runRetry) : null;
  check('S5 retry succeeds after 1 failure', r.code === 200 && r.body.status === 'completed', `stub hits=${stub.hits['/retry-once']}`);
  const retryStep = stateRetry?.step_runs[0];
  check('S5b attempt_count recorded as 2', retryStep?.attempt_count === 2, `attempt_count=${retryStep?.attempt_count}`);
  check('S5c final output is the 200 response', retryStep?.output?.status === 200, JSON.stringify(retryStep?.output));

  const qAfterRetry = await getQuota();
  check('S5d quota incremented to 2', qAfterRetry.quota_used === 2, `quota_used=${qAfterRetry.quota_used}`);

  r = await invokeAction(wfAlwaysFail, USERS.a_owner, 'owner');
  const runFail = await latestRun(wfAlwaysFail);
  const stateFail = runFail ? await getRun(runFail.id) : null;
  check('S6 hard failure returns step-failed', r.code === 400 && r.body.extensions.code === 'step-failed', JSON.stringify(r.body));
  check('S6b run marked failed', stateFail?.workflow_runs_by_pk?.status === 'failed', JSON.stringify(stateFail?.workflow_runs_by_pk));
  check('S6c step has error + attempts in output', stateFail?.step_runs[0]?.error && stateFail?.step_runs[0]?.output?.attempts?.length === 2, JSON.stringify(stateFail?.step_runs[0]?.output));
  const qAfterFail = await getQuota();
  check('S6d quota NOT incremented on failure', qAfterFail.quota_used === 2, `quota_used=${qAfterFail.quota_used}`);

  const gateStepRun = stateApproval.step_runs.find((s) => s.workflow_step.type === 'approval_gate');
  const llmOutput = stateApproval.step_runs.find((s) => s.workflow_step.type === 'llm_call');

  let a = await invokeApprove(gateStepRun.id, USERS.a_viewer, 'viewer');
  check('S7 viewer cannot approve', a.code === 400 && a.body.extensions.code === 'not-authorized', JSON.stringify(a.body));

  a = await invokeApprove(gateStepRun.id, USERS.b_owner, 'owner');
  check('S7b foreign org owner cannot approve', a.code === 400 && a.body.extensions.code === 'not-authorized', JSON.stringify(a.body));

  a = await invokeApprove(gateStepRun.id, USERS.a_editor, 'editor');
  check('S7c editor approves and run completes', a.code === 200 && a.body.status === 'completed', JSON.stringify(a.body));
  const stateAfterApprove = await getRun(runApproval);
  const gateAfter = stateAfterApprove.step_runs.find((s) => s.workflow_step.type === 'approval_gate');
  check('S7d gate step approved (by/at set)', gateAfter?.status === 'completed' && gateAfter?.approved_by === USERS.a_editor && !!gateAfter?.approved_at, JSON.stringify(gateAfter));
  check('S7e run status completed', stateAfterApprove.workflow_runs_by_pk.status === 'completed', stateAfterApprove.workflow_runs_by_pk.status);
  const qAfterApprove = await getQuota();
  check('S7f quota incremented only on final completion', qAfterApprove.quota_used === 3, `quota_used=${qAfterApprove.quota_used}`);

  a = await invokeApprove(gateStepRun.id, USERS.a_owner, 'owner');
  check('S7g approving twice rejected', a.code === 400 && a.body.extensions.code === 'step-not-pending', JSON.stringify(a.body));

  r = await invokeAction(wfDoubleGate, USERS.a_owner, 'owner');
  const runGate1 = r.body?.workflow_run_id;
  const stateGate1 = runGate1 ? await getRun(runGate1) : null;
  check('S8 run pauses at first gate', r.code === 200 && r.body.status === 'paused', JSON.stringify(r.body));
  const gate1 = stateGate1?.step_runs.find((s) => s.workflow_step.type === 'approval_gate' && s.workflow_step.position === 2);
  const llm1 = stateGate1?.step_runs.find((s) => s.workflow_step.type === 'llm_call');

  a = await invokeApprove(gate1.id, USERS.a_owner, 'owner');
  check('S8b approve gate1 resumes to gate2', a.code === 200 && a.body.status === 'paused', JSON.stringify(a.body));
  const stateBetween = await getRun(runGate1);
  const gate1After = stateBetween.step_runs.find((s) => s.workflow_step.type === 'approval_gate' && s.workflow_step.position === 2);
  const llm1After = stateBetween.step_runs.find((s) => s.workflow_step.type === 'llm_call');
  const gate2After = stateBetween.step_runs.find((s) => s.workflow_step.type === 'approval_gate' && s.workflow_step.position === 4);
  check('S8c gate1 approved, llm executed, gate2 running', gate1After?.status === 'completed' && llm1After?.status === 'completed' && gate2After?.status === 'running', `gate1=${gate1After?.status} llm=${llm1After?.status} gate2=${gate2After?.status}`);
  const qBetween = await getQuota();
  check('S8d quota not consumed at intermediate pause', qBetween.quota_used === 3, `quota_used=${qBetween.quota_used}`);

  a = await invokeApprove(gate2After.id, USERS.a_owner, 'owner');
  check('S8e approve gate2 completes run', a.code === 200 && a.body.status === 'completed', JSON.stringify(a.body));
  const qAfterGate2 = await getQuota();
  check('S8f quota incremented on final completion', qAfterGate2.quota_used === 4, `quota_used=${qAfterGate2.quota_used}`);
  const stateFinal = await getRun(runGate1);
  check('S8g run final status completed', stateFinal.workflow_runs_by_pk.status === 'completed', stateFinal.workflow_runs_by_pk.status);
  void llmOutput;

  if (insertedTrigger?.output?.id) {
    await gql(`mutation ($id: uuid!) { delete_workflow_triggers_by_pk(id: $id) { id } }`, { id: insertedTrigger.output.id });
  }

  console.log(`\n==== ${results.filter((x) => x.ok).length}/${results.length} checks passed ====`);
  console.log('\nDemo workflow ids:', JSON.stringify({ wfApproval, wfPipeline, wfRetry, wfAlwaysFail, wfDoubleGate }, null, 2));
} finally {
  stub.close();
}
