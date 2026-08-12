import { readFileSync } from 'node:fs';
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
const HASURA = process.env.HASURA_ENDPOINT || 'https://pgqeznozctfsgrgpgxwg.hasura.ap-south-1.nhost.run/v1/graphql';
const ADMIN = process.env.HASURA_ADMIN_SECRET || nhostEnv.HASURA_GRAPHQL_ADMIN_SECRET;
const FUNCTIONS_BASE = process.env.FUNCTIONS_BASE || 'https://pgqeznozctfsgrgpgxwg.functions.ap-south-1.nhost.run/v1';

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
const USERS = {
  a_owner: '56bed534-e2cb-48a6-ad33-8798d3f665c7',
  a_editor: '64869a62-678b-492d-8111-ff7fbddd2fb5',
  a_viewer: '30d8b308-ea9f-436b-982f-5820b5f82a33',
  b_owner: 'b13434a1-fbd2-46bb-bdfa-91da62602ee7',
};

async function callFunction(path, actionName, input, userId, role) {
  const res = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: { name: actionName },
      input,
      session_variables: {
        'x-hasura-role': role,
        'x-hasura-user-id': userId,
        'x-hasura-allowed-roles': `[${role}]`,
      },
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { http: res.status, body };
}

async function ensureWorkflow(name, steps) {
  const existing = await gql(`query ($name: String!, $orgId: uuid!) { workflows(where: { name: { _eq: $name }, org_id: { _eq: $orgId } }) { id } }`, { name, orgId: ORG_A });
  if (existing.workflows.length) return existing.workflows[0].id;
  const created = await gql(
    `mutation ($name: String!, $orgId: uuid!, $steps: [workflow_steps_insert_input!]!) {
      insert_workflows_one(object: { name: $name, org_id: $orgId, description: "phase 3/4 live demo", workflow_steps: { data: $steps } }) { id }
    }`,
    { name, orgId: ORG_A, steps }
  );
  return created.insert_workflows_one.id;
}

async function getQuota() {
  const data = await gql(`query ($orgId: uuid!) { organizations_by_pk(id: $orgId) { quota_used quota_limit } }`, { orgId: ORG_A });
  return data.organizations_by_pk;
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

async function latestRun(workflowId) {
  const data = await gql(
    `query ($workflowId: uuid!) {
      workflow_runs(where: { workflow_id: { _eq: $workflowId } }, order_by: { started_at: desc }, limit: 1) { id status }
    }`,
    { workflowId }
  );
  return data.workflow_runs[0] || null;
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`); };

const wfApproval = await ensureWorkflow('Demo: approval gate', [
  { position: 1, type: 'llm_call', config: { prompt: 'Say the single word: yes', system: 'Reply with exactly one word.' } },
  { position: 2, type: 'approval_gate', config: { note: 'human must approve before proceeding' } },
]);

const wfPipeline = await ensureWorkflow('Demo: full pipeline', [
  { position: 1, type: 'db_write', config: { note: 'hello' } },
  { position: 2, type: 'conditional_branch', config: { equals: 'yes' } },
  { position: 3, type: 'notify', config: { channel: 'email', note: 'this should be skipped' } },
  { position: 4, type: 'http_request', config: { url: 'https://jsonplaceholder.typicode.com/todos/1', method: 'GET' } },
  { position: 5, type: 'db_write', config: { note: 'patched to real insert below' } },
]);
await gql(
  `mutation ($workflowId: uuid!) {
    update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "db_write" }, position: { _eq: 5 } },
      _set: { config: { table: "workflow_triggers", data: { workflow_id: $workflowId, type: "webhook" } } }) { affected_rows }
  }`,
  { workflowId: wfPipeline }
);
await gql(
  `mutation ($workflowId: uuid!) {
    update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "http_request" } },
      _set: { config: { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" } }) { affected_rows }
  }`,
  { workflowId: wfPipeline }
);

const wfAlwaysFail = await ensureWorkflow('Demo: hard failure', [
  { position: 1, type: 'http_request', config: { url: 'https://nonexistent-host.invalid/', method: 'GET' } },
]);
await gql(
  `mutation ($workflowId: uuid!) {
    update_workflow_steps(where: { workflow_id: { _eq: $workflowId }, type: { _eq: "http_request" } },
      _set: { config: { url: "https://nonexistent-host.invalid/", method: "GET" } }) { affected_rows }
  }`,
  { workflowId: wfAlwaysFail }
);

const wfDoubleGate = await ensureWorkflow('Demo: double gate', [
  { position: 1, type: 'db_write', config: { note: 'hello' } },
  { position: 2, type: 'approval_gate', config: { note: 'first gate' } },
  { position: 3, type: 'llm_call', config: { prompt: 'Say the single word: ok', system: 'Reply with exactly one word.' } },
  { position: 4, type: 'approval_gate', config: { note: 'second gate' } },
]);

await gql(`mutation { delete_workflow_runs(where: { org_id: { _eq: "${ORG_A}" } }) { affected_rows } }`);
await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: 0 }) { id } }`, { orgId: ORG_A });

console.log('function base:', FUNCTIONS_BASE);
console.log('demo workflows:', JSON.stringify({ wfApproval, wfPipeline, wfAlwaysFail, wfDoubleGate }));

try {
  let r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfApproval }, USERS.a_viewer, 'viewer');
  check('L1 viewer rejected', r.http === 400 && r.body?.extensions?.code === 'not-authorized', `http=${r.http} ${JSON.stringify(r.body)}`);

  const quota = await getQuota();
  await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: ${quota.quota_limit} }) { id } }`, { orgId: ORG_A });
  r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfApproval }, USERS.a_owner, 'owner');
  check('L2 quota exceeded rejected', r.http === 400 && r.body?.extensions?.code === 'quota-exceeded', `http=${r.http} ${JSON.stringify(r.body)}`);
  await gql(`mutation ($orgId: uuid!) { update_organizations_by_pk(pk_columns: { id: $orgId }, _set: { quota_used: 0 }) { id } }`, { orgId: ORG_A });

  r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfApproval }, USERS.a_owner, 'owner');
  const runApproval = r.body?.workflow_run_id;
  const stateApproval = runApproval ? await getRun(runApproval) : null;
  check('L3 approval pauses run', r.http === 200 && r.body?.status === 'paused', `http=${r.http} ${JSON.stringify(r.body)}`);
  check('L3b run paused in DB, llm done, gate running', stateApproval?.workflow_runs_by_pk?.status === 'paused' &&
    stateApproval?.step_runs.some((s) => s.workflow_step.type === 'llm_call' && s.status === 'completed') &&
    stateApproval?.step_runs.some((s) => s.workflow_step.type === 'approval_gate' && s.status === 'running'),
    JSON.stringify(stateApproval?.step_runs.map((s) => [s.workflow_step.type, s.status])));

  const gateStepRun = stateApproval?.step_runs.find((s) => s.workflow_step.type === 'approval_gate');
  if (gateStepRun) {
    r = await callFunction('/approve-step', 'approveStep', { step_run_id: gateStepRun.id }, USERS.b_owner, 'owner');
    check('L4 foreign org owner cannot approve', r.http === 400 && r.body?.extensions?.code === 'not-authorized', `http=${r.http} ${JSON.stringify(r.body)}`);

    r = await callFunction('/approve-step', 'approveStep', { step_run_id: gateStepRun.id }, USERS.a_editor, 'editor');
    check('L4b editor approves, run completes', r.http === 200 && r.body?.status === 'completed', `http=${r.http} ${JSON.stringify(r.body)}`);
    const stateAfterApprove = await getRun(runApproval);
    const gateAfter = stateAfterApprove.step_runs.find((s) => s.workflow_step.type === 'approval_gate');
    check('L4c approved_by/at set', gateAfter?.approved_by === USERS.a_editor && !!gateAfter?.approved_at, JSON.stringify({ status: gateAfter?.status, approved_by: gateAfter?.approved_by, approved_at: gateAfter?.approved_at }));
  } else {
    check('L4 foreign org owner cannot approve', false, 'skipped: no gate step run');
    check('L4b editor approves, run completes', false, 'skipped: no gate step run');
    check('L4c approved_by/at set', false, 'skipped: no gate step run');
  }

  r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfPipeline }, USERS.a_editor, 'editor');
  const runPipeline = r.body?.workflow_run_id;
  const statePipeline = runPipeline ? await getRun(runPipeline) : null;
  const byType = Object.fromEntries(statePipeline?.step_runs.map((s) => [s.workflow_step.type, s.status]) || []);
  check('L5 full pipeline completes', r.http === 200 && r.body?.status === 'completed', `http=${r.http} ${JSON.stringify(r.body)}`);
  check('L5b notify skipped, others completed', byType.notify === 'skipped' && byType.http_request === 'completed' && byType.db_write === 'completed', JSON.stringify(byType));
  const httpStep = statePipeline?.step_runs.find((s) => s.workflow_step.type === 'http_request');
  check('L5c http output from jsonplaceholder', httpStep?.output?.status === 200, JSON.stringify(httpStep?.output?.body?.slice(0, 80)));

  r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfAlwaysFail }, USERS.a_owner, 'owner');
  const runFail = await latestRun(wfAlwaysFail);
  const stateFail = runFail ? await getRun(runFail.id) : null;
  check('L6 hard failure returns step-failed', r.http === 400 && r.body?.extensions?.code === 'step-failed', `http=${r.http} ${JSON.stringify(r.body)}`);
  check('L6b run marked failed', stateFail?.workflow_runs_by_pk?.status === 'failed', JSON.stringify(stateFail?.workflow_runs_by_pk));
  check('L6c step error + 2 attempts recorded', stateFail?.step_runs[0]?.error && stateFail?.step_runs[0]?.output?.attempts?.length === 2, JSON.stringify(stateFail?.step_runs[0]?.output));

  const quotaNow = await getQuota();
  check('L7 quota = 2 (approval + pipeline, failures excluded)', quotaNow.quota_used === 2, `quota_used=${quotaNow.quota_used}`);

  r = await callFunction('/trigger-workflow-run', 'triggerWorkflowRun', { workflow_id: wfDoubleGate }, USERS.a_owner, 'owner');
  const runGate1 = r.body?.workflow_run_id;
  const stateGate1 = runGate1 ? await getRun(runGate1) : null;
  check('L8 run pauses at first gate', r.http === 200 && r.body?.status === 'paused', `http=${r.http} ${JSON.stringify(r.body)}`);
  const gate1 = stateGate1?.step_runs.find((s) => s.workflow_step.type === 'approval_gate' && s.workflow_step.position === 2);

  if (gate1) {
    r = await callFunction('/approve-step', 'approveStep', { step_run_id: gate1.id }, USERS.a_owner, 'owner');
    check('L8b approve gate1 resumes to gate2', r.http === 200 && r.body?.status === 'paused', `http=${r.http} ${JSON.stringify(r.body)}`);
    const stateBetween = await getRun(runGate1);
    const gate2 = stateBetween.step_runs.find((s) => s.workflow_step.type === 'approval_gate' && s.workflow_step.position === 4);
    const llm1 = stateBetween.step_runs.find((s) => s.workflow_step.type === 'llm_call');
    check('L8c llm executed, gate2 running', llm1?.status === 'completed' && gate2?.status === 'running', `llm=${llm1?.status} gate2=${gate2?.status}`);

    if (gate2) {
      r = await callFunction('/approve-step', 'approveStep', { step_run_id: gate2.id }, USERS.a_owner, 'owner');
      check('L8d approve gate2 completes run', r.http === 200 && r.body?.status === 'completed', `http=${r.http} ${JSON.stringify(r.body)}`);
    } else {
      check('L8d approve gate2 completes run', false, 'skipped: no gate2 step run');
    }
  } else {
    check('L8b approve gate1 resumes to gate2', false, 'skipped: no gate1 step run');
    check('L8c llm executed, gate2 running', false, 'skipped: no gate1 step run');
    check('L8d approve gate2 completes run', false, 'skipped: no gate1 step run');
  }
  const quotaFinal = await getQuota();
  check('L8e quota = 3 after final completion', quotaFinal.quota_used === 3, `quota_used=${quotaFinal.quota_used}`);

  console.log(`\n==== ${results.filter((x) => x.ok).length}/${results.length} checks passed ====`);
} catch (err) {
  console.error('FATAL:', err.message);
}
