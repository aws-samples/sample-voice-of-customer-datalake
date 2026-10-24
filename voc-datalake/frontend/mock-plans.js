// Assistant plans mock (docs/assistant-plan-mode.md → "API"): the `/agents/plans*`
// routes of agents_handler.py in their wire shape — POST {plan, conversation_id?}
// → 202 {plan_id, status:'approved'} (400 {success:false, message, errors}),
// GET one → {plan: PlanView}, GET list → {plans: [...]}, cancel, and a step's
// approve / decline (409 unless that step needs approval). Approve requires
// `{fingerprint}` of the paused write the card showed: 400 when absent, 409
// "This step changed; review it again" when it is not the paused write's.
//
// Stateful for the life of the mock process, and it MOVES: every GET of a plan
// advances it one step (approved → running, a step pending → running/waiting →
// done), so the bubble's progress view has something to show. The second write
// step of each plan stops at `needs_approval` until it is approved or declined;
// a decline fails that step and skips everything depending on it. A seeded plan
// (`pl_a1b2c3d4e5f6`) keeps the list and the probes non-empty.
// Wired into mock-server.js by handleDomainModules (before the agents routes,
// which would read `plans` as an agent id).

import { createHash } from 'node:crypto';

const PREFIX = '/agents/plans';
const DONE = new Set(['done', 'failed', 'skipped', 'cancelled']);
const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled', 'expired']);
const OUTPUT_MAX = 500;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const STEP_CHANGED = 'This step changed; review it again';

/** A stable sha256-shaped fingerprint of tool + args (the real one is the canonical write fingerprint). */
const fingerprintOf = (tool, args) => createHash('sha256').update(JSON.stringify([tool, args])).digest('hex');

const plans = new Map();
let planCounter = 0;

const now = () => new Date().toISOString();
const hex12 = () => (Date.now().toString(16) + (++planCounter).toString(16).padStart(4, '0')).slice(-12).padStart(12, '0');

function stepView(step, index) {
  return {
    id: step.id, title: step.title, pack: step.pack, kind: step.kind, after: step.after ?? [],
    status: 'pending', outputs: {}, index, write: step.write ?? null, produces: step.produces ?? [],
  };
}

function createPlan(plan, conversationId, planId = `pl_${hex12()}`) {
  const created = now();
  const writes = plan.steps.filter((s) => s.kind === 'write');
  const record = {
    plan_id: planId, status: 'approved', goal: plan.goal, created_at: created, updated_at: created,
    steps: plan.steps.map(stepView), askAt: writes[1]?.id ?? null,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
  plans.set(planId, record);
  return record;
}

/** The public PlanView (internal bookkeeping stripped). */
const PLAN_FIELDS = ['plan_id', 'status', 'goal', 'created_at', 'updated_at', 'started_at', 'finished_at', 'conversation_id', 'summary'];
// Markdown like a real analysis step's result (the plan card renders it, collapsed when long).
const MOCK_THINK_RESULT = '## Mock findings\n\n1. **Delays**: most complaints mention late departures.\n2. **Baggage fees**: seen as unclear at booking.'
const STEP_FIELDS = ['id', 'title', 'pack', 'kind', 'after', 'status', 'started_at', 'finished_at', 'outputs', 'error', 'pending'];
const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source[f] !== undefined).map((f) => [f, source[f]]));

function view(record) {
  return { ...pick(record, PLAN_FIELDS), steps: record.steps.map((step) => pick(step, STEP_FIELDS)) };
}

function fakeOutputs(step) {
  return Object.fromEntries(step.produces.map((name) => [name, `${name}_${step.id}_mock`.slice(0, OUTPUT_MAX)]));
}

function finishStep(step) {
  step.status = 'done';
  step.finished_at = now();
  step.outputs = step.kind === 'think' ? { [step.produces[0] ?? 'summary']: MOCK_THINK_RESULT } : fakeOutputs(step);
}

/** Every step that depends (transitively) on a failed or skipped one is skipped. */
function skipDependents(record) {
  const blocked = new Set(record.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').map((s) => s.id));
  const next = record.steps.find((s) => s.status === 'pending' && s.after.some((id) => blocked.has(id)));
  if (!next) return;
  next.status = 'skipped';
  next.error = 'An earlier step it depends on did not finish.';
  skipDependents(record);
}

function settle(record) {
  skipDependents(record);
  if (!record.steps.every((s) => DONE.has(s.status))) return;
  const clean = record.steps.every((s) => s.status === 'done');
  record.status = clean ? 'completed' : 'completed_with_errors';
  record.finished_at = now();
  record.summary = clean ? 'Every step finished.' : 'Some steps failed or were skipped; see each step.';
}

function startStep(record, step) {
  step.started_at = now();
  if (step.id === record.askAt && step.write) {
    step.status = 'needs_approval';
    step.pending = {
      tool: step.write.tool, args: step.write.args, reason: 'The arguments differ from the approved plan.',
      fingerprint: fingerprintOf(step.write.tool, step.write.args),
    };
    record.askAt = null;
    return;
  }
  step.status = step.kind === 'wait' ? 'waiting' : 'running';
}

const ready = (record, step) => step.status === 'pending'
  && step.after.every((id) => record.steps.find((s) => s.id === id)?.status === 'done');

/** One poll's worth of progress. */
function advance(record) {
  if (TERMINAL.has(record.status)) return;
  if (record.status === 'approved') {
    record.status = 'running';
    record.started_at = now();
  }
  const active = record.steps.find((s) => s.status === 'running' || s.status === 'waiting');
  if (active) finishStep(active);
  else if (!record.steps.some((s) => s.status === 'needs_approval')) {
    const next = record.steps.find((s) => ready(record, s));
    if (next) startStep(record, next);
  }
  settle(record);
  record.updated_at = now();
}

function planErrors(body) {
  const plan = body && typeof body === 'object' ? body.plan : undefined;
  if (!plan || typeof plan !== 'object') return [{ field: 'plan', message: 'plan is required' }];
  if (plan.schema !== 'voc-plan/1') return [{ field: 'schema', message: 'must be voc-plan/1' }];
  if (typeof plan.goal !== 'string' || plan.goal.trim() === '') return [{ field: 'goal', message: 'goal is required' }];
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return [{ field: 'steps', message: 'at least one step' }];
  return [];
}

function handleCreate(req, res, send, shared) {
  shared.collectJson(req, res, (body) => {
    const errors = planErrors(body);
    if (errors.length > 0) {
      send(400, { success: false, message: 'The plan is invalid.', errors });
      return;
    }
    const record = createPlan(body.plan, typeof body.conversation_id === 'string' ? body.conversation_id : undefined);
    send(202, { plan_id: record.plan_id, status: 'approved' });
  });
}

function handleList(url, send) {
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
  const items = [...plans.values()]
    .filter((record) => !record.hidden_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(({ plan_id, status, goal, created_at, updated_at }) => ({ plan_id, status, goal, created_at, updated_at }));
  send(200, { plans: items });
}

function cancel(record) {
  if (!TERMINAL.has(record.status)) {
    record.steps.filter((s) => !DONE.has(s.status)).forEach((s) => { s.status = 'cancelled'; });
    record.status = 'cancelled';
    record.finished_at = now();
    record.updated_at = now();
  }
  return record;
}

/** DELETE: take a finished plan off the list (kept, like the real handler); 409 while it is active. */
function hide(record) {
  if (!TERMINAL.has(record.status)) return [409, { success: false, error: 'This plan is still running; cancel it first' }];
  record.hidden_at ??= now();
  record.updated_at = now();
  return [200, { plan: view(record) }];
}

function refusal(step, action, body) {
  if (step.status !== 'needs_approval') return [409, { success: false, message: 'This step does not need approval.' }];
  if (action !== 'approve') return null;
  const fingerprint = body && typeof body === 'object' ? body.fingerprint : undefined;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    return [400, { success: false, message: 'fingerprint is required: the fingerprint of the step you reviewed' }];
  }
  return fingerprint === step.pending?.fingerprint ? null : [409, { success: false, message: STEP_CHANGED }];
}

function resolveStep(record, stepId, action, body) {
  const step = record.steps.find((s) => s.id === stepId);
  if (!step) return [404, { success: false, message: 'Step not found' }];
  const refused = refusal(step, action, body);
  if (refused) return refused;
  delete step.pending;
  if (action === 'approve') step.status = 'running';
  else {
    step.status = 'failed';
    step.error = 'Declined by the approver.';
    step.finished_at = now();
  }
  settle(record);
  record.updated_at = now();
  return [200, { plan: view(record) }];
}

const STEP_ROUTE = /^\/agents\/plans\/(pl_[0-9a-f]{12})\/steps\/(s\d{1,3})\/(approve|decline)$/;
const PLAN_ROUTE = /^\/agents\/plans\/(pl_[0-9a-f]{12})(\/cancel)?$/;

function handleOne(req, res, url, send, shared) {
  const stepMatch = STEP_ROUTE.exec(url.pathname);
  const planMatch = stepMatch ? null : PLAN_ROUTE.exec(url.pathname);
  const record = plans.get((stepMatch ?? planMatch)?.[1]);
  if (!record) {
    send(404, { success: false, message: 'Plan not found' });
    return;
  }
  const wantPost = stepMatch !== null || planMatch?.[2] !== undefined;
  if (!wantPost && req.method === 'DELETE') {
    send(...hide(record));
    return;
  }
  if (req.method !== (wantPost ? 'POST' : 'GET')) {
    send(405, { success: false, message: 'Method not allowed' });
    return;
  }
  if (stepMatch) {
    shared.collectJson(req, res, (body) => {
      const [status, payload] = resolveStep(record, stepMatch[2], stepMatch[3], body);
      send(status, payload);
    });
  } else if (planMatch[2]) {
    send(200, { plan: view(cancel(record)) });
  } else {
    advance(record);
    send(200, { plan: view(record) });
  }
}

/** Handle `/agents/plans*`; returns true when the request was taken. */
export function handlePlanRoutes(req, res, url, send, shared) {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  if (url.pathname === PREFIX) {
    if (req.method === 'POST') handleCreate(req, res, send, shared);
    else if (req.method === 'GET') handleList(url, send);
    else send(405, { success: false, message: 'Method not allowed' });
    return true;
  }
  handleOne(req, res, url, send, shared);
  return true;
}

// ── Seed ─────────────────────────────────────────────────────────────────────

createPlan({
  schema: 'voc-plan/1',
  goal: 'Acme: create a research project, generate personas and a PR/FAQ',
  steps: [
    { id: 's1', pack: 'core', kind: 'write', title: 'Create the project',
      write: { tool: 'create_project', args: { name: 'Acme mobile check-in', description: '{{free}}' } }, produces: ['project_id'] },
    { id: 's2', pack: 'project', kind: 'write', after: ['s1'], title: 'Generate personas',
      write: { tool: 'generate_personas', args: { project_id: '{{s1.project_id}}', persona_count: 3 } }, produces: ['job_id'] },
    { id: 's3', pack: 'project', kind: 'wait', after: ['s2'], title: 'Wait for the personas',
      wait: { for: 'project_job', project_id: '{{s1.project_id}}', job_id: '{{s2.job_id}}' } },
    { id: 's4', pack: 'project', kind: 'write', after: ['s3'], title: 'Write the PR/FAQ',
      write: { tool: 'generate_document', args: { project_id: '{{s1.project_id}}', doc_type: 'prfaq', title: 'Mobile check-in PR/FAQ' } },
      produces: ['job_id'] },
  ],
}, undefined, 'pl_a1b2c3d4e5f6');

// A finished plan, so "Delete" shows in the list and has its own probe target.
cancel(createPlan({
  schema: 'voc-plan/1',
  goal: 'Acme: summarise last week’s delivery complaints',
  steps: [{ id: 's1', pack: 'core', kind: 'think', title: 'Summarise the complaints', think: { prompt: 'Summarise.' }, produces: ['summary'] }],
}, undefined, 'pl_f0e1d2c3b4a5'));
