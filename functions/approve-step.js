const {
  gql,
  actionError,
  loadWorkflow,
  isMember,
  executeSteps,
  STEP_MARK,
  RUN_MARK,
} = require('./_shared/engine');

module.exports = async function approveStep(req, res) {
  const session = req.body?.session_variables || {};
  const role = session['x-hasura-role'];
  const userId = session['x-hasura-user-id'];
  const stepRunId = req.body?.input?.step_run_id;

  console.log('[approveStep] role=', role, 'user=', userId, 'step_run=', stepRunId);

  if (!role || !['owner', 'editor'].includes(role)) {
    return actionError(res, 'only owner or editor roles can approve steps', 'not-authorized');
  }
  if (!userId) return actionError(res, 'missing user id', 'not-authorized');
  if (!stepRunId) return actionError(res, 'missing step_run_id', 'invalid-input');

  try {
    const data = await gql(
      `query ($id: uuid!) {
        step_runs_by_pk(id: $id) {
          id
          status
          output
          workflow_step { id type config position }
          workflow_run {
            id
            status
            org_id
            workflow_id
          }
        }
      }`,
      { id: stepRunId }
    );
    const stepRun = data.step_runs_by_pk;
    if (!stepRun) return actionError(res, 'step_run not found', 'step-run-not-found');
    if (stepRun.workflow_step.type !== 'approval_gate') {
      return actionError(res, 'only approval_gate steps can be approved', 'invalid-step');
    }
    if (stepRun.status !== 'running') {
      return actionError(res, `step_run is not awaiting approval (status: ${stepRun.status})`, 'step-not-pending');
    }
    const run = stepRun.workflow_run;
    if (run.status !== 'paused') {
      return actionError(res, `workflow run is not paused (status: ${run.status})`, 'run-not-paused');
    }

    const isOwner = await isMember(run.org_id, userId, 'owner');
    const isEditor = await isMember(run.org_id, userId, 'editor');
    if (!isOwner && !isEditor) {
      return actionError(res, 'user is not an owner or editor of the run organization', 'not-authorized');
    }

    await gql(STEP_MARK.approved, {
      stepRunId,
      approvedBy: userId,
      output: { ...(stepRun.output || {}), approved: true, approved_by: userId },
    });
    await gql(RUN_MARK.running, { runId: run.id });
    console.log('[approveStep] approved step_run=', stepRunId, 'resuming run=', run.id);

    const workflow = await loadWorkflow(run.workflow_id);
    const steps = workflow.steps;
    const gateIndex = steps.findIndex((s) => s.id === stepRun.workflow_step.id);
    if (gateIndex === -1) return actionError(res, 'approval step no longer part of the workflow', 'step-not-in-workflow');

    const stepRunData = await gql(
      `query ($runId: uuid!) {
        step_runs(where: { workflow_run_id: { _eq: $runId } }) { id workflow_step_id }
      }`,
      { runId: run.id }
    );
    const stepRunIds = {};
    for (const row of stepRunData.step_runs) stepRunIds[row.workflow_step_id] = row.id;

    const result = await executeSteps({ steps, stepRunIds, runId: run.id, orgId: run.org_id, startIndex: gateIndex + 1 });
    console.log('[approveStep] run=', run.id, 'status=', result.status);
    return res.status(200).json({
      workflow_run_id: run.id,
      status: result.status,
      step_run_id: stepRunId,
      message: result.status === 'paused' ? 'run paused at next approval gate' : 'run completed',
    });
  } catch (err) {
    console.error('[approveStep] error:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    return actionError(res, err.message, err.code || 'internal-error');
  }
};
