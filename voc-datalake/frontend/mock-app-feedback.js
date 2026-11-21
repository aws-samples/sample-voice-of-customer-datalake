// In-app micro-feedback mock (7.66.00): GET|PUT /settings/app-feedback in the lambda/shared/app_feedback_routes.py
// wire shape ({enabled, form_id, actions, updated_at, tag, form, active}; 400 {success: false, error, code,
// problems?} and 404 {success: false, error} as the real route answers). A PUT changes only the fields it names.
// Stateful for the life of the mock process; the mock caller is an admin, so the real route's 403 is not reproduced.
// It seeds one form made from the In-app micro-feedback template (fv2_app_feedback, Live, tagged voc_app) into the
// shared forms; the control posts its responses to that form's submit route, which mock-forms-v2.js serves.
// Off by default, as the real setting: start with MOCK_APP_FEEDBACK=on to open with it on and that form chosen.
// Wired into mock-server.js by handleDomainModules.

const ROUTE = '/settings/app-feedback';
// ACTIONS, HIDDEN_FIELDS and the problems in lambda/shared/app_feedback.py.
const ACTIONS = ['personas', 'research', 'prfaq', 'prd', 'prototype', 'form_draft', 'import', 'engineering_run'];
const HIDDEN_FIELDS = ['action', 'page', 'app_version', 'workspace_role'];
const BLOCKING = ['not_tagged', 'no_verdict', 'no_missing', 'hidden_fields'];
const FORM_ID = /^(?!\.{1,2}$)[0-9A-Za-z_.-]{1,64}$/;
const FIELDS = ['enabled', 'form_id', 'actions'];

const SEED_ID = 'fv2_app_feedback';
const SEED = {
  form_id: SEED_ID, schema_version: 2, revision: 1, name: 'In-app micro-feedback', enabled: true,
  language: 'en', languages: ['en'], welcome: { enabled: false, title: {} },
  questions: [
    { id: 'q_verdict', type: 'single_select', required: true, display: 'chips', shuffle: 'none', headline: { en: 'Was this useful?' },
      options: [{ code: 'up', label: { en: 'Yes' } }, { code: 'down', label: { en: 'No' } }], other: { enabled: false }, none: { enabled: false } },
    { id: 'q_missing', type: 'open_text', required: false, long: true, input_type: 'text', max_chars: 500, headline: { en: "What's missing?" } },
  ],
  hidden_fields: HIDDEN_FIELDS.map((id) => ({ id })),
  endings: [{ id: 'end_thanks', title: { en: 'Thank you' } }],
  tags: ['voc_app'], template: { id: 'app_micro_feedback', version: 1 },
  created_at: '2026-11-20T09:00:00+00:00', updated_at: '2026-11-20T09:00:00+00:00',
};

const on = process.env.MOCK_APP_FEEDBACK === 'on';
const settings = { enabled: on, form_id: on ? SEED_ID : null, actions: [...ACTIONS], updated_at: null };

function seeded(shared) {
  if (!shared.mockFeedbackForms.some((form) => form.form_id === SEED_ID)) shared.mockFeedbackForms.push({ ...SEED });
  return shared.mockFeedbackForms;
}

/** form_problems: what keeps a form from receiving the control's responses. */
function problems(form) {
  const found = [];
  const tags = (form.tags ?? []).map((tag) => String(tag).trim().toLowerCase());
  if (!tags.includes('voc_app')) found.push('not_tagged');
  const question = (id) => (form.questions ?? []).find((q) => q.id === id);
  const verdict = question('q_verdict');
  const codes = (verdict?.options ?? []).map((option) => option.code);
  if (verdict?.type !== 'single_select' || !codes.includes('up') || !codes.includes('down')) found.push('no_verdict');
  if (question('q_missing')?.type !== 'open_text') found.push('no_missing');
  const declared = (form.hidden_fields ?? []).map((field) => field.id);
  if (!HIDDEN_FIELDS.every((id) => declared.includes(id))) found.push('hidden_fields');
  if (form.enabled !== true) found.push('form_off');
  return found;
}

function view(forms) {
  const form = settings.form_id === null ? undefined : forms.find((candidate) => candidate.form_id === settings.form_id);
  const formView = settings.form_id === null ? null : form === undefined
    ? { form_id: settings.form_id, found: false, name: null, enabled: false, languages: [], problems: [] }
    : { form_id: form.form_id, found: true, name: form.name, enabled: form.enabled === true,
      languages: form.languages ?? [form.language ?? 'en'], problems: problems(form) };
  return { ...settings, tag: 'voc_app', form: formView,
    active: settings.enabled && formView !== null && formView.found && formView.problems.length === 0 };
}

/** The real validate_changes + merged_config refusals, else the merged settings. */
function merged(body, forms) {
  const given = body && typeof body === 'object' ? Object.keys(body) : [];
  const unknown = given.filter((key) => !FIELDS.includes(key)).sort((a, b) => a.localeCompare(b));
  if (unknown.length > 0) return [400, { success: false, error: `Unknown field(s): ${unknown.join(', ')}` }];
  if (given.length === 0) return [400, { success: false, error: `Give at least one of: ${FIELDS.join(', ')}` }];
  if ('enabled' in body && typeof body.enabled !== 'boolean') return [400, { success: false, error: 'enabled must be true or false' }];
  if ('form_id' in body && body.form_id !== null && !(typeof body.form_id === 'string' && FORM_ID.test(body.form_id))) {
    return [400, { success: false, error: 'form_id must be a feedback form id, or null' }];
  }
  if ('actions' in body && !(Array.isArray(body.actions) && body.actions.length > 0
      && body.actions.every((action) => ACTIONS.includes(action)) && new Set(body.actions).size === body.actions.length)) {
    return [400, { success: false, error: `actions must list at least one of: ${ACTIONS.join(', ')}, each once` }];
  }
  const next = { ...settings, ...body };
  if (next.enabled && next.form_id === null) {
    return [400, { success: false, code: 'app_feedback_form_required',
      error: 'Choose the feedback form that receives the micro-feedback before turning it on' }];
  }
  if (next.form_id !== null && ('form_id' in body || next.enabled)) {
    const form = forms.find((candidate) => candidate.form_id === next.form_id);
    if (form === undefined) return [404, { success: false, error: 'Feedback form not found' }];
    const blocking = problems(form).filter((problem) => BLOCKING.includes(problem));
    if (blocking.length > 0) {
      return [400, { success: false, code: 'app_feedback_form_unfit', problems: blocking,
        error: "This form can't receive the in-app feedback: make it from the In-app micro-feedback template" }];
    }
  }
  return [200, { ...next, actions: ACTIONS.filter((action) => next.actions.includes(action)) }];
}

/** Handle `/settings/app-feedback`; returns true when the request was taken. */
export function handleAppFeedbackRoutes(req, res, url, send, shared) {
  if (url.pathname !== ROUTE) return false;
  const forms = seeded(shared);
  if (req.method === 'GET') {
    send(200, view(forms));
    return true;
  }
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const [status, result] = merged(body, forms);
    if (status !== 200) {
      send(status, result);
      return;
    }
    Object.assign(settings, result, { updated_at: new Date().toISOString() });
    send(200, view(forms));
  });
  return true;
}
