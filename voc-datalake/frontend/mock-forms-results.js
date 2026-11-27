// A v2 form's Results for the dev mock (7.04.00): the filters (from, language, ending, hidden.<id>, include_test),
// the per-question results, the funnel, the link checks and the detailed CSV, computed from the stored
// responses in the shapes
// lambda/shared/forms_v2_results.py `tally_results` and the handler's responses route answer (the app reads them
// through src/api/feedbackFormsResultsAdapter.ts). Test responses count only with include_test=true (UX §10.5).
//
// A stored row is the mock's own: {response_id, feedback_id?, submitted_at, form_revision, language, answers, hidden,
// ending_id, is_test, shown (the questions its path showed), sentiment}; `responseView` is how the route answers it.

const LATEST = 10;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The filters a request names (everything but include_test). */
function matchesFilters(row, params) {
  const from = params.get('from');
  if (from && row.submitted_at < from) return false;
  const language = params.get('language');
  if (language && row.language !== language) return false;
  const ending = params.get('ending');
  if (ending && row.ending_id !== ending) return false;
  for (const [key, value] of params) {
    if (key.startsWith('hidden.') && (row.hidden?.[key.slice('hidden.'.length)] ?? '') !== value) return false;
  }
  return true;
}

/** The responses a request asks for, newest first: real only (include_test=false), real + test (true), test (only). */
export function filteredResponses(rows, params) {
  const mode = (params.get('include_test') ?? 'false').toLowerCase();
  return rows
    .filter((row) => matchesFilters(row, params))
    .filter((row) => (mode === 'only' ? row.is_test : mode === 'true' || !row.is_test))
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
}

/** One response as GET …/responses answers it (`_response_view`): a real one's id is its feedback item's. */
export function responseView(row) {
  const id = row.is_test ? row.response_id : row.feedback_id ?? row.response_id;
  return {
    response_id: id, is_test: row.is_test === true, created_at: row.submitted_at, revision: row.form_revision ?? null,
    language: row.language ?? null, ending_id: row.ending_id || null, answers: row.answers ?? {}, hidden: row.hidden ?? {},
    path: row.shown ?? Object.keys(row.answers ?? {}),
    ...(row.sentiment ? { sentiment: row.sentiment } : {}),
    ...(row.is_test ? {} : { feedback_id: id }),
  };
}

export const textIn = (text, primary) => (isPlainObject(text) ? text[primary] ?? Object.values(text)[0] ?? '' : '');
/** A text with each `{{id|fallback}}` shown as `[id]`: how results show a recall placeholder (lambda/shared/forms_recall.py). */
const shownAsIds = (text) => text.replace(/\{\{([^{}]*)\}\}/g, (_raw, inner) => `[${inner.split('|')[0].trim()}]`);
/** A question's headline in the primary language, its placeholders as `[id]`. */
export const questionHeadline = (question, primary) => shownAsIds(textIn(question.headline, primary));

/** A scale question's lowest and highest answer (forms_v2.py question_bounds). */
function boundsOf(question) {
  if (question.type === 'nps') return [0, 10];
  if (question.type === 'csat') return [1, 5];
  if (question.type === 'ces') return [1, 7];
  return [1, question.range ?? 5];
}

const SCALES = ['rating', 'nps', 'csat', 'ces'];
const CHOICES = ['single_select', 'multi_select'];

const fitsScale = (question, value) => {
  const [low, high] = boundsOf(question);
  return Number.isInteger(value) && value >= low && value <= high;
};
const fitsChoice = (_question, value) => isPlainObject(value) && ('code' in value || 'codes' in value || 'other' in value);
/** Per type: does a stored answer fit the question as it is now? */
const FITS = {
  ...Object.fromEntries(SCALES.map((type) => [type, fitsScale])),
  ...Object.fromEntries(CHOICES.map((type) => [type, fitsChoice])),
  open_text: (_question, value) => typeof value === 'string' && value !== '',
  consent: (_question, value) => value === true,
  contact_info: (_question, value) => isPlainObject(value) && Object.keys(value).length > 0,
  matrix: (_question, value) => isPlainObject(value) && isPlainObject(value.rows) && Object.keys(value.rows).length > 0,
};

/** `value` when it fits the question's type, else undefined (an older revision's other shape). */
function fitting(question, value) {
  if (value === undefined || value === null) return undefined;
  const fits = FITS[question.type];
  return fits !== undefined && fits(question, value) ? value : undefined;
}

const percent = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

function scoresOf(kind, histogram) {
  const total = Object.values(histogram).reduce((sum, n) => sum + n, 0);
  const count = (scores) => scores.reduce((sum, score) => sum + (histogram[String(score)] ?? 0), 0);
  if (kind === 'nps') {
    const promoters = count([9, 10]);
    const detractors = count([0, 1, 2, 3, 4, 5, 6]);
    return { nps: { score: Math.round((percent(promoters, total) - percent(detractors, total)) * 10) / 10,
      promoters, passives: total - promoters - detractors, detractors } };
  }
  if (kind === 'csat') return { csat: { score: percent(count([4, 5]), total), satisfied: count([4, 5]) } };
  if (kind === 'ces') return { ces: { score: percent(count([5, 6, 7]), total), easy: count([5, 6, 7]) } };
  return {};
}

const newest = (entries) => entries.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, LATEST);
const latestEntry = (row, value) => ({
  value, response_id: responseView(row).response_id, created_at: row.submitted_at, is_test: row.is_test === true,
  ...(row.sentiment ? { sentiment: row.sentiment } : {}),
});

function scaleResult(question, answered) {
  const [low, high] = boundsOf(question);
  const histogram = Object.fromEntries(Array.from({ length: high - low + 1 }, (_unused, i) => [String(low + i), 0]));
  for (const { value } of answered) histogram[String(value)] += 1;
  const total = answered.length;
  const average = total ? Math.round((answered.reduce((sum, { value }) => sum + value, 0) / total) * 100) / 100 : null;
  return { histogram, average, scale_max: high, ...scoresOf(question.type, histogram) };
}

/** How often each code was chosen (Other under `other`), and the typed Other answers. */
function tallyChoices(answered) {
  const counts = {};
  const others = [];
  for (const { row, value } of answered) {
    for (const code of [...(value.codes ?? []), ...(value.code === undefined ? [] : [value.code])]) counts[code] = (counts[code] ?? 0) + 1;
    if (typeof value.other !== 'string' || value.other === '') continue;
    counts.other = (counts.other ?? 0) + 1;
    others.push(latestEntry(row, value.other));
  }
  return { counts, others };
}

function choiceResult(question, answered) {
  const offered = (question.options ?? []).map((option) => option.code);
  const { counts, others } = tallyChoices(answered);
  const out = { options: Object.fromEntries(offered.map((code) => [code, counts[code] ?? 0])) };
  if (question.other?.enabled || counts.other) Object.assign(out, { other: counts.other ?? 0, other_latest: newest(others) });
  if (question.type === 'multi_select' && (question.none?.enabled || counts.none)) out.none = counts.none ?? 0;
  const removed = Object.fromEntries(Object.entries(counts).filter(([code]) => !offered.includes(code) && code !== 'other' && code !== 'none'));
  if (Object.keys(removed).length > 0) out.removed_options = removed;
  return out;
}

/** A matrix's rows (lambda/shared/forms_v2_results.py): each row's counts per column and the average score of its scored answers. */
function matrixResult(question, answered) {
  const columns = (question.columns ?? []).map((column) => column.code);
  const scores = Object.fromEntries((question.columns ?? []).filter((column) => Number.isInteger(column.score)).map((column) => [column.code, column.score]));
  const rowCodes = (question.rows ?? []).map((row) => row.code);
  const removedRows = {};
  const removedColumns = {};
  const rows = rowCodes.map((code) => ({ code, answered: 0, counts: Object.fromEntries(columns.map((column) => [column, 0])), scores: [] }));
  for (const { value } of answered) {
    for (const [rowCode, column] of Object.entries(value.rows)) {
      const row = rows.find((entry) => entry.code === rowCode);
      if (row === undefined) removedRows[rowCode] = (removedRows[rowCode] ?? 0) + 1;
      else if (!columns.includes(column)) removedColumns[column] = (removedColumns[column] ?? 0) + 1;
      else {
        row.answered += 1;
        row.counts[column] += 1;
        if (column in scores) row.scores.push(scores[column]);
      }
    }
  }
  const average = (values) => (values.length ? Math.round((values.reduce((sum, n) => sum + n, 0) / values.length) * 100) / 100 : null);
  return {
    rows: rows.map(({ scores: given, ...row }) => ({ ...row, average: average(given) })), scored: Object.keys(scores).length > 0,
    ...(Object.keys(removedRows).length ? { removed_rows: removedRows } : {}),
    ...(Object.keys(removedColumns).length ? { removed_columns: removedColumns } : {}),
  };
}

/** Per type: the figures of its answers beside the counts every question has. */
const OWN_RESULTS = {
  ...Object.fromEntries(SCALES.map((type) => [type, scaleResult])),
  ...Object.fromEntries(CHOICES.map((type) => [type, choiceResult])),
  open_text: (_question, answered) => ({ count: answered.length, latest: newest(answered.map(({ row, value }) => latestEntry(row, value))) }),
  consent: (_question, answered) => ({ accepted: answered.length }),
  contact_info: (_question, answered) => ({ contacts: answered.length }),
  matrix: matrixResult,
};

const ownResult = (question, answered) => OWN_RESULTS[question.type]?.(question, answered) ?? {};

/** shown (its path showed it), answered, skipped, not_shown (the path jumped past it), drop_off_rate, then by type. */
function questionResult(question, rows, primary) {
  const shownRows = rows.filter((row) => (row.shown ?? []).includes(question.id) || row.answers[question.id] !== undefined);
  const answered = rows.flatMap((row) => {
    const value = fitting(question, row.answers[question.id]);
    return value === undefined ? [] : [{ row, value }];
  });
  const skipped = Math.max(shownRows.length - answered.length, 0);
  return {
    id: question.id, type: question.type, headline: questionHeadline(question, primary),
    shown: shownRows.length, answered: answered.length, skipped, not_shown: Math.max(rows.length - shownRows.length, 0),
    drop_off_rate: shownRows.length ? Math.round((skipped / shownRows.length) * 10000) / 10000 : 0,
    ...ownResult(question, answered),
  };
}

/**
 * The widget's signals the beacon (D6) would give, for a seed with the mock's `funnel` flag: opens, and where those
 * who left without submitting stopped (half at the first question, half of the rest at the next, and so on). A form
 * without the flag has counted no open, as one answered before 7.04.00 has.
 */
function funnelOf(item, rows) {
  if (!item.funnel || rows.length === 0) return { opened: 0, left: {} };
  const opened = rows.length * 2 + 3;
  const left = {};
  let remaining = opened - rows.length;
  for (const [index, question] of (item.questions ?? []).entries()) {
    const here = index === item.questions.length - 1 ? remaining : Math.floor(remaining / 2);
    if (here > 0) left[question.id] = here;
    remaining -= here;
  }
  return { opened, left };
}

/**
 * The forms list's card figure (forms_v2_results.py `headline`): the first measuring question's NPS score, CSAT % or
 * average (rating, CES) over the real responses, with the count it is over; null without such a question or answer.
 */
export function headlineOf(item, allRows) {
  const question = (item.questions ?? []).find((candidate) => SCALES.includes(candidate.type));
  if (question === undefined) return null;
  const answered = allRows.filter((row) => !row.is_test)
    .map((row) => ({ value: fitting(question, row.answers?.[question.id]) }))
    .filter(({ value }) => value !== undefined);
  if (answered.length === 0) return null;
  const result = scaleResult(question, answered);
  const value = question.type === 'nps' || question.type === 'csat' ? result[question.type].score : result.average;
  return { question_id: question.id, type: question.type, value, count: answered.length, scale_max: result.scale_max };
}

/** How a set of rows filled each hidden field: `{id: {filled, missing}}`. */
function fills(ids, rows) {
  return Object.fromEntries(ids.map((id) => {
    const filled = rows.filter((row) => typeof row.hidden?.[id] === 'string' && row.hidden[id] !== '').length;
    return [id, { filled, missing: rows.length - filled }];
  }));
}

/**
 * The link checks (lambda/shared/forms_v2_results.py `link_health`): per hidden field how many responses had it, by channel
 * too, and a warning for one never filled once 5 came in, or missing from 80 % or more once 10 did. The mock keeps no
 * revision snapshots, so every row is read on the current revision, as the server reads a row whose snapshot it lacks.
 */
function linkHealthOf(item, rows) {
  const ids = (item.hidden_fields ?? []).map((field) => field.id);
  const hidden = fills(ids, rows);
  const channels = [...new Set(rows.map((row) => row.channel ?? 'unknown'))];
  const warnings = ids.flatMap((id) => {
    const { filled } = hidden[id];
    const total = rows.length;
    if (filled === 0 && total >= 5) return [{ id, kind: 'never_filled', filled, total }];
    if (total >= 10 && (total - filled) / total >= 0.8) return [{ id, kind: 'mostly_missing', filled, total }];
    return [];
  });
  return {
    responses: rows.length, hidden,
    by_channel: Object.fromEntries(channels.map((channel) => {
      const own = rows.filter((row) => (row.channel ?? 'unknown') === channel);
      return [channel, { responses: own.length, hidden: fills(ids, own) }];
    })),
    warnings,
  };
}

/** Does the view filter by what the funnel's daily counters know nothing of (the handler's `_funnel_hidden`)? */
const funnelHidden = (params) => Boolean(params.get('language') || params.get('ending'))
  || [...params.keys()].some((key) => key.startsWith('hidden.'));

/**
 * GET …/results without its envelope (the route adds form_id, revision and include_test). `test_responses` counts
 * the test responses under the filters whether or not they are included; `funnel` is null under a language, ending
 * or hidden-value filter.
 */
export function formResults(item, allRows, params) {
  const rows = filteredResponses(allRows, params);
  const tests = allRows.filter((row) => row.is_test && matchesFilters(row, params));
  const primary = item.language ?? 'en';
  const endings = Object.fromEntries((item.endings ?? []).map((ending) => [ending.id, 0]));
  const hidden = Object.fromEntries((item.hidden_fields ?? []).map((field) => [field.id, 0]));
  for (const row of rows) {
    if (row.ending_id in endings) endings[row.ending_id] += 1;
    for (const id of Object.keys(row.hidden ?? {})) if (id in hidden) hidden[id] += 1;
  }
  const current = new Set((item.questions ?? []).map((question) => question.id));
  const removed = {};
  for (const row of rows) for (const id of Object.keys(row.answers)) if (!current.has(id)) removed[id] = (removed[id] ?? 0) + 1;
  return {
    responses: rows.length,
    test_responses: tests.length,
    last_response_at: rows[0]?.submitted_at ?? null,
    questions: (item.questions ?? []).map((question) => questionResult(question, rows, primary)),
    endings,
    hidden,
    removed_questions: Object.entries(removed).sort().map(([id, answered]) => ({ id, answered })),
    funnel: funnelHidden(params) ? null : { ...funnelOf(item, rows), completed: rows.length },
    link_health: linkHealthOf(item, rows),
  };
}

/** One answer as a CSV cell (_csv_answer): a choice's labels, then the typed Other; contact details by field. */
function cell(question, value, primary) {
  if (value === undefined || value === null) return '';
  if (isPlainObject(value) && CHOICES.includes(question.type)) {
    const labels = Object.fromEntries((question.options ?? []).map((option) => [option.code, textIn(option.label, primary) || option.code]));
    const codes = [...(value.codes ?? []), ...(value.code === undefined ? [] : [value.code])];
    return [...codes.map((code) => labels[code] ?? code), ...(value.other ? [`other: ${value.other}`] : [])].join('; ');
  }
  if (isPlainObject(value) && isPlainObject(value.rows)) return Object.entries(value.rows).map(([row, column]) => `${row}: ${column}`).join('; ');
  if (isPlainObject(value)) return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join('; ');
  return String(value);
}

/** Never a spreadsheet formula: a leading = + - @ or control character is quoted off (_csv_cell). */
export const safe = (text) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
export const csvField = (value) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * GET …/responses?format=csv (_responses_csv): time, ids, test flag, revision, language, ending, one column per
 * question but statements (labels in the first header row, ids in the second), then the hidden fields.
 */
export function responsesCsv(item, rows) {
  const primary = item.language ?? 'en';
  const questions = (item.questions ?? []).filter((question) => question.type !== 'statement');
  const hidden = (item.hidden_fields ?? []).map((field) => field.id);
  const fixed = ['created_at', 'response_id', 'is_test', 'revision', 'language', 'ending_id'];
  const lines = [
    // (the header is the author's text too: never a formula either)
    [...fixed, ...questions.map((question) => questionHeadline(question, primary)), ...hidden.map((id) => `hidden: ${id}`)]
      .map((text) => safe(String(text))),
    [...fixed, ...questions.map((question) => question.id), ...hidden.map((id) => `hidden.${id}`)],
    ...rows.map((row) => {
      const view = responseView(row);
      return [view.created_at, view.response_id, String(view.is_test), String(view.revision ?? ''), view.language ?? '', view.ending_id ?? '',
        ...questions.map((question) => cell(question, row.answers[question.id], primary)), ...hidden.map((id) => row.hidden?.[id] ?? '')]
        .map((text) => safe(String(text)));
    }),
  ];
  return `${lines.map((line) => line.map((value) => csvField(String(value))).join(',')).join('\r\n')}\r\n`;
}
