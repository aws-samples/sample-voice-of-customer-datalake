// The Report (7.63.00) for the dev mock, in the shapes lambda/api/feedback_form_handler.py answers
// (docs/feedback-forms.md "Report" and "Compare"; lambda/shared/forms_v2_report.py and forms_v2_segments.py):
//
//   GET  /feedback-forms/{id}/report?…[&group_by=]   KPIs, heatmaps, segments (at least 5 responses each), the themes
//                                                    of the open answers with real quotes, the newest AI summary
//   GET  /feedback-forms/{id}/compare?with=&by=       the form beside others, questions matched by id and type
//   POST /settings/form-reports                       an AI summary: 202 {job_id}; the job labels the answers it was
//                                                    sent and stores the report (no model: the mock's own labels)
//   GET  /settings/form-reports/{job_id}              the job: {status, result: {success, form_id, report_id}}

import { randomBytes } from 'node:crypto';
import { formResults, questionHeadline } from './mock-forms-results.js';

const MIN_SEGMENT = 5;
const MAX_COMPARED = 10;
const MAX_QUOTES = 3;
const SCALES = ['rating', 'nps', 'csat', 'ces'];
const fail = (status, error, extra = {}) => [status, { success: false, error, ...extra }];
/** The stored AI summaries by form id (the worker's FORMREPORT# rows), and the summary jobs. */
const stored = new Map();
const jobs = new Map();

/** Every response of `rows` counted (they are already the view's). */
const ALL = new URLSearchParams('include_test=true');

/** A question's compact figure (shared/forms_v2_results.py `_figure`). */
function figure(result) {
  if (result.type === 'matrix') return { type: 'matrix', answered: result.answered, rows: Object.fromEntries(result.rows.map((row) => [row.code, row.average])) };
  const out = { type: result.type, answered: result.answered, average: result.average, scale_max: result.scale_max };
  for (const kind of ['nps', 'csat', 'ces']) if (result[kind] !== undefined) out[kind] = result.answered ? result[kind].score : null;
  return out;
}

function scoresOf(item, rows, only = null) {
  const results = formResults(item, rows, ALL).questions.filter((q) => (SCALES.includes(q.type) || q.type === 'matrix') && (only === null || only.includes(q.id)));
  return Object.fromEntries(results.map((result) => [result.id, figure(result)]));
}

/** The segment a row belongs to under `groupBy` (hidden.<id>, q_<id>, q_<id>.<row>); '' with none. */
function segmentOf(groupBy, row) {
  if (groupBy.startsWith('hidden.')) return (row.hidden?.[groupBy.slice(7)] ?? '').trim();
  const [qid, matrixRow] = groupBy.split('.');
  const answer = row.answers[qid];
  if (answer === null || typeof answer !== 'object') return '';
  if (matrixRow !== undefined) return answer.rows?.[matrixRow] ?? '';
  return answer.code ?? (answer.other ? 'other' : '');
}

function validGroupBy(item, groupBy) {
  if (groupBy.startsWith('hidden.')) return (item.hidden_fields ?? []).some((field) => `hidden.${field.id}` === groupBy);
  const [qid, matrixRow] = groupBy.split('.');
  const question = (item.questions ?? []).find((q) => q.id === qid);
  if (question?.type === 'single_select') return matrixRow === undefined;
  return question?.type === 'matrix' && (question.rows ?? []).some((row) => row.code === matrixRow);
}

function split(groupBy, rows) {
  const groups = new Map();
  for (const row of rows) groups.set(segmentOf(groupBy, row), [...(groups.get(segmentOf(groupBy, row)) ?? []), row]);
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return { named: ordered.filter(([, members]) => members.length >= MIN_SEGMENT), small: ordered.filter(([, members]) => members.length < MIN_SEGMENT) };
}

function segments(item, rows, groupBy) {
  const { named, small } = split(groupBy, rows);
  const merged = small.flatMap(([, members]) => members);
  return {
    by: groupBy, min_size: MIN_SEGMENT,
    groups: named.map(([value, members]) => ({ value, responses: members.length, scores: scoresOf(item, members) })),
    merged: small.length === 0 ? null : { segments: small.length, responses: merged.length, scores: merged.length >= MIN_SEGMENT ? scoresOf(item, merged) : null },
  };
}

const freeText = (item) => (item.questions ?? []).filter((q) => q.type === 'open_text' && (q.long || (q.input_type ?? 'text') === 'text'));
const sentimentOf = (row) => (['positive', 'neutral', 'negative', 'mixed'].includes(row.sentiment) ? row.sentiment : 'unknown');

/** Per free-text question, its answers by the response's category and subcategory, with real quotes. */
function themes(item, rows) {
  return freeText(item).map((question) => {
    const groups = new Map();
    for (const row of rows) {
      const text = typeof row.answers[question.id] === 'string' ? row.answers[question.id].trim() : '';
      if (text === '') continue;
      const key = `${row.category ?? ''}#${row.subcategory ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), { row, text }]);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    return {
      question_id: question.id, headline: questionHeadline(question, item.language ?? 'en'),
      answered: ordered.reduce((sum, [, members]) => sum + members.length, 0),
      themes: ordered.map(([key, members]) => {
        const [category, subcategory] = key.split('#');
        const mix = {};
        for (const { row } of members) mix[sentimentOf(row)] = (mix[sentimentOf(row)] ?? 0) + 1;
        const quotes = members.slice(0, MAX_QUOTES).map(({ row, text }) => ({ response_id: row.feedback_id ?? row.response_id, text, created_at: row.submitted_at, sentiment: sentimentOf(row) }));
        return { category, subcategory, count: members.length, sentiment: mix, quotes };
      }),
    };
  });
}

/** The stored summary as this reader sees it: quotes joined against the rows, stale once a newer response came in. */
function aiView(item, allRows) {
  const report = stored.get(item.form_id);
  if (report === undefined) return null;
  const byId = new Map(allRows.filter((row) => !row.is_test).map((row) => [row.feedback_id ?? row.response_id, row]));
  const quoteText = (row) => freeText(item).map((q) => row.answers[q.id]).filter((v) => typeof v === 'string' && v !== '').join(' · ');
  const newest = [...byId.values()].reduce((max, row) => (row.submitted_at > max ? row.submitted_at : max), '');
  return {
    report_id: report.report_id, created_at: report.created_at, created_by: report.created_by, responses_counted: report.responses_counted,
    last_response_at: report.last_response_at, filters: report.filters, model: 'mock-model', prompt_version: '1.0.0', summary: report.summary,
    themes: report.themes.map((theme) => ({ ...theme, quotes: theme.quote_ids.filter((id) => byId.has(id)).map((id) => ({ response_id: id, text: quoteText(byId.get(id)) })) })),
    stale: newest > (report.last_response_at ?? ''),
  };
}

/** GET …/report without its envelope (the caller passes the view's rows and every row of the form). */
export function formReport(item, viewRows, allRows, params) {
  const groupBy = params.get('group_by');
  if (groupBy && !validGroupBy(item, groupBy)) return fail(400, `${groupBy} is none of this form`, { code: 'group_by_invalid' });
  const results = formResults(item, viewRows, ALL);
  const times = viewRows.map((row) => row.submitted_at).sort();
  const columnsOf = (id) => ((item.questions ?? []).find((q) => q.id === id)?.columns ?? []).map((column) => column.code);
  return [200, {
    success: true, form_id: item.form_id, revision: item.revision ?? 1, name: item.name, template: item.template ?? null,
    include_test: params.get('include_test') === 'true', responses: results.responses, test_responses: results.test_responses,
    first_response_at: times[0] ?? null, last_response_at: times.at(-1) ?? null,
    kpis: results.questions.filter((q) => SCALES.includes(q.type)).map((q) => ({
      id: q.id, type: q.type, headline: q.headline, answered: q.answered, skipped: q.skipped, average: q.average, scale_max: q.scale_max,
      ...(q.nps ? { nps: q.nps } : {}), ...(q.csat ? { csat: q.csat } : {}), ...(q.ces ? { ces: q.ces } : {}),
    })),
    matrices: results.questions.filter((q) => q.type === 'matrix').map((q) => ({ id: q.id, headline: q.headline, answered: q.answered, scored: q.scored, columns: columnsOf(q.id), rows: q.rows })),
    segments: groupBy ? segments(item, viewRows, groupBy) : null, themes: themes(item, viewRows), ai: aiView(item, allRows), min_segment: MIN_SEGMENT,
  }];
}

function measured(item) {
  return (item.questions ?? []).filter((q) => SCALES.includes(q.type) || q.type === 'matrix');
}

const shapeOf = (q) => `${q.type}:${q.type === 'rating' ? q.range : ''}`;

/** GET …/compare: `with` (up to 10 form ids of the mock's forms) and `by` (hidden.<id>). */
export function formCompare(item, forms, rowsOf, params) {
  const ids = (params.get('with') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== item.form_id);
  if (ids.length > MAX_COMPARED) return fail(400, `with names at most ${MAX_COMPARED} forms`);
  const by = params.get('by');
  if (by && !(item.hidden_fields ?? []).some((field) => `hidden.${field.id}` === by)) return fail(400, 'by must be hidden.<id>, a hidden field of this form', { code: 'group_by_invalid' });
  const others = ids.map((id) => forms.find((form) => form.form_id === id));
  if (others.includes(undefined)) return fail(404, 'Form not found');
  const base = measured(item);
  const sides = [item, ...others];
  const point = (side, rows, matched, value, merged = false) => {
    const times = rows.map((row) => row.submitted_at).sort();
    return { form_id: side.form_id, value, responses: rows.length, first_response_at: times[0] ?? null, last_response_at: times.at(-1) ?? null,
      scores: rows.length >= MIN_SEGMENT ? scoresOf(side, rows, matched) : null, ...(merged ? { merged: true } : {}) };
  };
  const formsOut = [];
  const points = [];
  for (const side of sides) {
    const own = new Map(measured(side).map((q) => [q.id, q]));
    const matched = base.filter((q) => own.has(q.id) && shapeOf(own.get(q.id)) === shapeOf(q)).map((q) => q.id);
    const unmatched = Object.fromEntries(base.filter((q) => !matched.includes(q.id)).map((q) => [q.id, own.has(q.id) ? 'different' : 'missing']));
    formsOut.push({ form_id: side.form_id, name: side.name, template: side.template ?? null,
      same_template: item.template !== undefined && side.template?.id === item.template.id, matched, unmatched });
    const rows = rowsOf(side.form_id);
    if (!by) {
      points.push(point(side, rows, matched, null));
      continue;
    }
    const { named, small } = split(by, rows);
    for (const [value, members] of named.sort((a, b) => a[0].localeCompare(b[0]))) points.push(point(side, members, matched, value));
    if (small.length > 0) points.push(point(side, small.flatMap(([, members]) => members), matched, null, true));
  }
  return [200, { success: true, form_id: item.form_id, include_test: false, by: by || null, min_size: MIN_SEGMENT,
    questions: base.map((q) => ({ id: q.id, type: q.type, headline: questionHeadline(q, item.language ?? 'en') })), forms: formsOut, points }];
}

/** POST /settings/form-reports: the mock's own labels (the first words of each answer), stored at once. */
export function startSummary(forms, body) {
  const form = forms.find((candidate) => candidate.form_id === body.form_id);
  if (!Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > 300) return fail(400, 'answers must be a list of 1 to 300 answers', { code: 'answers_invalid' });
  if (form === undefined) return fail(404, 'Form not found');
  const ids = body.answers.map((answer) => answer.response_id);
  const reportId = `rpt_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${randomBytes(4).toString('hex')}`;
  stored.set(form.form_id, {
    report_id: reportId, created_at: new Date().toISOString(), created_by: { sub: 'mock-user', kind: 'user' }, responses_counted: body.responses ?? ids.length,
    last_response_at: body.last_response_at ?? null, filters: body.filters ?? {}, response_ids: ids,
    summary: `People valued the hands-on parts most; ${ids.length} answers mention the pace or the setup.`,
    themes: [{ label: 'Hands-on parts', count: Math.ceil(ids.length / 2), sentiment: 'positive', quote_ids: ids.slice(0, MAX_QUOTES) },
      { label: 'Setup and pace', count: Math.floor(ids.length / 2), sentiment: 'negative', quote_ids: ids.slice(MAX_QUOTES, MAX_QUOTES * 2) }],
  });
  const jobId = `job_${randomBytes(8).toString('hex')}`;
  jobs.set(jobId, { job_id: jobId, job_type: 'assist_form_report', status: 'completed', result: { success: true, form_id: form.form_id, report_id: reportId } });
  return [202, { success: true, job_id: jobId, status: 'pending' }];
}

/** GET /settings/form-reports/{job_id}. */
export function summaryJob(jobId) {
  const job = jobs.get(jobId);
  return job === undefined ? fail(404, 'Job not found') : [200, { success: true, ...job, error: null }];
}
