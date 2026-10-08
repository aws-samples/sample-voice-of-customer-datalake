// Feedback form mocks: single-form CRUD, the submissions view and the three
// PUBLIC widget routes (config, submit, iframe), in the
// lambda/api/feedback_form_handler.py wire shapes (item_to_form /
// item_to_widget_config projections, {success: false, error} on 4xx).
// Stateful for the life of the mock process: create/update/delete mutate
// shared.mockFeedbackForms in place, and a submit bumps shared.mockFormStats so
// the existing GET /feedback-forms/{id}/stats route reflects it.
//
// Deliberately NOT claimed here (they live in mock-server.js):
// GET /feedback-forms (list) and GET /feedback-forms/{id}/stats.
//
// Two mock-only liberties, both called out where they happen:
// - PUT on an unknown form answers 404 (the real update_item has no condition,
//   so it would upsert a nameless stub).
// - A `pf_<16 hex>` id with no stored record resolves to a synthetic
//   prototype_pin form, so the prototype pin bridge works against mock
//   prototypes that carry a pin widget but have no stored form.
// Wired into mock-server.js by handleDomainModules.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FORM_ROUTE = /^\/feedback-forms\/([^/]+)(?:\/(submissions|config|submit|iframe))?$/;
const PIN_FORM_ID = /^pf_[0-9a-f]{16}$/;
const LINK_FIELD_MAX_LENGTH = 128;
const PIN_MAX_BODY_BYTES = 24_000;
const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

// DEFAULT_THEME in the handler (Kiro Light palette, E2E F6).
const DEFAULT_THEME = {
  primary_color: '#8e48ff', background_color: '#ffffff', text_color: '#19161d', border_radius: '8px',
};
// DEFAULT_FORM_CONFIG in the handler: also the create allowlist.
const DEFAULT_FORM_CONFIG = {
  name: 'New Feedback Form', enabled: false, title: 'Share Your Feedback',
  description: 'We value your opinion.', question: 'How was your experience?',
  placeholder: 'Tell us about your experience...', rating_enabled: true, rating_type: 'stars',
  rating_max: 5, submit_button_text: 'Submit Feedback', success_message: 'Thank you for your feedback!',
  theme: DEFAULT_THEME, collect_email: false, collect_name: false, custom_fields: [],
  category: '', subcategory: '', project_id: '', document_id: '',
  // KVD contract: stamped on every submission (the widget's `dimensions` option wins per key).
  dimension_defaults: {}, tags: [],
};
// UPDATABLE_FIELDS in the handler (brand_name is fixed for the life of a form).
const UPDATABLE_FIELDS = [
  'name', 'enabled', 'title', 'description', 'question', 'placeholder',
  'rating_enabled', 'rating_type', 'rating_max', 'submit_button_text',
  'success_message', 'theme', 'collect_email', 'collect_name',
  'custom_fields', 'category', 'subcategory', 'project_id', 'document_id',
  'dimension_defaults', 'tags',
];

const fail = (status, error) => [status, { success: false, error }];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
/** structuredClone for JSON values, so stored records never share references with a request body. */
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const pick = (item, key, fallback) => (own(item, key) && item[key] !== undefined ? item[key] : fallback);

// ── Submissions store (stands in for the feedback table's form_<id> rows) ───
// Stored rows are what the feedback table holds; the route projects them the
// way get_form_submissions does. sub_legacy is deliberately sparse (written
// before enrichment fields existed): it projects to '' / null / 0 on the wire,
// exercising the empty-date, no-rating and no-sentiment render paths.
const submissionsByForm = new Map([
  ['form_1', [
    { feedback_id: 'fsub_1a', original_text: 'The new search bar is great, found what I needed in seconds.', rating: 5,
      sentiment_label: 'positive', sentiment_score: 0.91, category: 'website', source_created_at: daysAgo(0.2),
      persona_name: 'Efficient Shopper' },
    { feedback_id: 'fsub_1b', original_text: 'Product pages load slowly on my phone.', rating: 3,
      sentiment_label: 'negative', sentiment_score: -0.42, category: 'website', source_created_at: daysAgo(1.5),
      persona_name: 'Mobile-First Browser' },
    { feedback_id: 'sub_legacy', original_text: 'Nice site.' },
  ]],
  ['form_2', [
    { feedback_id: 'fsub_2a', original_text: 'Arrived a day late and the box was damaged.', rating: 2,
      sentiment_label: 'negative', sentiment_score: -0.78, category: 'delivery', source_created_at: daysAgo(0.5),
      persona_name: 'Time-Sensitive Buyer' },
    { feedback_id: 'fsub_2b', original_text: 'Smooth purchase, tracking updates were helpful.', rating: 5,
      sentiment_label: 'positive', sentiment_score: 0.84, category: 'delivery', source_created_at: daysAgo(3),
      persona_name: '' },
  ]],
  ['form_4', [
    { feedback_id: 'fsub_4a', original_text: 'Checkout was quick, loved the saved card option.', rating: 5,
      sentiment_label: 'positive', sentiment_score: 0.88, category: 'checkout', source_created_at: daysAgo(2),
      persona_name: 'Loyal Customer' },
  ]],
  ['form_5', [
    { feedback_id: 'fsub_5a', original_text: 'I would use this weekly if it synced with my calendar.',
      sentiment_label: 'mixed', sentiment_score: 0.12, category: '', source_created_at: daysAgo(4),
      persona_name: 'Power Planner' },
  ]],
]);
const pinsByForm = new Map(); // form_id -> stored pins (not read back by the mock pins route)

const ratingOf = (value) => {
  if (value === null || value === undefined || value === '' || value === 0 || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** One feedback row as get_form_submissions renders it. */
const projectSubmission = (item) => ({
  feedback_id: pick(item, 'feedback_id', ''),
  original_text: pick(item, 'original_text', ''),
  rating: ratingOf(item.rating),
  sentiment_label: pick(item, 'sentiment_label', ''),
  sentiment_score: Number(pick(item, 'sentiment_score', 0)) || 0,
  category: pick(item, 'category', ''),
  created_at: pick(item, 'source_created_at', ''),
  persona_name: pick(item, 'persona_name', ''),
});

/** _RatingTally.stats over a list of projected submissions. */
function tally(submissions) {
  const rated = submissions.filter((s) => s.rating !== null);
  const total = rated.reduce((sum, s) => sum + s.rating, 0);
  return {
    total_submissions: submissions.length,
    avg_rating: rated.length ? Math.round((total / rated.length) * 100) / 100 : null,
    rating_count: rated.length,
  };
}

/** Python int() over a query value, then validate_limit's clamp into [1, 100]; default 50. */
function parseLimit(raw) {
  if (raw === null || !/^\s*[+-]?\d+\s*$/.test(raw)) return 50;
  return Math.min(Math.max(Number.parseInt(raw, 10), 1), 100);
}

// ── Projections ─────────────────────────────────────────────────────────────

/** int(item.get('rating_max', 5)), with 5 for anything int() could not read. */
const ratingMaxOf = (item) => Math.trunc(Number(pick(item, 'rating_max', 5))) || 5;

/** item_to_form: every field present, defaulted the way the handler defaults it. */
const itemToForm = (item) => ({
  form_id: pick(item, 'form_id', ''), name: pick(item, 'name', ''), enabled: pick(item, 'enabled', false),
  title: pick(item, 'title', ''), description: pick(item, 'description', ''),
  question: pick(item, 'question', ''), placeholder: pick(item, 'placeholder', ''),
  rating_enabled: pick(item, 'rating_enabled', true), rating_type: pick(item, 'rating_type', 'stars'),
  rating_max: ratingMaxOf(item),
  submit_button_text: pick(item, 'submit_button_text', ''), success_message: pick(item, 'success_message', ''),
  theme: copy(pick(item, 'theme', {})), collect_email: pick(item, 'collect_email', false),
  collect_name: pick(item, 'collect_name', false), custom_fields: copy(pick(item, 'custom_fields', [])),
  category: pick(item, 'category', ''), subcategory: pick(item, 'subcategory', ''),
  project_id: pick(item, 'project_id', ''), document_id: pick(item, 'document_id', ''),
  dimension_defaults: copy(pick(item, 'dimension_defaults', {})), tags: copy(pick(item, 'tags', [])),
  form_type: item.form_type || 'standard', brand_name: pick(item, 'brand_name', ''),
  created_at: pick(item, 'created_at', ''), updated_at: pick(item, 'updated_at', ''),
});

/** item_to_widget_config: the PUBLIC allowlist — no ids, no links, no category. */
const itemToWidgetConfig = (item) => ({
  enabled: pick(item, 'enabled', false), title: pick(item, 'title', ''),
  description: pick(item, 'description', ''), question: pick(item, 'question', ''),
  placeholder: pick(item, 'placeholder', ''), rating_enabled: pick(item, 'rating_enabled', true),
  rating_type: pick(item, 'rating_type', 'stars'),
  rating_max: ratingMaxOf(item),
  submit_button_text: pick(item, 'submit_button_text', ''), success_message: pick(item, 'success_message', ''),
  theme: copy(pick(item, 'theme', {})), collect_email: pick(item, 'collect_email', false),
  collect_name: pick(item, 'collect_name', false), custom_fields: copy(pick(item, 'custom_fields', [])),
  brand_name: pick(item, 'brand_name', ''),
});

// ── Form lookup ─────────────────────────────────────────────────────────────

const syntheticPinForms = new Map();

/** shared/prototype_pins.pin_form_item, for a pf_ id the mock has no record of. */
function syntheticPinForm(formId) {
  if (!syntheticPinForms.has(formId)) {
    const now = new Date().toISOString();
    syntheticPinForms.set(formId, {
      form_id: formId, form_type: 'prototype_pin', name: 'Pins: Mock prototype', enabled: true,
      title: 'Prototype feedback', description: 'Click an element of the prototype and tell us what you think.',
      question: 'What should change here?', placeholder: 'Describe what you expected or what is confusing...',
      rating_enabled: false, rating_type: 'stars', rating_max: 5, submit_button_text: 'Send',
      success_message: 'Thanks — your pin was saved.', theme: {}, collect_email: false, collect_name: false,
      custom_fields: [], category: '', subcategory: '', project_id: 'proj_1', document_id: '',
      brand_name: '', created_at: now, updated_at: now,
    });
  }
  return syntheticPinForms.get(formId);
}

function findForm(shared, formId) {
  const stored = shared.mockFeedbackForms.find((f) => f.form_id === formId);
  if (stored) return stored;
  return PIN_FORM_ID.test(formId) ? syntheticPinForm(formId) : null; // mock-only, see header
}

// ── Validation (validate_link_fields) ───────────────────────────────────────

function linkFieldError(body) {
  for (const field of ['project_id', 'document_id']) {
    if (!own(body, field)) continue;
    if (typeof body[field] !== 'string') return `${field} must be a string`;
    if (body[field].length > LINK_FIELD_MAX_LENGTH) {
      return `${field} must be at most ${LINK_FIELD_MAX_LENGTH} characters`;
    }
  }
  return null;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function getForm(shared, formId) {
  const form = shared.mockFeedbackForms.find((f) => f.form_id === formId);
  return form ? [200, { success: true, form: itemToForm(form) }] : fail(404, 'Form not found');
}

function createForm(shared, body) {
  const input = body ?? {};
  if (!isPlainObject(input)) return fail(400, 'Request body must be a JSON object');
  const linkError = linkFieldError(input);
  if (linkError) return fail(400, linkError);
  const now = new Date().toISOString();
  // str(uuid.uuid4())[:8] in build_form_item.
  const item = { form_id: randomUUID().slice(0, 8), brand_name: '', created_at: now, updated_at: now };
  for (const [field, fallback] of Object.entries(DEFAULT_FORM_CONFIG)) {
    item[field] = copy(own(input, field) ? input[field] : fallback);
  }
  shared.mockFeedbackForms.unshift(item); // the real list sorts newest first
  shared.mockFormStats[item.form_id] = { total_submissions: 0, avg_rating: null, rating_count: 0 };
  return [200, { success: true, form: itemToForm(item) }];
}

function updateForm(shared, formId, body) {
  const input = body ?? {};
  if (!isPlainObject(input)) return fail(400, 'Request body must be a JSON object');
  const linkError = linkFieldError(input);
  if (linkError) return fail(400, linkError);
  const fields = UPDATABLE_FIELDS.filter((field) => own(input, field));
  if (fields.length === 0) return fail(400, 'No fields to update');
  const form = shared.mockFeedbackForms.find((f) => f.form_id === formId);
  if (!form) return fail(404, 'Form not found'); // mock-only: the real update upserts
  for (const field of fields) form[field] = copy(input[field]);
  form.updated_at = new Date().toISOString();
  return [200, { success: true, form: itemToForm(form) }];
}

function deleteForm(shared, formId) {
  // Idempotent like the real delete_item: an unknown id is still a 200.
  const index = shared.mockFeedbackForms.findIndex((f) => f.form_id === formId);
  if (index !== -1) shared.mockFeedbackForms.splice(index, 1);
  // Its stats now 404 (the real stats route loads the form first). Stored
  // submissions survive, as feedback rows do.
  delete shared.mockFormStats[formId];
  return [200, { success: true }];
}

function listSubmissions(shared, formId, url) {
  if (!findForm(shared, formId)) return fail(404, 'Form not found');
  const limit = parseLimit(url.searchParams.get('limit'));
  const rows = [...(submissionsByForm.get(formId) ?? [])]
    .sort((a, b) => String(b.source_created_at ?? '').localeCompare(String(a.source_created_at ?? '')))
    .slice(0, limit)
    .map(projectSubmission);
  // Like the handler, stats here count only the rows this page returned.
  return [200, { success: true, form_id: formId, stats: tally(rows), submissions: rows }];
}

// ── Public widget routes ────────────────────────────────────────────────────

function widgetConfig(shared, formId) {
  const form = findForm(shared, formId);
  if (!form) return fail(404, 'Form not found');
  // A disabled form still answers 200; the widget reads enabled: false and
  // renders "Feedback form unavailable."
  return [200, { success: true, config: itemToWidgetConfig(form) }];
}

function bumpStats(shared, formId, rating) {
  const stats = shared.mockFormStats[formId] ?? { total_submissions: 0, avg_rating: null, rating_count: 0 };
  stats.total_submissions += 1;
  if (rating !== null) {
    const total = (stats.avg_rating ?? 0) * stats.rating_count + rating;
    stats.rating_count += 1;
    stats.avg_rating = Math.round((total / stats.rating_count) * 100) / 100;
  }
  shared.mockFormStats[formId] = stats;
}

/** _submit_prototype_pin: stored as a pin, never counted as customer feedback. */
function submitPin(form, body, text) {
  if (Buffer.byteLength(JSON.stringify(body)) > PIN_MAX_BODY_BYTES) return fail(400, 'The pin is too large');
  if (!isPlainObject(body.pin)) return fail(400, 'pin must be an object');
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17).padEnd(20, '0');
  const pinId = `pin_${stamp}${randomBytes(3).toString('hex')}`;
  const pins = pinsByForm.get(form.form_id) ?? [];
  pins.push({ pin_id: pinId, comment: text.slice(0, 2000), status: 'open', created_at: new Date().toISOString() });
  pinsByForm.set(form.form_id, pins);
  return [200, { success: true, pin_id: pinId, message: form.success_message || 'Thanks — your pin was saved.' }];
}

function submitFeedback(shared, formId, body) {
  const input = isPlainObject(body) ? body : {};
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return fail(400, 'Feedback text is required');
  const form = findForm(shared, formId);
  if (!form) return fail(404, 'Form not found');
  if (!form.enabled) return fail(400, 'This form is not enabled');
  if (form.form_type === 'prototype_pin') return submitPin(form, input, text);

  const rating = ratingOf(input.rating);
  const feedbackId = randomUUID();
  const rows = submissionsByForm.get(formId) ?? [];
  // Enrichment is async in the real pipeline; the row lands unprocessed.
  rows.push({
    feedback_id: feedbackId, original_text: text, rating, sentiment_label: '', sentiment_score: 0,
    category: form.category || '', source_created_at: new Date().toISOString(), persona_name: '',
  });
  submissionsByForm.set(formId, rows);
  bumpStats(shared, formId, rating);
  return [200, { success: true, feedback_id: feedbackId, message: form.success_message || 'Thank you for your feedback!' }];
}

// ── Iframe page (get_form_iframe) ───────────────────────────────────────────

const FALLBACK_WIDGET_JS = `(function() {
  window.VoCFeedbackForm = { init: function(options) {
    var container = document.querySelector(options.container);
    if (container) container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Widget loading error.</p>';
  } };
})();`;
let widgetJsCache = null;

/** The real widget script from the Lambda's static folder, read once. */
function widgetJs() {
  if (widgetJsCache === null) {
    try {
      widgetJsCache = readFileSync(new URL('../lambda/api/static/feedback-widget.js', import.meta.url), 'utf8');
    } catch {
      widgetJsCache = FALLBACK_WIDGET_JS;
    }
  }
  return widgetJsCache;
}

/** A JS string literal that is also safe inside an HTML <script> element. */
const scriptString = (value) => JSON.stringify(String(value))
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function iframeHtml(req, formId) {
  const host = /^[A-Za-z0-9.-]+(?::\d+)?$/.test(req.headers.host ?? '') ? req.headers.host : 'localhost:3001';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback Form</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
    #voc-feedback-form { min-height: 100vh; }
  </style>
</head>
<body>
  <main id="voc-feedback-form"></main>
  <script>
  ${widgetJs()}
  VoCFeedbackForm.init({
    container: '#voc-feedback-form',
    apiEndpoint: ${scriptString(`http://${host}`)},
    formId: ${scriptString(formId)},
    configEndpoint: ${scriptString(`/feedback-forms/${encodeURIComponent(formId)}/config`)},
    submitEndpoint: ${scriptString(`/feedback-forms/${encodeURIComponent(formId)}/submit`)}
  });
  </script>
</body>
</html>`;
}

// ── Router ──────────────────────────────────────────────────────────────────

/** Which owned route this request is, or null when it belongs to another handler. */
function classify(method, pathname) {
  if (pathname === '/feedback-forms') return method === 'POST' ? { op: 'create' } : null;
  const match = pathname.match(FORM_ROUTE);
  if (!match) return null;
  let formId;
  try {
    formId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const ops = {
    '': { GET: 'get', PUT: 'update', DELETE: 'delete' },
    submissions: { GET: 'submissions' }, config: { GET: 'config' },
    submit: { POST: 'submit' }, iframe: { GET: 'iframe' },
  };
  const op = ops[match[2] ?? ''][method];
  return op ? { op, formId } : null;
}

/** Handle the single-form, submissions and public widget routes; true when taken. */
export function handleFormRoutes(req, res, url, send, shared) {
  const route = classify(req.method, url.pathname);
  if (!route) return false;
  const { op, formId } = route;
  if (op === 'iframe') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200); // the real route renders for any id; the widget then 404s on config
    res.end(iframeHtml(req, formId));
    return true;
  }
  const readers = {
    get: () => getForm(shared, formId),
    delete: () => deleteForm(shared, formId),
    submissions: () => listSubmissions(shared, formId, url),
    config: () => widgetConfig(shared, formId),
  };
  if (own(readers, op)) {
    const [status, payload] = readers[op]();
    send(status, payload);
    return true;
  }
  const writers = {
    create: (body) => createForm(shared, body),
    update: (body) => updateForm(shared, formId, body),
    submit: (body) => submitFeedback(shared, formId, body),
  };
  shared.collectJson(req, res, (body) => {
    const [status, payload] = writers[op](body);
    send(status, payload);
  });
  return true;
}
