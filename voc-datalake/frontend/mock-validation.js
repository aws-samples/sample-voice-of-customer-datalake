// Dev-mock routes of the Validate step (7.68.00, docs/project-workspace.md → Validate), in the wire shape of
// lambda/shared/project_validation_routes.py:
//
//   GET  /projects/{id}/validation            -> {validation, form, synthetic, real, criteria, tasks, decision_prefill,
//                                                 methodology}
//   PUT  /projects/{id}/validation/criteria   {criteria, expected_revision?}       -> {success, validation}
//   POST /projects/{id}/validation/criteria   {replace?}                           -> 202 assist job -> {validation}
//   POST /projects/{id}/validation/plan       {mode}  ai: 202 job -> {document_id, validation}; blank: 201 {document}
//   POST /projects/{id}/validation/synthetic  {}                                   -> 202 job -> {document_id, ...}
//   PUT  /projects/{id}/validation/form       {tasks, open, language?}             -> {success, validation, form}
//   POST /projects/{id}/validation/report     {}                                   -> 202 job -> {document_id, ...}
//
// Stateful for the life of the mock process. Once the card is open the project has five real answers (a stable
// mock beats fake traffic); a synthetic run rates every criterion 5 and still counts towards nothing.

import { randomBytes } from 'node:crypto';

const ROUTE = /^\/projects\/([^/]+)\/validation(?:\/(criteria|plan|synthetic|form|report))?$/;
const MOCK_FORM_ID = 'pf_0123456789abcdef';
const MOCK_ANSWERS = 5;
const DEFAULT_TARGET = 4;
const states = new Map(); // project id -> { block, run }

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}${randomBytes(3).toString('hex')}`;

function stateOf(projectId) {
  if (!states.has(projectId)) states.set(projectId, { block: { criteria: [], tasks: [], revision: 0 }, run: null });
  return states.get(projectId);
}

function write(state, changes, reason, shared) {
  state.block = { ...state.block, ...changes, revision: state.block.revision + 1, updated_at: nowIso(),
    updated_by: { sub: shared.mockCaller.sub, kind: 'user' }, reason };
  return state.block;
}

function withIds(entries, prefix) {
  return entries.map((entry) => ({ ...entry, id: entry.id ?? newId(prefix), text: String(entry.text ?? '').trim() }));
}

function realFigures(state) {
  if (!state.block.form_open) return null;
  const criteria = Object.fromEntries(state.block.criteria.map((c, i) => [c.id, { n: MOCK_ANSWERS, average: i === 0 ? 4.4 : 3.6 }]));
  const tasks = Object.fromEntries(state.block.tasks.map((t) => [t.id, { n: MOCK_ANSWERS, yes: 4, no: 1, rate: 0.8 }]));
  return { responses: MOCK_ANSWERS, last_response_at: nowIso(), ces: { n: MOCK_ANSWERS, average: 5.4, score: 80 },
    missing: [{ text: 'A way to download the invoice as PDF (mock)', at: nowIso(), response_id: '1' }], criteria, tasks };
}

function criteriaResults(state, real) {
  return state.block.criteria.map((criterion) => {
    const target = criterion.target ?? DEFAULT_TARGET;
    const own = real?.criteria[criterion.id] ?? { n: 0, average: null };
    const judged = own.average >= target ? 'met' : 'not_met';
    const outcome = own.n < MOCK_ANSWERS || own.average === null ? 'not_enough_data' : judged;
    const synthetic = state.run ? { synthetic: true, n: state.run.personas, average: 5, reading: 'likely_met' } : null;
    return { id: criterion.id, text: criterion.text, target, target_set: criterion.target !== undefined, real: own, outcome, synthetic };
  });
}

function taskResults(state, real) {
  return state.block.tasks.map((task) => ({
    id: task.id, text: task.text, real: real?.tasks[task.id] ?? { n: 0, yes: 0, no: 0, rate: null },
    synthetic: state.run ? { synthetic: true, completed: state.run.personas, struggled: 0, failed: 0, n: state.run.personas } : null,
  }));
}

function view(detail, state) {
  const real = realFigures(state);
  const criteria = criteriaResults(state, real);
  const verdict = criteria.length > 0 && criteria.every((c) => c.outcome === 'met') ? 'pursue' : 'park';
  const form = state.block.form_id ? { form_id: state.block.form_id, revision: 2, open: Boolean(state.block.form_open),
    questions: state.block.tasks.length + state.block.criteria.length + 2, has_responses: Boolean(real), stale: false,
    newer_version: null } : null;
  const hasPrototype = detail.documents.some((d) => d.document_type === 'prototype');
  return [200, {
    success: true, validation: state.block, form,
    synthetic: state.run ? { synthetic: true, document_id: state.run.document_id, created_at: state.run.created_at, personas: state.run.personas } : null,
    real: real ? { responses: real.responses, last_response_at: real.last_response_at, ces: real.ces, missing: real.missing } : null,
    criteria, tasks: taskResults(state, real),
    decision_prefill: criteria.length === 0 ? null : {
      title: `Decision after validating ${detail.project.name}`, verdict, rationale: `Validation with ${real?.responses ?? 0} real tester response(s). Synthetic persona runs are not counted.`,
      success_metric: criteria.map((c) => `${c.text} (target ${c.target} of 5)`).join('; '),
      evidence: { document_ids: state.block.report_document_id ? [state.block.report_document_id] : [], feedback_ids: real ? ['1'] : [] },
    },
    methodology: { step: 'validation', skipped: hasPrototype ? [] : [{ step: 'prototype', reason: 'missing' }],
      warnings: hasPrototype ? [] : [{ code: 'missing_upstream', step: 'prototype', message: 'This validation is made without a prototype: the project has none yet.' }],
      evidence: null },
  }];
}

function addDocument(detail, documentType, title, extra = {}) {
  const document = { document_id: newId('doc_'), document_type: documentType, title, content: `# ${title}\n`,
    section: 'documents', created_at: nowIso(), updated_at: nowIso(), ...extra };
  detail.documents.push(document);
  return document;
}

const needsCriteria = (state) => (state.block.criteria.length === 0 ? [400, { success: false, error: 'Set the success criteria first' }] : null);

const ACTIONS = {
  'PUT criteria': (ctx) => {
    if (!Array.isArray(ctx.body.criteria) || ctx.body.criteria.length === 0) return [400, { success: false, error: 'criteria must be a list of 1 to 10 entries' }];
    if (Number.isInteger(ctx.body.expected_revision) && ctx.body.expected_revision !== ctx.state.block.revision) {
      return [409, { success: false, error: 'The validation changed since you opened it. Reload it and try again.', code: 'validation_changed' }];
    }
    return [200, { success: true, validation: write(ctx.state, { criteria: withIds(ctx.body.criteria, 'c') }, 'criteria_edited', ctx.shared) }];
  },
  'POST criteria': (ctx) => {
    if (ctx.state.block.criteria.length > 0 && ctx.body.replace !== true) {
      return [409, { success: false, error: 'This project already has success criteria', code: 'criteria_exist' }];
    }
    const criteria = withIds([{ text: 'Customers learn about a delay before they ask (mock)' }, { text: 'Tracking a delivery is quick (mock)' }], 'c');
    const validation = write(ctx.state, { criteria, prd_document_id: 'prd_1' }, 'criteria_extracted', ctx.shared);
    return ctx.shared.startProjectAssistJob(ctx.projectId, 'assist_validation_criteria', [200, { validation }]);
  },
  'POST plan': (ctx) => {
    const refused = needsCriteria(ctx.state);
    if (refused) return refused;
    const origin = ctx.body.mode === 'blank' ? 'human' : 'ai';
    const document = addDocument(ctx.detail, 'validation_plan', `Validation plan: ${ctx.detail.project.name}`, { origin });
    const tasks = ctx.state.block.tasks.length > 0 ? {} : { tasks: withIds([{ text: 'Find out when your order arrives (mock)' }], 't') };
    const validation = write(ctx.state, { plan_document_id: document.document_id, ...tasks }, 'plan_written', ctx.shared);
    if (origin === 'human') return [201, { success: true, document, methodology: view(ctx.detail, ctx.state)[1].methodology }];
    return ctx.shared.startProjectAssistJob(ctx.projectId, 'assist_validation_plan', [200, { document_id: document.document_id, validation }]);
  },
  'POST synthetic': (ctx) => {
    if (ctx.state.block.tasks.length === 0) return [400, { success: false, error: 'Save the tasks testers try first (from the plan, or your own)' }];
    const document = addDocument(ctx.detail, 'validation_run', 'Synthetic validation run', { synthetic: true });
    ctx.state.run = { document_id: document.document_id, created_at: document.created_at, personas: Math.min(ctx.detail.personas.length, 6) };
    const validation = write(ctx.state, { run_document_id: document.document_id }, 'synthetic_run', ctx.shared);
    return ctx.shared.startProjectAssistJob(ctx.projectId, 'assist_validation_synthetic',
      [200, { document_id: document.document_id, synthetic: true, personas: ctx.state.run.personas, validation }]);
  },
  'PUT form': (ctx) => {
    const refused = needsCriteria(ctx.state);
    if (refused) return refused;
    if (!Array.isArray(ctx.body.tasks) || ctx.body.tasks.length === 0 || typeof ctx.body.open !== 'boolean') {
      return [400, { success: false, error: 'tasks must be a list of 1 to 8 entries, and open true or false' }];
    }
    const validation = write(ctx.state, { tasks: withIds(ctx.body.tasks, 't'), form_id: MOCK_FORM_ID, form_open: ctx.body.open,
      form_language: ctx.body.language ?? 'en', prototype_document_id: 'prototype_mock', card_in_prototype: true }, 'form_saved', ctx.shared);
    return [200, { success: true, validation, form: view(ctx.detail, ctx.state)[1].form }];
  },
  'POST report': (ctx) => {
    const refused = needsCriteria(ctx.state);
    if (refused) return refused;
    const document = addDocument(ctx.detail, 'validation_report', `Validation report: ${ctx.detail.project.name}`);
    const validation = write(ctx.state, { report_document_id: document.document_id }, 'report_written', ctx.shared);
    return ctx.shared.startProjectAssistJob(ctx.projectId, 'assist_validation_report',
      [200, { document_id: document.document_id, validation, decision_prefill: view(ctx.detail, ctx.state)[1].decision_prefill }]);
  },
};

/** Handle the Validate step's routes; returns true when the request was taken. */
export function handleValidationRoutes(req, res, url, send, shared) {
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  const [, rawId, action] = match;
  const projectId = decodeURIComponent(rawId);
  const detail = shared.mockProjectDetails[projectId];
  if (!detail) {
    send(404, { success: false, error: 'Project not found' });
    return true;
  }
  const state = stateOf(projectId);
  if (action === undefined) {
    if (req.method !== 'GET') return false;
    send(...view(detail, state));
    return true;
  }
  const handler = ACTIONS[`${req.method} ${action}`];
  if (!handler) return false;
  shared.collectJson(req, res, (body) => {
    send(...handler({ projectId, detail, state, shared, body: body ?? {} }));
  });
  return true;
}
