// deploy-kick 1: trigger nhost auto-deploy webhook
const {
  gql,
  actionError,
  loadWorkflow,
  isMember,
  createRun,
  createStepRuns,
  executeSteps,
} = require('./_shared/engine');

module.exports = async function triggerWorkflowRun(req, res) {
  const session = req.body?.session_variables || {};
  const role = session['x-hasura-role'];
  const userId = session['x-hasura-user-id'];
  const workflowId = req.body?.input?.workflow_id;

  console.log('[triggerWorkflowRun] role=', role, 'user=', userId, 'workflow=', workflowId);

  if (!role || !['owner', 'editor'].includes(role)) {
    return actionError(res, 'only owner or editor roles can trigger runs', 'not-authorized');
  }
  if (!userId) return actionError(res, 'missing user id', 'not-authorized');
  if (!workflowId) return actionError(res, 'missing workflow_id', 'invalid-input');

  try {
    const workflow = await loadWorkflow(workflowId);
    const orgId = workflow.org_id;

    const isOwner = await isMember(orgId, userId, 'owner');
    const isEditor = await isMember(orgId, userId, 'editor');
    if (!isOwner && !isEditor) {
      return actionError(res, 'user is not an owner or editor of the workflow organization', 'not-authorized');
    }

    const { quota_used, quota_limit } = workflow.org;
    if (quota_used >= quota_limit) {
      return actionError(res, `quota exceeded (${quota_used}/${quota_limit})`, 'quota-exceeded');
    }

    const steps = workflow.steps;
    const runId = await createRun(workflowId, orgId, userId);
    const stepRunIds = await createStepRuns(runId, steps);
    console.log('[triggerWorkflowRun] runId=', runId, 'steps=', steps.length);

    const result = await executeSteps({ steps, stepRunIds, runId, orgId });
    if (result.status === 'paused') {
      console.log('[triggerWorkflowRun] paused at approval gate, runId=', runId);
      return res.status(200).json({ workflow_run_id: runId, status: 'paused', message: 'workflow paused pending approval' });
    }
    console.log('[triggerWorkflowRun] completed runId=', runId);
    return res.status(200).json({ workflow_run_id: runId, status: 'completed' });
  } catch (err) {
    console.error('[triggerWorkflowRun] error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    return actionError(res, err.message, err.code || 'internal-error');
  }
};
