// The import wizard's mock (7.67.00, docs/import-wizard.md): POST /scrapers/manual/detect, the CSV import's wizard
// `mapping` (turned into the `column_map` upload mock-sources.js already serves) and POST /feedback-forms/{id}/import,
// in the wire shapes of lambda/shared/import_wizard.py and lambda/api/feedback_form_handler.py. The detection is a
// short version of lambda/shared/import_detect.py (headers in a few languages, then the values); a workbook is not
// read here (the dev mock has no zip reader): its detect answers 400.

const KIND_WORDS = [
  ['email', /\b(e-?mail|correo|courriel)/iu],
  ['nps_0_10', /(recommend|recomend|polec|empfehl|recommand|\bnps\b)/iu],
  ['csat', /(csat|satisf|zadowol|zufried)/iu],
  ['date', /\b(date|fecha|data|datum|created|submitted|timestamp)/iu],
  ['id', /(\bid\b|identif|identyf|\buuid\b|ticket)/iu],
  ['name', /\b(name|nombre|imi[eę]|nazwisk|author|autor)/iu],
  ['channel', /\b(channel|source|platform|canal|kana[lł])/iu],
  ['rating_1_5', /(rating|stars?\b|score|valoraci|puntuaci|ocen)/iu],
  ['open_text', /(comment|feedback|review|text|why|reason|suggest|improv|opini|comentar|komentarz|uwag|dlaczego)/iu],
];
const DELIMITERS = [',', ';', '\t', '|'];
const MAX_SAMPLE_BYTES = 256 * 1024;

/** The records of a delimited text (quotes, doubled quotes, any line end; blank lines out). */
function parseDelimited(text, delimiter) {
  const records = [[]];
  const separator = delimiter === '|' ? '\\|' : delimiter.replaceAll('\t', '\\t');
  const pattern = new RegExp(`(?:"([^"]*(?:""[^"]*)*)"|([^${separator}\\r\\n]*))(${separator}|\\r\\n|\\n|\\r|$)`, 'gu');
  for (const match of text.replace(/^\uFEFF/u, '').matchAll(pattern)) {
    if (match[0] === '') break;
    const [, quoted, bare = '', end] = match;
    records.at(-1).push(quoted === undefined ? bare : quoted.replaceAll('""', '"'));
    if (end !== delimiter) records.push([]);
  }
  return records.filter((record) => record.some((value) => value.trim() !== ''));
}

const sniff = (text) => {
  const line = text.replace(/^\uFEFF/u, '').split('\n', 1)[0].replace(/"[^"]*"/gu, '');
  return DELIMITERS.reduce((best, d) => (line.split(d).length > line.split(best).length ? d : best), ',');
};

const headersOf = (raw) => raw.slice(0, 200).reduce((out, name, i) => {
  const text = String(name ?? '').trim() || `Column ${i + 1}`;
  return [...out, out.includes(text) ? `${text} (${i + 1})` : text];
}, []);

/** A JSON value as one cell: a list joined with "; ", nothing as ''. */
const cellText = (value) => {
  if (value == null) return '';
  return String(Array.isArray(value) ? value.join('; ') : value);
};

/** The delimiter asked for, else a TSV's tab, else the one the first line splits on most. */
function delimiterOf(format, sample, delimiter) {
  if (DELIMITERS.includes(delimiter)) return delimiter;
  return format === 'tsv' ? '\t' : sniff(sample);
}

function table(format, sample, delimiter) {
  if (format === 'json') {
    const parsed = JSON.parse(sample);
    const records = (Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray) ?? [parsed]).filter((r) => r && typeof r === 'object');
    const names = [...new Set(records.flatMap((r) => Object.keys(r)))];
    const headers = headersOf(names);
    return { delimiter: ',', headers, rows: records.map((r) => headers.map((_h, i) => cellText(r[names[i]]))) };
  }
  const sep = delimiterOf(format, sample, delimiter);
  const [header = [], ...records] = parseDelimited(sample, sep);
  const headers = headersOf(header);
  return { delimiter: sep, headers, rows: records.map((r) => headers.map((_h, i) => (r[i] ?? '').trim())) };
}

const integer = (v) => (/^-?\d{1,9}(?:[.,]0+)?$/u.test(v) ? Number.parseInt(v, 10) : null);
const share = (values, test) => (values.length === 0 ? 0 : values.filter(test).length / values.length);

/** One address: no space, one `@` with text before it, and a `.` inside the part after it (no backtracking regex). */
function isEmail(value) {
  if (/\s/u.test(value)) return false;
  const [local, domain, ...more] = value.split('@');
  return more.length === 0 && local !== '' && domain !== undefined
    && [...domain].some((char, i) => char === '.' && i > 0 && i < domain.length - 1);
}

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/u;

/** A column of whole numbers 0 to 10: NPS (its header, or a 0), CSAT (its header), else a 1-5 or 1-10 rating. */
function scoreKind(word, low, high) {
  if (word === 'nps_0_10' || low === 0) return 'nps_0_10';
  if (word === 'csat') return 'csat';
  return high <= 5 ? 'rating_1_5' : 'rating_1_10';
}

/** The kinds the values alone say (an address, a grid, a date, a score), else null. */
function valueKind(values, said, word) {
  if (share(values, isEmail) >= 0.8) return { kind: 'email', confidence: 0.95, reasons: [{ code: 'emails', params: {} }] };
  if (share(values, (v) => v.includes(' -- ')) >= 0.8) return { kind: 'matrix_cell', confidence: 0.9, reasons: [{ code: 'matrix_pairs', params: {} }] };
  if (share(values, (v) => DATE_VALUE.test(v)) >= 0.8) {
    return { kind: 'date', confidence: 0.9, reasons: [{ code: 'dates', params: { order: 'dmy' } }, ...said], date_order: 'dmy' };
  }
  const numbers = values.map(integer).filter((n) => n !== null);
  if (numbers.length < 0.9 * values.length || Math.max(...numbers) > 10 || Math.min(...numbers) < 0) return null;
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return { kind: scoreKind(word, low, high), confidence: said.length ? 0.95 : 0.6,
    reasons: [{ code: 'values_range', params: { min: low, max: high } }, ...said] };
}

/** A text column's kind: a header naming an id, a name, a channel or an address; a list; a choice; else open text. */
function textKind(values, said, word) {
  const distinct = new Set(values.map((v) => v.toLowerCase()));
  if (['id', 'name', 'channel', 'email'].includes(word)) return { kind: word, confidence: 0.85, reasons: said };
  if (share(values, (v) => v.includes(';')) >= 0.3) return { kind: 'multi_choice', confidence: 0.75, reasons: [{ code: 'separator', params: { separator: ';' } }], separator: ';' };
  if (distinct.size <= 12 && values.length >= 2 * distinct.size) return { kind: 'choice', confidence: 0.7, reasons: [{ code: 'distinct_values', params: { count: distinct.size } }] };
  const average = Math.round(values.reduce((n, v) => n + v.length, 0) / values.length);
  return { kind: 'open_text', confidence: said.length ? 0.85 : 0.6, reasons: [{ code: 'long_text', params: { average } }, ...said] };
}

/** One column's kind, confidence and reasons (import_detect.py `detect_column`, shortened). */
function detectColumn(header, raw) {
  const values = raw.map((v) => v.trim()).filter(Boolean);
  const word = KIND_WORDS.find(([, re]) => re.test(header));
  const said = word ? [{ code: 'header_says', params: { word: header.match(word[1])[0].toLowerCase() } }] : [];
  if (values.length === 0) return { kind: 'ignore', confidence: 0.9, reasons: [{ code: 'empty', params: {} }] };
  return valueKind(values, said, word?.[0]) ?? textKind(values, said, word?.[0]);
}

const slug = (text) => text.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '').slice(0, 40);
const QUESTION = { open_text: { type: 'open_text', long: true, input_type: 'text' }, nps_0_10: { type: 'nps' }, csat: { type: 'csat' },
  rating_1_5: { type: 'rating', scale: 'star', range: 5 }, rating_1_10: { type: 'rating', scale: 'number', range: 10 } };
const distinctCells = (cells) => [...new Map(cells.filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];
/** `object` without the `keys` (rather than a rest destructure's unused names). */
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/** A choice column's labels: its distinct cells, a multiple choice's split on `;`; none for any other kind. */
function choiceLabels(column) {
  if (column.kind === 'choice') return distinctCells(column.cells);
  if (column.kind === 'multi_choice') return distinctCells(column.cells.flatMap((c) => c.split(';').map((p) => p.trim())));
  return [];
}

/** The imported form of the columns (import_survey.py `infer_form`, shortened: no matrix). */
function inferForm(columns, language) {
  const questions = [];
  const mapping = {};
  for (const column of columns) {
    const base = QUESTION[column.kind];
    const labels = choiceLabels(column);
    const shape = base ?? (labels.length > 0 && labels.length <= 50
      ? { type: column.kind === 'choice' ? 'single_select' : 'multi_select',
          options: labels.map((label, i) => ({ code: slug(label) || `option_${i + 1}`, label: { [language]: label } })) }
      : null);
    if (shape === null || questions.length >= 30) {
      mapping[column.header] = { date: 'date', id: 'id' }[column.kind] ?? 'ignore';
      continue;
    }
    const name = slug(column.header) || `col_${questions.length + 1}`;
    const id = `q_${name}`;
    questions.push({ id, headline: { [language]: column.header }, required: false, ...shape });
    mapping[column.header] = id;
  }
  if (questions.length === 0) return null;
  return { definition: { language, languages: [language], welcome: { enabled: false }, questions, hidden_fields: [],
    endings: [{ id: 'end_thanks', title: { [language]: 'Thank you!' } }] }, mapping, problems: [] };
}

const fail = (status, error, code) => [status, { success: false, error, ...(code ? { code } : {}) }];

/** The import's target: the one asked for, else a survey for its kinds (NPS, a list, a grid, or no open text). */
function targetOf(asked, kinds) {
  if (['reviews', 'survey'].includes(asked)) return asked;
  const survey = kinds.some((k) => ['nps_0_10', 'multi_choice', 'matrix_cell'].includes(k)) || !kinds.includes('open_text');
  return survey ? 'survey' : 'reviews';
}

/** POST /scrapers/manual/detect. */
export function detectColumns(_ctx, body) {
  if (!['csv', 'tsv', 'json', 'xlsx'].includes(body.format)) return fail(400, 'format must be one of: csv, tsv, json, xlsx', 'format_invalid');
  if (typeof body.sample !== 'string' || body.sample.trim() === '') return fail(400, 'sample is required', 'sample_required');
  if (body.format === 'xlsx') return fail(400, 'The dev mock reads CSV, TSV and JSON only: save the workbook as CSV', 'file_unreadable');
  if (Buffer.byteLength(body.sample) > MAX_SAMPLE_BYTES) return fail(400, 'sample must be at most 256 KB', 'sample_too_large');
  let read;
  try {
    read = table(body.format, body.sample, body.delimiter);
  } catch {
    return fail(400, 'The file could not be read', 'file_unreadable');
  }
  const chosen = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
  const columns = read.headers.map((header, i) => {
    const cells = read.rows.map((row) => row[i] ?? '');
    const found = detectColumn(header, cells);
    const kind = typeof chosen[header] === 'string' ? chosen[header] : found.kind;
    const reasons = kind === found.kind ? found.reasons : [{ code: 'chosen', params: {} }];
    return { header, kind, confidence: kind === found.kind ? found.confidence : 1, reasons, reason: '',
      personal: kind === 'email' || kind === 'name', values: kind === 'email' || kind === 'name' ? [] : distinctCells(cells).slice(0, 50),
      filled: cells.filter(Boolean).length, ...(found.date_order ? { date_order: found.date_order } : {}),
      ...(found.separator ? { separator: found.separator } : {}), cells: body.values?.[header] ?? cells };
  });
  const kinds = columns.map((c) => c.kind);
  const target = targetOf(body.target, kinds);
  const form = inferForm(columns, typeof body.language === 'string' ? body.language : 'en');
  return [200, { format: body.format, delimiter: read.delimiter, headers: read.headers, row_count: read.rows.length,
    columns: columns.map((column) => omit(column, ['cells'])),
    suggested: { target, mapping: Object.fromEntries(columns.map((c) => [c.header, c.kind])), date_order: body.date_order ?? 'dmy',
      form, form_problem: form === null ? 'no_questions' : null } }];
}

const CSV_TARGET = { id: 'id', date: 'date', url: 'url', channel: 'channel' };
const csvCell = (v) => (/[",\r\n]/u.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** A wizard upload (`mapping`, `delimiter`, `import_tag`) as the `column_map` upload mock-sources.js serves; any other
 * body as it is. The open-text columns are the text, a rating the 1-5 rating, a dimension its column, the rest metadata;
 * personal data and ignored columns are dropped (import_wizard.py `reviews_fields`). */
export function wizardCsvBody(body) {
  if (!body || typeof body.mapping !== 'object' || body.mapping === null) return body;
  const [header = [], ...rows] = parseDelimited(String(body.csv_text ?? ''), DELIMITERS.includes(body.delimiter) ? body.delimiter : ',');
  const headers = headersOf(header);
  const kinds = headers.map((h) => body.mapping[h] ?? 'ignore');
  const kept = headers.map((h, i) => [h, kinds[i]]).filter(([, k]) => !['open_text', 'email', 'name', 'ignore'].includes(k));
  const rating = kept.find(([, k]) => ['rating_1_5', 'csat', 'rating_1_10'].includes(k))?.[0];
  const csvTarget = (h, k) => {
    if (CSV_TARGET[k] !== undefined) return CSV_TARGET[k];
    if (k.startsWith('dimension:')) return k;
    return h === rating ? 'rating' : 'metadata';
  };
  const columnMap = { text: 'text', ...Object.fromEntries(kept.map(([h, k]) => [h, csvTarget(h, k)])),
    ...(body.import_tag ? { tags: 'tags' } : {}) };
  const out = [['text', ...kept.map(([h]) => h), ...(body.import_tag ? ['tags'] : [])],
    ...rows.map((row) => [headers.filter((_h, i) => kinds[i] === 'open_text').map((h) => row[headers.indexOf(h)] ?? '').filter(Boolean).join('\n\n'),
      ...kept.map(([h]) => row[headers.indexOf(h)] ?? ''), ...(body.import_tag ? [body.import_tag] : [])])];
  const rest = omit(body, ['mapping', 'delimiter', 'date_order', 'import_tag']);
  return { ...rest, column_map: columnMap, csv_text: `${out.map((r) => r.map(csvCell).join(',')).join('\n')}\n` };
}

/** POST /feedback-forms/{id}/import on an imported form: each row through the mapping as a stored response. */
export function importRows(item, body, store) {
  if (!item.imported) return fail(409, 'Only a form made by the import wizard takes imported responses', 'not_imported');
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 5000) return fail(400, 'rows must be a list of 1 to 5,000 rows a call');
  const questions = new Map((item.questions ?? []).map((q) => [q.id, q]));
  const offset = Number.isInteger(body.offset) ? body.offset : 0;
  const refused = [];
  const accepted = [];
  body.rows.forEach((row, i) => {
    const answers = {};
    for (const [header, target] of Object.entries(body.mapping ?? {})) {
      const question = questions.get(target);
      const cell = String(row[header] ?? '').trim();
      if (!question || cell === '') continue;
      if (['nps', 'csat', 'rating'].includes(question.type)) answers[target] = integer(cell);
      else if (question.type === 'single_select') answers[target] = { code: question.options.find((o) => Object.values(o.label)[0]?.toLowerCase() === cell.toLowerCase())?.code };
      else if (question.type === 'multi_select') answers[target] = { codes: cell.split(';').map((p) => question.options.find((o) => Object.values(o.label)[0]?.toLowerCase() === p.trim().toLowerCase())?.code) };
      else answers[target] = cell;
    }
    const bad = Object.entries(answers).find(([, a]) => a === null || a?.code === undefined && a?.codes === undefined && typeof a === 'object' || a?.codes?.includes(undefined));
    if (bad) refused.push({ row: offset + i + 1, code: 'answer_invalid', question_id: bad[0] });
    else if (Object.keys(answers).length === 0) refused.push({ row: offset + i + 1, code: 'empty_response' });
    else accepted.push({ response_id: `fimp_${item.form_id}_${offset + i + 1}`, feedback_id: `fimp_${item.form_id}_${offset + i + 1}`,
      submitted_at: new Date().toISOString(), form_revision: item.revision ?? 1, language: item.language, answers, hidden: {},
      ending_id: item.endings?.[0]?.id ?? '', is_test: false, shown: Object.keys(answers), sentiment: null });
  });
  if (body.dry_run !== true && accepted.length > 0) {
    store(accepted);
    item.has_responses = true;
  }
  const run = 'a1b2c3d4-0000-4000-8000-0000000000aa';
  return [200, { success: true, dry_run: body.dry_run === true, accepted: accepted.length, refused: refused.slice(0, 200),
    refused_count: refused.length, run_id: run,
    raw_s3_key: body.dry_run === true ? undefined : `s3://mock-raw/raw/feedback_form/import/${item.form_id}/${run}.${body.file?.format ?? 'csv'}` }];
}
