const { GoogleGenAI } = require('@google/genai');

const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Engine budget must stay well under the serverless function's hard timeout
// (10s on nhost) so runs always fail cleanly instead of the lambda being
// killed mid-flight. Cold start + Gemini round trip eats ~2s + ~4-6s.
const TIME_BUDGET_MS = Number(process.env.RUN_TIME_BUDGET_MS || 6000);
// Only attempt a retry when there is still enough budget left for one more
// attempt; otherwise report the first error immediately.
const RETRY_MARGIN_MS = 2000;

function graphqlUrl() {
  const raw = process.env.NHOST_HASURA_URL || process.env.NHOST_GRAPHQL_URL || '';
  let url = raw;
  if (!url) {
    const sub = process.env.NHOST_SUBDOMAIN;
    const region = process.env.NHOST_REGION;
    if (sub && region) url = `https://${sub}.hasura.${region}.nhost.run`;
  }
  if (!url) throw new Error('no graphql url configured');
  if (/\/v1\/graphql$/.test(url)) return url;
  url = url.replace(/\/+$/, '');
  if (/\/v1$/.test(url)) url = url.slice(0, -3);
  return `${url}/v1/graphql`;
}

async function gql(query, variables) {
  const res = await fetch(graphqlUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function actionError(res, message, code) {
  return res.status(400).json({ message, extensions: { code } });
}

async function executeStep(step, prevOutput) {
  const type = step.type;
  const config = step.config || {};
  switch (type) {
    case 'llm_call':
      return runLlmCall(config);
    case 'http_request':
      return runHttpRequest(config);
    case 'db_write':
      return runDbWrite(config);
    case 'conditional_branch':
      return runConditionalBranch(config, prevOutput);
    case 'notify':
      console.log('[notify]', JSON.stringify(config));
      return { notified: true, channel: config.channel || 'none', note: config.note || null };
    case 'approval_gate':
      return { gate: true, note: config.note || null };
    default:
      throw new Error(`unknown step type: ${type}`);
  }
}

async function runLlmCall(config) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  if (!config.prompt) throw new Error('llm_call requires config.prompt');
  const genai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  const interaction = await genai.interactions.create({
    model: config.model || 'gemini-3.6-flash',
    system_instruction: config.system || 'You are a concise workflow automation assistant. Reply in under 80 words.',
    input: config.prompt,
    generation_config: { max_output_tokens: 128 },
  });
  return { result: interaction.output_text || '' };
}

async function runHttpRequest(config) {
  if (!config.url) throw new Error('http_request requires config.url');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(config.url, {
      method: (config.method || 'GET').toUpperCase(),
      headers: { 'content-type': 'application/json', ...(config.headers || {}) },
      body: config.body ? JSON.stringify(config.body) : undefined,
      signal: controller.signal,
    });
    let body = '';
    try {
      const text = await res.text();
      body = text.length > 2000 ? text.slice(0, 2000) : text;
    } catch (e) {
      body = 'unreadable response body';
    }
    if (!res.ok) {
      throw new Error(`http_request failed: ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return { status: res.status, statusText: res.statusText, body };
  } finally {
    clearTimeout(timer);
  }
}

async function runDbWrite(config) {
  if (config.table && config.data) {
    const keys = Object.keys(config.data).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    if (!keys.length) throw new Error('db_write data has no valid column names');
    const objectLiteral = `{ ${keys.map((k) => `${k}: ${JSON.stringify(config.data[k])}`).join(', ')} }`;
    const mutation = `mutation { insert_${config.table}_one(object: ${objectLiteral}) { id } }`;
    const data = await gql(mutation, {});
    return { inserted: true, id: data[`insert_${config.table}_one`]?.id || null };
  }
  return { note: config.note || 'db_write stub', inserted: false };
}

function runConditionalBranch(config, prevOutput) {
  const expected = String(config.equals ?? '').trim();
  const actual = String(prevOutput?.result ?? '').trim();
  const matched = actual === expected;
  return {
    matched,
    skip_next: config.skip_on_mismatch === false ? false : !matched,
    expected,
    actual: actual.slice(0, 200),
  };
}

const STEP_MARK = {
  running: `
    mutation ($stepRunId: uuid!, $attempt: Int!) {
      update_step_runs_by_pk(pk_columns: { id: $stepRunId },
        _set: { status: "running", attempt_count: $attempt, started_at: "now()" }
      ) { id }
    }`,
  completed: `
    mutation ($stepRunId: uuid!, $attempt: Int!, $output: jsonb) {
      update_step_runs_by_pk(pk_columns: { id: $stepRunId },
        _set: { status: "completed", attempt_count: $attempt, output: $output, completed_at: "now()" }
      ) { id }
    }`,
  failed: `
    mutation ($stepRunId: uuid!, $attempt: Int!, $error: String, $output: jsonb) {
      update_step_runs_by_pk(pk_columns: { id: $stepRunId },
        _set: { status: "failed", attempt_count: $attempt, error: $error, output: $output, completed_at: "now()" }
      ) { id }
    }`,
  skipped: `
    mutation ($stepRunId: uuid!) {
      update_step_runs_by_pk(pk_columns: { id: $stepRunId },
        _set: { status: "skipped", completed_at: "now()" }
      ) { id }
    }`,
  approved: `
    mutation ($stepRunId: uuid!, $approvedBy: uuid!, $output: jsonb) {
      update_step_runs_by_pk(pk_columns: { id: $stepRunId },
        _set: { status: "completed", approved_by: $approvedBy, approved_at: "now()", completed_at: "now()", output: $output }
      ) { id }
    }`,
};

const RUN_MARK = {
  running: `mutation ($runId: uuid!) { update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: "running" }) { id } }`,
  completed: `mutation ($runId: uuid!) { update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: "completed", completed_at: "now()" }) { id } }`,
  paused: `mutation ($runId: uuid!) { update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: "paused" }) { id } }`,
  failed: `mutation ($runId: uuid!) { update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: "failed", completed_at: "now()" }) { id } }`,
};

async function loadWorkflow(workflowId) {
  const data = await gql(
    `query ($id: uuid!) {
      workflows_by_pk(id: $id) {
        id
        name
        org_id
        org { id quota_used quota_limit }
        steps: workflow_steps(order_by: { position: asc }) {
          id
          type
          config
        }
      }
    }`,
    { id: workflowId }
  );
  if (!data.workflows_by_pk) {
    const err = new Error('workflow not found');
    err.code = 'workflow-not-found';
    throw err;
  }
  return data.workflows_by_pk;
}

async function isMember(orgId, userId, role) {
  const data = await gql(
    `query ($orgId: uuid!, $userId: uuid!, $role: String!) {
      org_members(where: { org_id: { _eq: $orgId }, user_id: { _eq: $userId }, role: { _eq: $role } }, limit: 1) { id }
    }`,
    { orgId, userId, role }
  );
  return data.org_members.length > 0;
}

async function createRun(workflowId, orgId, userId) {
  const data = await gql(
    `mutation ($workflowId: uuid!, $orgId: uuid!, $userId: uuid!) {
      insert_workflow_runs_one(object: { workflow_id: $workflowId, org_id: $orgId, status: "running", triggered_by: $userId, trigger_type: "manual" }) { id }
    }`,
    { workflowId, orgId, userId }
  );
  return data.insert_workflow_runs_one.id;
}

async function createStepRuns(runId, steps) {
  if (!steps.length) return {};
  const data = await gql(
    `mutation ($objects: [step_runs_insert_input!]!) {
      insert_step_runs(objects: $objects) { returning { id workflow_step_id } }
    }`,
    { objects: steps.map((s) => ({ workflow_run_id: runId, workflow_step_id: s.id, status: 'pending' })) }
  );
  const map = {};
  for (const row of data.insert_step_runs.returning) map[row.workflow_step_id] = row.id;
  return map;
}

async function incrementQuota(orgId) {
  await gql(
    `mutation ($orgId: uuid!) {
      update_organizations_by_pk(pk_columns: { id: $orgId }, _inc: { quota_used: 1 }) { id }
    }`,
    { orgId }
  );
}

class StepFailedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'step-failed';
  }
}

async function executeSteps({ steps, stepRunIds, runId, orgId, startIndex = 0, previousOutput = null, started = Date.now() }) {
  for (let i = startIndex; i < steps.length; i++) {
    const elapsed = Date.now() - started;
    if (elapsed > TIME_BUDGET_MS) {
      await gql(RUN_MARK.failed, { runId });
      throw new StepFailedError(`step "${steps[i].type}" did not finish within the ${TIME_BUDGET_MS / 1000}s budget`);
    }

    const step = steps[i];
    if (step.pending_skip) {
      await gql(STEP_MARK.skipped, { stepRunId: stepRunIds[step.id] });
      continue;
    }

    await gql(STEP_MARK.running, { stepRunId: stepRunIds[step.id], attempt: 1 });
    await gql(RUN_MARK.running, { runId });

    let outcome;
    let attempts = [];
    const budgetLeft = () => TIME_BUDGET_MS - (Date.now() - started);
    try {
      outcome = await executeStep(step, previousOutput);
      attempts.push({ attempt: 1, ok: true });
    } catch (err1) {
      attempts.push({ attempt: 1, ok: false, error: err1.message });
      if ((step.type === 'llm_call' || step.type === 'http_request') && budgetLeft() > RETRY_MARGIN_MS) {
        try {
          await gql(STEP_MARK.running, { stepRunId: stepRunIds[step.id], attempt: 2 });
          outcome = await executeStep(step, previousOutput);
          attempts.push({ attempt: 2, ok: true });
        } catch (err2) {
          attempts.push({ attempt: 2, ok: false, error: err2.message });
        }
      }
    }

    if (attempts.some((a) => a.ok)) {
      const finalAttempt = attempts.filter((a) => a.ok).pop();

      if (step.type === 'approval_gate') {
        await gql(RUN_MARK.paused, { runId });
        return { status: 'paused', runId };
      }

      await gql(STEP_MARK.completed, { stepRunId: stepRunIds[step.id], attempt: finalAttempt.attempt, output: outcome });
      previousOutput = outcome;

      if (step.type === 'conditional_branch' && outcome.skip_next && steps[i + 1]) {
        steps[i + 1].pending_skip = true;
      }
    } else {
      const last = attempts[attempts.length - 1];
      await gql(STEP_MARK.failed, {
        stepRunId: stepRunIds[step.id],
        attempt: last.attempt,
        error: last.error,
        output: { attempts },
      });
      await gql(RUN_MARK.failed, { runId });
      console.log('[engine] failed at step', i, last.error);
      throw new StepFailedError(`workflow failed at step "${step.type}": ${last.error}`);
    }
  }

  await incrementQuota(orgId);
  await gql(RUN_MARK.completed, { runId });
  return { status: 'completed', runId };
}

module.exports = {
  ADMIN_SECRET,
  GEMINI_KEY,
  TIME_BUDGET_MS,
  graphqlUrl,
  gql,
  actionError,
  executeStep,
  runLlmCall,
  runHttpRequest,
  runDbWrite,
  runConditionalBranch,
  STEP_MARK,
  RUN_MARK,
  loadWorkflow,
  isMember,
  createRun,
  createStepRuns,
  incrementQuota,
  executeSteps,
  StepFailedError,
};
