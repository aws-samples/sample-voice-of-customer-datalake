// Forms v2 mocks (7.55.00): the builder's and the widget's routes, in the shapes lambda/api/feedback_form_handler.py
// answers (docs/feedback-forms.md; the handler is the authority, src/api/feedbackFormsV2Api.ts reads it).
//
//   GET    /feedback-forms/{id}                      {form}: one form with `response_count` (only this read counts);
//                                                    v2 as stored, a v1 record as v1 with `migrated_from: 1` (the
//                                                    real API serves it migrated; the app migrates it the same way)
//   POST   /feedback-forms            (schema 2)     create, Off, revision 1, no test token yet
//   PUT    /feedback-forms/{id}       (schema 2, or a v2 form's {enabled})  save over `expected_revision`; a stale one
//                                                    is 409 {code: 'revision_conflict', revision, updated_by, updated_at};
//                                                    on an answered form, a question id or option code the save drops
//                                                    must be named in `removes` ({questions, options: {qid: codes}}),
//                                                    else 409 {code: 'answers_locked', questions, options}
//   POST   /feedback-forms/{id}/test-link            {rotate?, link_enabled?, record?} → {test: {token,…}, test_link,
//                                                    test_query}: the only answer with the token (no record has it;
//                                                    `settings.test.token_issued` says whether one was issued)
//   DELETE /feedback-forms/{id}/responses?test=true  delete the test responses (D2) → {deleted}
//   GET    /feedback-forms/{id}/results?…            per-question results (include_test, language, ending, hidden.<id>,
//                                                    from) and the funnel {opened, left: {qid: n}, completed}
//   GET    /feedback-forms/{id}/responses?…          paged responses (limit, cursor, include_test=false|true|only)
//   GET    /feedback-forms/{id}/responses?format=csv the same as CSV
//   POST   /settings/form-drafts                     an AI draft: 202 {job_id}, a marker in the description or the
//                                                    instruction refuses (mock-forms-draft.js); the settings API's
//                                                    route (shared/forms_v2_draft_routes.py), served here beside the
//                                                    builder's other routes
//   GET    /settings/form-drafts/{job_id}            the draft job: {status, result, error}
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
import { seedResponses } from './mock-forms-seeds.js';
import { formResults, filteredResponses, responseView, responsesCsv } from './mock-forms-results.js';
import { draftAnswer, draftJob } from './mock-forms-draft.js';

const ROUTE = /^\/feedback-forms\/([^/]+)(?:\/(test-link|responses|results|config|submit|events))?$/;
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

/**
 * One stored form as the form API answers it: v2 without what only the server keeps; a v1 record as v1 (through
 * `projectV1`) marked `migrated_from: 1`. `counted`: `GET /feedback-forms/{id}`, the one read with `response_count`.
 */
function formRecord(item, shared, projectV1, counted) {
  const real = realCount(item, shared.mockFormStats[item.form_id]);
  const meta = {
    revision: item.revision ?? 1, has_responses: item.has_responses === true || real > 0, updated_by: item.updated_by ?? '',
    // (the dev user is an admin: it may delete test responses, as an admin or the form's creator may)
    ...(counted ? { response_count: real, can_delete_test_responses: true } : {}),
  };
  if (!isV2(item)) return { ...projectV1(item), ...meta, migrated_from: 1 };
  return { ...without(copy(item), STORED_ONLY), settings: { test: testView(item) }, ...meta };
}

/** A form as `GET /feedback-forms` lists it (mock-server.js): a v2 form without its token, a v1 record as stored. */
export function listedForm(item) {
  if (!isV2(item)) return item;
  return { ...without(copy(item), STORED_ONLY), settings: { test: testView(item) }, revision: item.revision ?? 1,
    has_responses: item.has_responses === true || responsesOf(item.form_id).some((r) => !r.is_test) };
}

/** A v2 body's own problems the mock checks (the real validator checks the whole contract). */
function v2BodyError(body) {
  if (!Array.isArray(body.questions) || body.questions.length === 0) return 'questions must hold 1 to 30 questions';
  if (body.questions.length > 30) return 'questions must hold 1 to 30 questions';
  if (!Array.isArray(body.endings) || body.endings.length === 0) return 'endings must hold 1 to 5 endings';
  const bad = body.questions.find((q) => !isPlainObject(q) || !/^q_[a-z0-9_]{1,40}$/.test(q.id ?? ''));
  return bad === undefined ? null : `questions[${String(body.questions.indexOf(bad))}].id must match ^q_[a-z0-9_]{1,40}$`;
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
  const error = v2BodyError(body);
  if (error) return fail(400, error);
  const now = new Date().toISOString();
  const item = { form_id: `fd_${randomBytes(16).toString('hex')}`, schema_version: 2, revision: 1,
    updated_by: 'admin@example.com', created_at: now, updated_at: now };
  for (const field of V2_FIELDS) if (body[field] !== undefined) item[field] = copy(body[field]);
  item.settings = savedSettings(item, body.settings);
  item.enabled = false; // a create is always Off
  shared.mockFeedbackForms.unshift(item);
  shared.mockFormStats[item.form_id] = { total_submissions: 0, avg_rating: null, rating_count: 0 };
  return [200, { success: true, form: formRecord(item, shared, projectV1, false) }];
}

function staleError(item) {
  return fail(409, CHANGED_MEANWHILE, {
    code: 'revision_conflict', revision: item.revision ?? 1, updated_by: item.updated_by ?? '', updated_at: item.updated_at ?? '',
  });
}

const optionCodes = (question) => (Array.isArray(question?.options) ? question.options.map((option) => option?.code) : []);

/**
 * What a save of an answered form drops without naming it in `removes` (the handler's `answers_locked`): the stored
 * question ids it leaves out, and the option codes it leaves out of a question it keeps. `{}` when nothing is.
 */
function unnamedRemovals(item, body) {
  if (item.has_responses !== true || !Array.isArray(body.questions) || !Array.isArray(item.questions)) return {};
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

/** A v2 save (or a v2 form's partial `{enabled}`): over `expected_revision` when given; bumps the revision. */
function updateV2(shared, item, body, projectV1) {
  const expected = body.expected_revision;
  if (expected !== undefined && expected !== (item.revision ?? 1)) return staleError(item);
  if (body.schema_version === 2) {
    const error = v2BodyError(body);
    if (error) return fail(400, error);
  }
  const unnamed = unnamedRemovals(item, body);
  if (unnamed.questions !== undefined) {
    return fail(409, 'This form has responses: name each question or option it removes in `removes`', {
      code: 'answers_locked', ...unnamed,
    });
  }
  const fields = V2_FIELDS.filter((field) => body[field] !== undefined);
  if (fields.length === 0) return fail(400, 'No fields to update');
  for (const field of fields) item[field] = field === 'settings' ? savedSettings(item, body.settings) : copy(body[field]);
  item.schema_version = 2;
  item.revision = (item.revision ?? 1) + 1;
  item.updated_at = new Date().toISOString();
  item.updated_by = 'admin@example.com';
  return [200, { success: true, form: formRecord(item, shared, projectV1, false) }];
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
    language_assumed: false, theme: copy(item.theme ?? {}),
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

/** The AI draft's routes: the settings API's (POST to start, GET `/{job_id}` to poll). */
const DRAFTS_ROUTE = '/settings/form-drafts';

/** Which v2 route this is: an op and the form it is about, or null (a v1 route, or none of ours). */
function classify(method, pathname, shared) {
  if (pathname === DRAFTS_ROUTE) return method === 'POST' ? { op: 'draft' } : null;
  if (pathname.startsWith(`${DRAFTS_ROUTE}/`)) {
    return method === 'GET' ? { op: 'draftJob', jobId: decodeURIComponent(pathname.slice(DRAFTS_ROUTE.length + 1)) } : null;
  }
  if (pathname === '/feedback-forms') return method === 'POST' ? { op: 'create' } : null;
  const match = pathname.match(ROUTE);
  if (!match) return null;
  const item = shared.mockFeedbackForms.find((form) => form.form_id === decodeURIComponent(match[1])) ?? null;
  const ops = {
    '': { GET: 'get', PUT: 'update' }, 'test-link': { POST: 'testLink' }, responses: { DELETE: 'deleteTest', GET: 'responses' },
    results: { GET: 'results' }, config: { GET: 'config' }, submit: { POST: 'submit' }, events: { POST: 'event' },
  };
  const op = ops[match[2] ?? '']?.[method];
  if (op === undefined) return null;
  // The widget's config and submit stay v1's for a v1 form (whose widget sends no beacon).
  if ((op === 'config' || op === 'submit' || op === 'event') && !isV2(item)) return null;
  return { op, item, formId: match[1] };
}

function sendCsv(res, item, url) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${item.form_id}-responses.csv"`);
  res.writeHead(200);
  res.end(responsesCsv(item, filteredResponses(responsesOf(item.form_id), url.searchParams)));
}

/** The writes: their body is read first. */
function writeRoute(shared, route, url, body, projectV1) {
  const input = isPlainObject(body) ? body : {};
  if (route.op === 'draft') return draftAnswer(input);
  if (route.op === 'create') return createV2(shared, input, projectV1);
  if (route.op === 'update') return updateV2(shared, route.item, input, projectV1);
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
  if (route.op === 'draftJob') {
    send(...draftJob(route.jobId));
    return true;
  }
  if (route.op !== 'create' && route.op !== 'draft' && route.item === null) {
    send(404, { success: false, error: 'Form not found' });
    return true;
  }
  if (route.op === 'responses' && url.searchParams.get('format') === 'csv') {
    const refused = includeTestError(url, true);
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
  if (route.op === 'update' && !v2Body && !isV2(route.item)) return false;
  return writeRoute(shared, route, url, body, projectV1);
}
