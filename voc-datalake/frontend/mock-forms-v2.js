// Forms v2 mocks (7.55.00): the builder's and the widget's routes, in the shapes lambda/api/feedback_form_handler.py
// answers (docs/feedback-forms.md; the handler is the authority, src/api/feedbackFormsV2Api.ts reads it).
//
//   GET    /feedback-forms/{id}                      {form}: one form with `response_count` (only this read counts);
//                                                    v2 as stored, a v1 record as v1 with `migrated_from: 1` (the
//                                                    real API serves it migrated; the app migrates it the same way)
//   POST   /feedback-forms            (schema 2)     create, Off, revision 1, no test token yet; a rule whose op its
//                                                    question's type does not take is 400 as the server words it
//                                                    (schemas/form-logic-ops.json: a consent takes only submitted /
//                                                    skipped), on a save too
//   PUT    /feedback-forms/{id}       (schema 2, or a v2 form's {enabled})  save over `expected_write_count`
//                                                    (every save counts one, the revision moves with the definition
//                                                    only; an old client's `expected_revision` is ignored); a stale one is 409 {code:
//                                                    'revision_conflict', revision, write_count, updated_by, updated_at};
//                                                    a removed question's id (`retired_ids`) is never taken again (400
//                                                    question_id_reused); on an answered form, a question id or option
//                                                    code the save drops must be named in `removes` ({questions,
//                                                    options: {qid: codes}}), and a question it keeps keeps its type and
//                                                    range, else 409 {code: 'answers_locked', questions, options,
//                                                    changed}; with
//                                                    text under 3:1 on its background, Publish or a live form's
//                                                    colour change is 400 {code: 'theme_unreadable', palettes,
//                                                    minimum}, and another save of a live form already on that theme
//                                                    answers `warnings: ['theme_unreadable']`. Every answer carries
//                                                    the whole theme (a stored one's new fields defaulted)
//   POST   /feedback-forms/{id}/test-link            {rotate?, link_enabled?, record?} → {test: {token,…}, test_link,
//                                                    test_query}: the only answer with the token (no record has it;
//                                                    `settings.test.token_issued` says whether one was issued)
//   DELETE /feedback-forms/{id}/responses?test=true  delete the test responses (D2) → {deleted}
//   GET    /feedback-forms/{id}/results?…            per-question results (include_test, language, ending, hidden.<id>,
//                                                    from) and the funnel {opened, left: {qid: n}, completed}
//   GET    /feedback-forms/{id}/responses?…          paged responses (limit, cursor, include_test=false|true|only)
//   GET    /feedback-forms/{id}/responses?format=csv the same as CSV: layout=familiar (the default, 7.61.00: a BOM, one
//                                                    header row, `ids=true` adds the row of ids) or detailed (7.55.00's)
//   POST   /settings/form-drafts                     an AI draft: 202 {job_id}, a marker in the description or the
//                                                    instruction refuses (mock-forms-draft.js); the settings API's
//                                                    route (shared/forms_v2_draft_routes.py), served here beside the
//                                                    builder's other routes
//   GET    /settings/form-drafts/{job_id}            the draft job: {status, result, error}
//   GET    /feedback-forms/{id}/report?…             the Report (7.63.00, mock-forms-report.js), and …/compare?with=&by=
//   POST   /settings/form-reports                    the Report's AI summary: 202 {job_id}; GET …/{job_id} polls it
//   GET    /feedback-forms/{id}/config  (a v2 form)  {config, test?: {valid, record?}}: the public v2 config, and the
//                                                    test link's state when `test=<token>` is given
//   POST   /feedback-forms/{id}/submit  (a v2 form)  a v2 response (`test`: the test token); a body with `event` is
//                                                    400 submission_invalid (the beacons have their own route)
//   POST   /feedback-forms/{id}/events  (a v2 form)  a funnel beacon {event: {kind: opened | left, session,
//                                                    question_id (left), revision?}, test?}; the config read counts
//                                                    nothing (the results' funnel is the seeds' `funnel` flag)
//
// Wired by mock-forms.js handleFormRoutes, which owns the v1 routes and passes v1 requests through.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { seedResponses } from './mock-forms-seeds.js';
import { importRows } from './mock-import-wizard.js';
import { formResults, filteredResponses, headlineOf, responseView, responsesCsv } from './mock-forms-results.js';
import { draftAnswer, draftJob } from './mock-forms-draft.js';
import { familiarCsv, familiarFilename } from './mock-forms-csv.js';
import { formCompare, formReport, startSummary, summaryJob } from './mock-forms-report.js';

const ROUTE = /^\/feedback-forms\/([^/]+)(?:\/(test-link|responses|results|report|compare|config|submit|events|import))?$/;
/** A beacon's visit id and question id (lambda/shared/forms_v2_responses.py SESSION_ID, forms_v2.py QUESTION_ID). */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const QUESTION_ID = /^q_[a-z0-9_]{1,40}$/;
const EVENT_KINDS = ['opened', 'left'];
const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (status, error, extra = {}) => [status, { success: false, error, ...extra }];
const newToken = () => randomBytes(24).toString('base64url');
/** `item` without `keys` (a projection that drops the stored-only fields). */
const without = (item, keys) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
/** What the mock keeps on a form that no answer carries: the token, when it was issued, the funnel flag. */
const STORED_ONLY = ['test_token', 'test_token_issued_at', 'funnel'];
const CHANGED_MEANWHILE = 'The form was changed by someone else: reload it, then save again';

const responsesByForm = seedResponses();
const responsesOf = (formId) => responsesByForm.get(formId) ?? [];

const isV2 = (item) => item?.schema_version === 2;

/** The fields a v2 body may set (the stored meta never comes from a request). */
const V2_FIELDS = [
  'name', 'enabled', 'language', 'languages', 'welcome', 'questions', 'hidden_fields', 'endings', 'settings',
  'theme', 'category', 'subcategory', 'project_id', 'document_id', 'custom_fields', 'dimension_defaults', 'tags',
];

/** `settings.test` as the form API answers it: never the token, only whether (and when) one was issued. */
function testView(item) {
  const test = item.settings?.test ?? {};
  return {
    link_enabled: test.link_enabled === true, record: test.record === 'drop' ? 'drop' : 'tag',
    token_issued: typeof item.test_token === 'string' && item.test_token !== '',
    ...(item.test_token_issued_at ? { token_issued_at: item.test_token_issued_at } : {}),
  };
}

const realCount = (item, stats) => (isV2(item) ? responsesOf(item.form_id).filter((r) => !r.is_test).length : stats?.total_submissions ?? 0);

/** Has the form a real response (its flag, else a stored one: the handler reads the responses when unmarked)? */
const answered = (item) => item.has_responses === true || responsesOf(item.form_id).some((r) => !r.is_test);

/**
 * One stored form as the form API answers it: v2 without what only the server keeps; a v1 record as v1 (through
 * `projectV1`) marked `migrated_from: 1`. `counted`: `GET /feedback-forms/{id}`, the one read with `response_count`.
 */
function formRecord(item, shared, projectV1, counted) {
  const real = realCount(item, shared.mockFormStats[item.form_id]);
  const meta = {
    revision: item.revision ?? 1, write_count: item.write_count ?? 0, retired_ids: copy(item.retired_ids ?? []),
    has_responses: item.has_responses === true || real > 0, updated_by: item.updated_by ?? '',
    // (the dev user is an admin: it may delete test responses, as an admin or the form's creator may)
    ...(counted ? { response_count: real, can_delete_test_responses: true } : {}),
  };
  if (!isV2(item)) return { ...projectV1(item), ...meta, migrated_from: 1 };
  return { ...without(copy(item), STORED_ONLY), theme: withThemeDefaults(item.theme), settings: { test: testView(item) }, ...meta };
}

/**
 * A form's card stats as `GET /feedback-forms?include=stats` gives them (handler _RatingTally.stats): the stored
 * counts plus the card's `headline` figure, a v2 form's from its responses, a v1 record's its rating average (the
 * migrated rating question), as the handler reads both.
 */
export function listedStats(item, stats) {
  if (isV2(item)) {
    // `last_response_at` and `channels` (7.55.01): the latest real response's time, and per channel the widget said
    // (`channel`) its latest one, each absent without one (handler _RatingTally).
    const real = responsesOf(item.form_id).filter((r) => !r.is_test);
    const last = real.map((r) => r.submitted_at).sort().at(-1);
    const channels = {};
    for (const r of real) if (CHANNELS.includes(r.channel) && (channels[r.channel] ?? '') <= r.submitted_at) channels[r.channel] = r.submitted_at;
    const headline = headlineOf(item, responsesOf(item.form_id));
    return {
      ...stats, total_submissions: realCount(item, stats), headline, ...(last ? { last_response_at: last } : {}),
      ...(Object.keys(channels).length > 0 ? { channels } : {}),
    };
  }
  const rated = typeof stats.avg_rating === 'number' && stats.rating_count > 0 && item.rating_enabled !== false;
  return { ...stats, headline: rated ? { question_id: 'q_rating', type: 'rating', value: stats.avg_rating, count: stats.rating_count, scale_max: item.rating_max ?? 5 } : null };
}

/** A form as `GET /feedback-forms` lists it (mock-server.js): a v2 form without its token, a v1 record as stored. */
export function listedForm(item) {
  if (!isV2(item)) return item;
  return { ...without(copy(item), STORED_ONLY), theme: withThemeDefaults(item.theme), settings: { test: testView(item) }, revision: item.revision ?? 1,
    write_count: item.write_count ?? 0, retired_ids: copy(item.retired_ids ?? []),
    has_responses: item.has_responses === true || responsesOf(item.form_id).some((r) => !r.is_test) };
}

/**
 * The logic ops each question type takes (shared/forms_v2.py OPS_BY_TYPE, pinned by test_form_logic_ops_lockstep.py),
 * each list sorted as the server's refusal names them. A consent compares no value: `submitted` / `skipped` only.
 */
const LOGIC_OPS = JSON.parse(readFileSync(new URL('../schemas/form-logic-ops.json', import.meta.url), 'utf8')).ops_by_type;
const VALUELESS_OPS = ['submitted', 'skipped'];

/** Why the server refuses `rule` of a `type` question (forms_v2.py `_rule`: its op for the type, a value an op
 * without one was given), worded as its 400; null when it takes it. Its target is not checked here. */
function ruleError(rule, type, where) {
  if (!isPlainObject(rule)) return `${where} must be an object`;
  if (!isPlainObject(rule.when)) return `${where}.when must be an object`;
  const { op, value } = rule.when;
  const allowed = LOGIC_OPS[type];
  if (!allowed.includes(op)) return `${where}.when.op must be one of ${allowed.join(', ')} for a ${type} question`;
  return VALUELESS_OPS.includes(op) && value != null ? `${where}.when.value is not used by "${op}"` : null;
}

/** The first rule a save is refused for, in the server's words; null when there is none. */
function logicError(questions) {
  for (const [index, question] of questions.entries()) {
    if (LOGIC_OPS[question.type] === undefined || !Array.isArray(question.logic)) continue;
    for (const [n, rule] of question.logic.entries()) {
      const error = ruleError(rule, question.type, `questions[${String(index)}].logic[${String(n)}]`);
      if (error) return error;
    }
  }
  return null;
}

/** A v2 body's own problems the mock checks (the real validator checks the whole contract). */
function v2BodyError(body) {
  if (!Array.isArray(body.questions) || body.questions.length === 0) return 'questions must hold 1 to 30 questions';
  if (body.questions.length > 30) return 'questions must hold 1 to 30 questions';
  if (!Array.isArray(body.endings) || body.endings.length === 0) return 'endings must hold 1 to 5 endings';
  const bad = body.questions.find((q) => !isPlainObject(q) || !/^q_[a-z0-9_]{1,40}$/.test(q.id ?? ''));
  if (bad !== undefined) return `questions[${String(body.questions.indexOf(bad))}].id must match ^q_[a-z0-9_]{1,40}$`;
  return logicError(body.questions);
}

// ── The theme (lambda/shared/form_theme.py: the same schema, defaults and publish rule) ──────────────────────────

const THEME_COLOURS = ['primary_color', 'background_color', 'text_color'];
const THEME_CHOICES = { mode: ['light', 'dark', 'auto'], font: ['system', 'inherit', 'serif', 'rounded', 'mono'], text_size: ['default', 'large'] };
const THEME_FIELDS = [...THEME_COLOURS, 'border_radius', 'dark', ...Object.keys(THEME_CHOICES)];
/** `#rgb`, `#rrggbb`, or an old form's `#rrggbbaa`; the dark palette (new in 7.55.01) has no alpha. */
const STORED_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PALETTE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RADIUS = /^\d{1,2}px$/;
/** How the widget that sent a response runs (forms_v2_responses.py CHANNELS): the list card's channels. */
const CHANNELS = ['link', 'iframe', 'script'];
const VOC_LIGHT = { primary_color: '#8e48ff', background_color: '#ffffff', text_color: '#19161d' };
const VOC_DARK = { primary_color: '#bd8fff', background_color: '#19161d', text_color: '#f2f1f4' };
const defaultTheme = () => ({ ...VOC_LIGHT, border_radius: '8px', mode: 'light', dark: { ...VOC_DARK }, font: 'system', text_size: 'default' });

/** Why a body's `theme` is refused (form_theme.py `check_theme`), or null. */
function themeError(theme, where = 'theme') {
  if (!isPlainObject(theme)) return `${where} must be an object`;
  const unknown = Object.keys(theme).filter((key) => !THEME_FIELDS.includes(key)).sort();
  if (unknown.length > 0) return `${where} has unknown fields: ${unknown.slice(0, 5).join(', ')}`;
  const colour = (value, pattern) => value === undefined || value === null || (typeof value === 'string' && pattern.test(value));
  const badColour = THEME_COLOURS.find((field) => !colour(theme[field], STORED_HEX));
  if (badColour) return `${where}.${badColour} must be a hex colour such as #8e48ff`;
  if (!(theme.border_radius == null || (typeof theme.border_radius === 'string' && RADIUS.test(theme.border_radius)))) {
    return `${where}.border_radius must be a pixel value such as 8px`;
  }
  const badChoice = Object.keys(THEME_CHOICES).find((field) => theme[field] != null && !THEME_CHOICES[field].includes(theme[field]));
  if (badChoice) return `${where}.${badChoice} must be one of: ${THEME_CHOICES[badChoice].join(', ')}`;
  if (theme.dark == null) return null;
  if (!isPlainObject(theme.dark)) return `${where}.dark must be an object`;
  const extra = Object.keys(theme.dark).filter((key) => !THEME_COLOURS.includes(key)).sort();
  if (extra.length > 0) return `${where}.dark has unknown fields: ${extra.join(', ')}`;
  const badDark = THEME_COLOURS.find((field) => !colour(theme.dark[field], PALETTE_HEX));
  return badDark ? `${where}.dark.${badDark} must be a hex colour such as #8e48ff` : null;
}

/** `stored`'s colours that match `pattern`, over `into` (a missing or unusable one keeps its default). */
function keepColours(into, stored, pattern) {
  for (const field of THEME_COLOURS) if (typeof stored[field] === 'string' && pattern.test(stored[field])) into[field] = stored[field];
}

/** The theme as the API reads it (form_theme.py `with_defaults`): every field, a missing or unusable one its default. */
function withThemeDefaults(theme) {
  const stored = isPlainObject(theme) ? theme : {};
  const out = defaultTheme();
  keepColours(out, stored, STORED_HEX);
  if (typeof stored.border_radius === 'string' && RADIUS.test(stored.border_radius)) out.border_radius = stored.border_radius;
  for (const [field, allowed] of Object.entries(THEME_CHOICES)) if (allowed.includes(stored[field])) out[field] = stored[field];
  if (isPlainObject(stored.dark)) keepColours(out.dark, stored.dark, PALETTE_HEX);
  return out;
}

/** A hex colour's 0–1 channels as the widget draws it (an old `#rrggbbaa` opaque, its alpha dropped). */
function channels(hex) {
  const digits = hex.length === 4 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1);
  const at = (i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4)];
}
const luminance = (rgb) => rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

/** The WCAG contrast of `text` on `background` (form_theme.py `contrast_ratio`: the colours the widget draws). */
function contrast(text, background) {
  const [hi, lo] = [luminance(channels(text)), luminance(channels(background))].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Each palette respondents can be shown whose text is under 3:1 (shared/forms_v2.py `theme_publish_problems`). */
function unreadablePalettes(theme) {
  const full = withThemeDefaults(theme);
  const light = { text_color: full.text_color, background_color: full.background_color };
  const shown = { light: [['light', light]], dark: [['dark', full.dark]], auto: [['light', light], ['dark', full.dark]] }[full.mode];
  return shown.map(([palette, colours]) => ({ palette, ratio: Math.round(contrast(colours.text_color, colours.background_color) * 100) / 100 }))
    .filter((found) => found.ratio < 3);
}

/**
 * A brand PUT's `form_theme`, the workspace's form brand (settings_handler.py `_form_theme_of`): `{ theme }` (stored
 * whole, or null to remove it) or `{ error }`; undefined when the body names none. The brand mocks share it.
 */
export function brandFormTheme(body) {
  if (!isPlainObject(body) || !('form_theme' in body)) return undefined;
  if (body.form_theme === null) return { theme: null };
  const error = themeError(body.form_theme, 'form_theme');
  return error ? { error } : { theme: withThemeDefaults(body.form_theme) };
}

/** Do two themes draw the same form (each read with its defaults: forms_v2.py `same_theme`)? */
const sameTheme = (a, b) => JSON.stringify(withThemeDefaults(a)) === JSON.stringify(withThemeDefaults(b));

/**
 * The publish rule of a save that ends `live` with text under 3:1 (`validate_publishable`): `{refusal}`, its 400,
 * when it turns the form live or changes a live form's theme; `{warnings: ['theme_unreadable']}` for another save of
 * a live form already on that theme; `{}` for anything else.
 */
function publishCheck(theme, { live, wasLive, themeChanged }) {
  if (!live) return {};
  const problems = unreadablePalettes(theme);
  if (problems.length === 0) return {};
  if (wasLive && !themeChanged) return { warnings: ['theme_unreadable'] };
  const [first] = problems;
  return { refusal: fail(400, `The text on the ${first.palette} background is ${first.ratio.toFixed(1)}:1, under 3:1: respondents could not read it. `
    + 'Choose a text or background colour with more contrast to publish the form.', { code: 'theme_unreadable', palettes: problems, minimum: 3 }) };
}

/** `settings` from a save: only `test.link_enabled` and `test.record` (the token is the test-link route's). */
function savedSettings(item, settings) {
  const test = isPlainObject(settings?.test) ? settings.test : {};
  const current = item.settings?.test ?? { link_enabled: false, record: 'tag' };
  return { test: {
    link_enabled: typeof test.link_enabled === 'boolean' ? test.link_enabled : current.link_enabled === true,
    record: test.record === 'drop' || test.record === 'tag' ? test.record : current.record ?? 'tag',
  } };
}

function createV2(shared, body, projectV1) {
  const error = v2BodyError(body) ?? (body.theme === undefined ? null : themeError(body.theme));
  if (error) return fail(400, error);
  const now = new Date().toISOString();
  const item = { form_id: `fd_${randomBytes(16).toString('hex')}`, schema_version: 2, revision: 1, write_count: 0,
    retired_ids: [], updated_by: 'admin@example.com', created_at: now, updated_at: now };
  for (const field of V2_FIELDS) if (body[field] !== undefined) item[field] = copy(body[field]);
  item.settings = savedSettings(item, body.settings);
  item.enabled = false; // a create is always Off
  // The survey export it was made from (7.67.00, the import wizard): kept once; the form stays off, with no public link.
  if (isPlainObject(body.imported)) item.imported = copy(body.imported);
  shared.mockFeedbackForms.unshift(item);
  shared.mockFormStats[item.form_id] = { total_submissions: 0, avg_rating: null, rating_count: 0 };
  return [200, { success: true, form: formRecord(item, shared, projectV1, false) }];
}

function staleError(item) {
  return fail(409, CHANGED_MEANWHILE, {
    code: 'revision_conflict', revision: item.revision ?? 1, write_count: item.write_count ?? 0, updated_by: item.updated_by ?? '',
    updated_at: item.updated_at ?? '',
  });
}

/** What a question's answers mean (forms_v2.py `answer_shape`): its type and, for a rating, its range. */
const shapeOf = (question) => `${String(question?.type)}:${question?.type === 'rating' ? String(question.range ?? 5) : ''}`;

/** The questions a save keeps from an answered form with another type or range (`reshaped_questions`). */
function reshaped(item, body) {
  if (!answered(item) || !Array.isArray(body.questions) || !Array.isArray(item.questions)) return [];
  const next = new Map(body.questions.filter(isPlainObject).map((question) => [question.id, question]));
  return item.questions.filter((question) => next.has(question.id) && shapeOf(question) !== shapeOf(next.get(question.id)))
    .map((question) => question.id);
}

/** The fields a change of which is a new revision (forms_v2.py DEFINITION_FIELDS). */
const DEFINITION_FIELDS = ['language', 'languages', 'welcome', 'questions', 'hidden_fields', 'endings'];
const changesDefinition = (item, body) => DEFINITION_FIELDS.some((field) => body[field] !== undefined
  && JSON.stringify(body[field]) !== JSON.stringify(item[field]));

const optionCodes = (question) => (Array.isArray(question?.options) ? question.options.map((option) => option?.code) : []);

/**
 * What a save of an answered form drops without naming it in `removes` (the handler's `answers_locked`): the stored
 * question ids it leaves out, and the option codes it leaves out of a question it keeps. `{}` when nothing is.
 */
function unnamedRemovals(item, body) {
  if (!answered(item) || !Array.isArray(body.questions) || !Array.isArray(item.questions)) return {};
  const named = isPlainObject(body.removes) ? body.removes : {};
  const namedQuestions = Array.isArray(named.questions) ? named.questions : [];
  const namedOptions = isPlainObject(named.options) ? named.options : {};
  const next = new Map(body.questions.filter(isPlainObject).map((question) => [question.id, question]));
  const questions = item.questions.map((question) => question.id)
    .filter((id) => !next.has(id) && !namedQuestions.includes(id));
  const options = {};
  for (const question of item.questions) {
    if (!next.has(question.id)) continue;
    const kept = optionCodes(next.get(question.id));
    const allowed = Array.isArray(namedOptions[question.id]) ? namedOptions[question.id] : [];
    const dropped = optionCodes(question).filter((code) => !kept.includes(code) && !allowed.includes(code));
    if (dropped.length > 0) options[question.id] = dropped;
  }
  return questions.length > 0 || Object.keys(options).length > 0 ? { questions, options } : {};
}

/** A stale save (`expected_write_count` other than the stored one), or null; an old client's `expected_revision` is
 * ignored (7.58.01: the count moves with every save, a definition's among them). */
function staleSave(item, body) {
  const staleCount = body.expected_write_count !== undefined && body.expected_write_count !== (item.write_count ?? 0);
  return staleCount ? staleError(item) : null;
}

/** A 400 of the body itself (its shape, its theme, a retired question id taken again), or null. */
function invalidSave(item, body) {
  const error = (body.schema_version === 2 ? v2BodyError(body) : null) ?? (body.theme === undefined ? null : themeError(body.theme));
  if (error) return fail(400, error);
  const reused = Array.isArray(body.questions)
    ? body.questions.find((question) => (item.retired_ids ?? []).includes(question?.id)) : undefined;
  return reused === undefined ? null : fail(400, `questions: the id "${String(reused.id)}" belonged to a removed question; ids are never reused`, {
    code: 'question_id_reused', question_id: reused.id,
  });
}

/** The lock of an answered form: a 409 for an unnamed removal or a question given another type or range, or null. */
function lockedSave(item, body) {
  const unnamed = unnamedRemovals(item, body);
  const changed = reshaped(item, body);
  if (unnamed.questions === undefined && changed.length === 0) return null;
  return fail(409, 'This form has responses: name each question or option it removes in `removes`, and keep each question\'s type and range', {
    code: 'answers_locked', ...unnamed, ...(changed.length > 0 ? { changed } : {}),
  });
}

/** Write `fields` of `body` on `item`: one save more, a new revision when the definition changed (its dropped ids retired). */
function applySave(item, body, fields) {
  const newRevision = changesDefinition(item, body);
  if (newRevision && Array.isArray(body.questions)) {
    const kept = new Set(body.questions.map((question) => question?.id));
    item.retired_ids = [...(item.retired_ids ?? []), ...(item.questions ?? []).map((question) => question.id).filter((id) => !kept.has(id))];
  }
  for (const field of fields) item[field] = field === 'settings' ? savedSettings(item, body.settings) : copy(body[field]);
  item.schema_version = 2;
  item.revision = (item.revision ?? 1) + (newRevision ? 1 : 0);
  item.write_count = (item.write_count ?? 0) + 1;
  item.updated_at = new Date().toISOString();
  item.updated_by = 'admin@example.com';
}

/**
 * A v2 save (or a v2 form's partial `{enabled}`): over `expected_write_count` when given;
 * counts one more save, and a new revision when the definition changed (its dropped question ids retired).
 */
function updateV2(shared, item, body, projectV1) {
  const refused = staleSave(item, body) ?? invalidSave(item, body) ?? lockedSave(item, body);
  if (refused) return refused;
  // Publish and a live form's colour change keep readable text; a form that stays (or goes) Off is always saved.
  const { refusal, warnings } = publishCheck(body.theme ?? item.theme, {
    live: body.enabled ?? (item.enabled === true), wasLive: item.enabled === true,
    themeChanged: body.theme !== undefined && !sameTheme(body.theme, item.theme),
  });
  if (refusal) return refusal;
  const fields = V2_FIELDS.filter((field) => body[field] !== undefined);
  if (fields.length === 0) return fail(400, 'No fields to update');
  applySave(item, body, fields);
  return [200, { success: true, form: formRecord(item, shared, projectV1, false), ...(warnings ? { warnings } : {}) }];
}

/** A page of the form's responses as the responses route answers it (`cursor`: the previous page's `next_cursor`). */
function pageOf(item, url, rows) {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? String(PAGE_DEFAULT), 10) || PAGE_DEFAULT, 1), PAGE_MAX);
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (!/^\d{1,7}$/.test(cursor)) return fail(400, 'cursor must be the next_cursor of the previous page');
  const offset = Number.parseInt(cursor, 10);
  return [200, {
    success: true, form_id: item.form_id, revision: item.revision ?? 1, total: rows.length,
    responses: rows.slice(offset, offset + limit).map(responseView),
    next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
  }];
}

/** Is `token` the form's test token, while its test link is on? */
const validTestLink = (item, token) => item.settings?.test?.link_enabled === true && typeof item.test_token === 'string'
  && item.test_token !== '' && token === item.test_token;

/** A question as the public config serves it: an option's category is routing, never published. */
const publicQuestion = (question) => (Array.isArray(question.options)
  ? { ...question, options: question.options.map((option) => without(option, ['category'])) } : question);

/** The public config of a v2 form (item_to_widget_config), and the test link's state beside it when given a token. */
function v2Config(item, url) {
  const config = {
    enabled: item.enabled === true, schema_version: 2, revision: item.revision ?? 1,
    language: item.language ?? 'en', languages: copy(item.languages ?? [item.language ?? 'en']),
    welcome: copy(item.welcome ?? { enabled: false }), questions: (item.questions ?? []).map((q) => publicQuestion(copy(q))),
    hidden_fields: (item.hidden_fields ?? []).map((field) => ({ id: field.id })), endings: copy(item.endings ?? []),
    language_assumed: false, theme: withThemeDefaults(item.theme),
  };
  const token = url.searchParams.get('test');
  if (token === null || token === '') return [200, { success: true, config }];
  const test = validTestLink(item, token) ? { valid: true, record: item.settings.test.record === 'drop' ? 'drop' : 'tag' } : { valid: false };
  return [200, { success: true, config, test }];
}

/** The title of the ending reached, in the respondent's language (else the primary's). */
function endingMessage(item, endingId, language) {
  const endings = item.endings ?? [];
  const ending = endings.find((candidate) => candidate.id === endingId) ?? endings[0] ?? {};
  const title = ending.title ?? {};
  return title[language] || title[item.language] || 'Thank you for your feedback!';
}

/** The test link a submission came through: its record mode (null: none), or the 403 of a token that is not valid. */
function testModeOf(item, body) {
  const token = typeof body.test === 'string' && body.test !== '' ? body.test : null;
  if (token === null) return { mode: null };
  if (!validTestLink(item, token)) return { refused: fail(403, 'This test link is not valid', { code: 'test_link_invalid' }) };
  return { mode: item.settings.test.record === 'drop' ? 'drop' : 'tag' };
}

/** Keep a checked response (a test one with the form, `is_test`) and answer as the submit route does. */
function storeResponse(item, body, mode, done) {
  const id = mode === 'tag' ? randomBytes(16).toString('hex') : `fb_${randomBytes(8).toString('hex')}`;
  const row = {
    response_id: id, ...(mode === null ? { feedback_id: id } : {}), submitted_at: new Date().toISOString(),
    form_revision: body.form_revision ?? item.revision ?? 1, language: done.language, answers: copy(body.answers),
    hidden: isPlainObject(body.hidden) ? copy(body.hidden) : {}, ending_id: done.ending_id ?? '',
    is_test: mode !== null, shown: Object.keys(body.answers), sentiment: null,
    ...(CHANNELS.includes(body.channel) ? { channel: body.channel } : {}),
  };
  responsesByForm.set(item.form_id, [row, ...responsesOf(item.form_id)]);
  const answer = { success: true, message: done.message, ...(done.ending_id ? { ending_id: done.ending_id } : {}) };
  if (mode === 'tag') return [200, { ...answer, test: 'tag', response_id: id }];
  item.has_responses = true;
  return [200, { ...answer, feedback_id: id }];
}

/** Why a beacon's body is malformed (the handler's `_validated_event`), or null. */
function eventBodyError(body) {
  if (Object.keys(body).some((key) => key !== 'event' && key !== 'test')) return 'an event carries only event and test';
  const event = body.event;
  if (!isPlainObject(event) || !EVENT_KINDS.includes(event.kind)) return 'event.kind must be opened or left';
  if (typeof event.session !== 'string' || !SESSION_ID.test(event.session)) {
    return 'event.session must be 8 to 64 letters, digits, _ or -';
  }
  if (event.kind === 'left' && !QUESTION_ID.test(String(event.question_id ?? ''))) {
    return 'a left event names the question_id the respondent left at';
  }
  // The handler's `_EVENT_FIELDS`: an `opened` names no question, and neither kind carries another field.
  const allowed = event.kind === 'left' ? ['kind', 'question_id', 'session', 'revision'] : ['kind', 'session', 'revision'];
  if (Object.keys(event).some((key) => !allowed.includes(key))) return `a ${event.kind} event carries only ${allowed.join(', ')}`;
  if (event.revision !== undefined && !(Number.isInteger(event.revision) && event.revision >= 1)) {
    return 'event.revision must be a whole number from 1';
  }
  return null;
}

/**
 * A funnel beacon on its own route (D6: `opened` once per page load, `left` once per visit that did not submit):
 * counts only, never an answer; through the test link (`test`: its token) also on a form that is Off.
 */
function v2Event(item, body) {
  const error = eventBodyError(body);
  if (error) return fail(400, error, { code: 'submission_invalid' });
  const { mode, refused } = testModeOf(item, body);
  if (refused) return refused;
  if (!item.enabled && mode === null) return fail(400, 'This form is not enabled', { code: 'form_off' });
  return [200, { success: true, ...(mode ? { test: mode } : {}) }];
}

/** A v2 response; through the test link (`test`: its token) also on a form that is Off. Never a beacon. */
function v2Submit(item, body) {
  if (body.event !== undefined) {
    return fail(400, 'The funnel\'s events go to …/events, not the submit route', { code: 'submission_invalid' });
  }
  const { mode, refused } = testModeOf(item, body);
  if (refused) return refused;
  if (!item.enabled && mode === null) return fail(400, 'This form is not enabled', { code: 'form_off' });
  if (!isPlainObject(body.answers)) return fail(400, 'answers must be an object', { code: 'submission_invalid' });
  if (body.channel != null && !CHANNELS.includes(body.channel)) {
    return fail(400, `channel must be one of: ${CHANNELS.join(', ')}`, { code: 'submission_invalid' });
  }
  if (Number.isInteger(body.form_revision) && body.form_revision > (item.revision ?? 1)) {
    return fail(409, 'This form has changed since it was opened: reload it and answer again', { code: 'form_changed' });
  }
  const language = typeof body.language === 'string' ? body.language : item.language;
  const endingId = body.ending_id ?? item.endings?.[0]?.id ?? null;
  const done = { language, ending_id: endingId, message: endingMessage(item, endingId, language) };
  if (mode === 'drop') return [200, { success: true, message: done.message, ...(endingId ? { ending_id: endingId } : {}), test: 'drop' }];
  return storeResponse(item, body, mode, done);
}

/** `include_test` as the results (false | true) and the responses (also only) take it. */
function includeTestError(url, allowOnly) {
  const value = (url.searchParams.get('include_test') ?? 'false').toLowerCase();
  const allowed = allowOnly ? ['false', 'true', 'only'] : ['false', 'true'];
  return allowed.includes(value) ? null : fail(400, `include_test must be one of: ${allowed.join(', ')}`);
}

function readRoute(shared, op, item, url, projectV1) {
  switch (op) {
    case 'get': return [200, { success: true, form: formRecord(item, shared, projectV1, true) }];
    case 'results': return includeTestError(url, false)
      ?? [200, { success: true, form_id: item.form_id, revision: item.revision ?? 1, include_test: url.searchParams.get('include_test') === 'true',
        ...formResults(item, responsesOf(item.form_id), url.searchParams) }];
    case 'responses': return includeTestError(url, true) ?? pageOf(item, url, filteredResponses(responsesOf(item.form_id), url.searchParams));
    case 'report': return includeTestError(url, false)
      ?? formReport(item, filteredResponses(responsesOf(item.form_id), url.searchParams), responsesOf(item.form_id), url.searchParams);
    case 'compare': return includeTestError(url, false)
      ?? formCompare(item, shared.mockFeedbackForms, (formId) => filteredResponses(responsesOf(formId), url.searchParams), url.searchParams);
    case 'config': return v2Config(item, url);
    default: return null;
  }
}

/** POST …/test-link: issue (or `rotate`) the token and set `link_enabled` (on by default) / `record`. */
function testLink(item, body) {
  if (body.rotate !== undefined && typeof body.rotate !== 'boolean') return fail(400, 'rotate must be true or false');
  if (!item.test_token || body.rotate === true) {
    item.test_token = newToken();
    item.test_token_issued_at = new Date().toISOString();
  }
  const current = item.settings?.test ?? { link_enabled: false, record: 'tag' };
  const test = {
    link_enabled: typeof body.link_enabled === 'boolean' ? body.link_enabled : true,
    record: body.record === 'drop' || body.record === 'tag' ? body.record : current.record ?? 'tag',
  };
  item.settings = { ...(item.settings ?? {}), test };
  const query = `test=${item.test_token}`;
  return [200, { success: true, form_id: item.form_id, test: { ...test, token: item.test_token, token_issued_at: item.test_token_issued_at },
    test_query: query, test_link: `/feedback-forms/${item.form_id}/iframe?${query}` }];
}

function deleteTest(item, url) {
  if (url.searchParams.get('test') !== 'true') return fail(400, 'Only test responses can be deleted here: send ?test=true');
  const all = responsesOf(item.form_id);
  const kept = all.filter((row) => !row.is_test);
  responsesByForm.set(item.form_id, kept);
  return [200, { success: true, form_id: item.form_id, deleted: all.length - kept.length }];
}

/** The AI draft's routes: the settings API's (POST to start, GET `/{job_id}` to poll); the Report's AI summary's too. */
const DRAFTS_ROUTE = '/settings/form-drafts';
const SUMMARIES_ROUTE = '/settings/form-reports';

/** The settings API's two assist routes these mocks serve (an AI draft, a report's AI summary), each a POST to
 * start and a GET of `/{job_id}` to poll: the op, null for another method, undefined for another path. */
function classifyAssist(method, pathname) {
  for (const [route, start, poll] of [[DRAFTS_ROUTE, 'draft', 'draftJob'], [SUMMARIES_ROUTE, 'summary', 'summaryJob']]) {
    if (pathname === route) return method === 'POST' ? { op: start } : null;
    if (pathname.startsWith(`${route}/`)) return method === 'GET' ? { op: poll, jobId: decodeURIComponent(pathname.slice(route.length + 1)) } : null;
  }
  return undefined;
}

/** Which v2 route this is: an op and the form it is about, or null (a v1 route, or none of ours). */
function classify(method, pathname, shared) {
  const assist = classifyAssist(method, pathname);
  if (assist !== undefined) return assist;
  if (pathname === '/feedback-forms') return method === 'POST' ? { op: 'create' } : null;
  const match = pathname.match(ROUTE);
  if (!match) return null;
  const item = shared.mockFeedbackForms.find((form) => form.form_id === decodeURIComponent(match[1])) ?? null;
  const ops = {
    '': { GET: 'get', PUT: 'update' }, 'test-link': { POST: 'testLink' }, responses: { DELETE: 'deleteTest', GET: 'responses' },
    results: { GET: 'results' }, report: { GET: 'report' }, compare: { GET: 'compare' }, config: { GET: 'config' },
    submit: { POST: 'submit' }, events: { POST: 'event' }, import: { POST: 'importRows' },
  };
  const op = ops[match[2] ?? '']?.[method];
  if (op === undefined) return null;
  // An imported form has no public link: its public routes answer as for an unknown id.
  if ((op === 'config' || op === 'submit' || op === 'event') && item?.imported) return { op, item: null, formId: match[1] };
  // The widget's config and submit stay v1's for a v1 form (whose widget sends no beacon).
  if ((op === 'config' || op === 'submit' || op === 'event') && !isV2(item)) return null;
  return { op, item, formId: match[1] };
}

/** A CSV request's layout and ids parameters checked (the handler's 400s), or the refusal. */
function csvChoiceError(url) {
  const layout = url.searchParams.get('layout') ?? 'familiar';
  const ids = url.searchParams.get('ids') ?? 'false';
  if (layout !== 'familiar' && layout !== 'detailed') return fail(400, 'layout must be one of: familiar, detailed');
  if (ids !== 'true' && ids !== 'false') return fail(400, 'ids must be true or false');
  return null;
}

function sendCsv(res, item, url) {
  const rows = filteredResponses(responsesOf(item.form_id), url.searchParams);
  const detailed = url.searchParams.get('layout') === 'detailed';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const filename = detailed ? `${item.form_id}-responses.csv` : familiarFilename(item);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.writeHead(200);
  res.end(detailed ? responsesCsv(item, rows) : familiarCsv(item, rows, url.searchParams.get('ids') === 'true'));
}

/** The writes: their body is read first. */
function writeRoute(shared, route, url, body, projectV1) {
  const input = isPlainObject(body) ? body : {};
  if (route.op === 'draft') return draftAnswer(input);
  if (route.op === 'summary') return startSummary(shared.mockFeedbackForms, input);
  if (route.op === 'create') return createV2(shared, input, projectV1);
  if (route.op === 'update' && route.item.imported && input.enabled === true) {
    return fail(409, 'An imported form stays off: it has no public link', { code: 'imported_form' });
  }
  if (route.op === 'update') return updateV2(shared, route.item, input, projectV1);
  if (route.op === 'importRows') {
    return importRows(route.item, input, (rows) => responsesByForm.set(route.item.form_id, [...rows, ...responsesOf(route.item.form_id)]));
  }
  if (route.op === 'submit') return v2Submit(route.item, input);
  if (route.op === 'event') return v2Event(route.item, input);
  if (route.op === 'testLink') return testLink(route.item, input);
  return fail(405, 'Not mocked');
}

/**
 * Handle a v2 read; true when taken, false when the request is none of ours, null when it is a write whose body
 * decides (mock-forms.js reads it, then calls handleFormV2Write). `projectV1` is mock-forms.js's item_to_form.
 */
export function handleFormV2Routes(req, res, url, send, shared, projectV1) {
  const route = classify(req.method, url.pathname, shared);
  if (route === null) return false;
  if (route.op === 'draftJob' || route.op === 'summaryJob') {
    send(...(route.op === 'draftJob' ? draftJob(route.jobId) : summaryJob(route.jobId)));
    return true;
  }
  if (route.op !== 'create' && route.op !== 'draft' && route.op !== 'summary' && route.item === null) {
    send(404, { success: false, error: 'Form not found' });
    return true;
  }
  if (route.op === 'responses' && url.searchParams.get('format') === 'csv') {
    const refused = includeTestError(url, true) ?? csvChoiceError(url);
    if (refused) send(...refused);
    else sendCsv(res, route.item, url);
    return true;
  }
  if (route.op === 'deleteTest') {
    send(...deleteTest(route.item, url));
    return true;
  }
  const read = readRoute(shared, route.op, route.item, url, projectV1);
  if (read !== null) {
    send(...read);
    return true;
  }
  return null;
}

/**
 * A write whose body is read: a v2 create / save, an AI draft, or a v2 response. False when it is a v1 request
 * (a body without schema_version 2 to a v1 form or to the list), which mock-forms.js then handles as before.
 */
export function handleFormV2Write(req, url, shared, body, projectV1) {
  const route = classify(req.method, url.pathname, shared);
  if (route === null) return false;
  const v2Body = isPlainObject(body) && body.schema_version === 2;
  if (route.op === 'create' && !v2Body) return false;
  if (route.op === 'importRows') return writeRoute(shared, route, url, body, projectV1);
  if (route.op === 'update' && !v2Body && !isV2(route.item)) return false;
  return writeRoute(shared, route, url, body, projectV1);
}
