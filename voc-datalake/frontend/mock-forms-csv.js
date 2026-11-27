// The responses' CSV in the familiar layout for the dev mock (lambda/shared/forms_v2_csv.py, docs/
// feedback-forms.md "Results and responses"): a UTF-8 BOM, one header row (Submission ID, Submitted On in UTC,
// Locale, Tags, the hidden fields by label, then one column per question by its headline with placeholders as
// `[id]`: a matrix one per row, a contact question one per field it shows), choices joined with `;`, and with
// `ids=true` a second header row of ids. The detailed layout is mock-forms-results.js `responsesCsv`.

import { csvField, questionHeadline, responseView, safe, textIn } from './mock-forms-results.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CONTACT_FIELDS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company']];
/** The widget's word for Other in each language (lambda/api/static/feedback-widget.js STRINGS `other`). */
const OTHER = { en: 'Other', es: 'Otro', fr: 'Autre', de: 'Sonstiges', pt: 'Outro', ja: 'その他', zh: '其他', ko: '기타', pl: 'Inne' };

/** One column of a question: its header, its id and how a response's answer reads in it. */
function columnsOf(question, primary) {
  const headline = questionHeadline(question, primary);
  if (question.type === 'matrix') {
    const labels = Object.fromEntries((question.columns ?? []).map((column) => [column.code, textIn(column.label, primary) || column.code]));
    return (question.rows ?? []).map((row) => ({
      header: `${headline} - ${textIn(row.label, primary) || row.code}`, id: `${question.id}.${row.code}`,
      read: (value) => (isPlainObject(value?.rows) && value.rows[row.code] ? labels[value.rows[row.code]] ?? value.rows[row.code] : ''),
    }));
  }
  if (question.type === 'contact_info') {
    return CONTACT_FIELDS.filter(([field]) => question.fields?.[field]?.show).map(([field, word]) => ({
      header: `${headline} - ${word}`, id: `${question.id}.${field}`, read: (value) => (isPlainObject(value) ? value[field] ?? '' : ''),
    }));
  }
  return [{ header: headline, id: question.id, read: (value) => answerCell(question, value, primary) }];
}

/** A choice by its labels joined with `;` (Other as `Other: …`), a consent `Yes`, anything else as it is. */
function answerCell(question, value, primary) {
  if (value === undefined || value === null || value === false) return '';
  if (value === true) return 'Yes';
  if (!isPlainObject(value)) return String(value);
  const labels = Object.fromEntries((question.options ?? []).map((option) => [option.code, textIn(option.label, primary) || option.code]));
  const other = textIn(question.other?.label, primary) || (OTHER[primary] ?? OTHER.en);
  const codes = [...(value.codes ?? []), ...(value.code === undefined ? [] : [value.code])];
  return [...codes.map((code) => labels[code] ?? code), ...(value.other ? [`${other}: ${value.other}`] : [])].join(';');
}

/** `2026-11-20T09:30:00Z`: the time in UTC, to the second. */
const utc = (time) => (Number.isNaN(Date.parse(time)) ? time : `${new Date(time).toISOString().slice(0, 19)}Z`);

/** GET …/responses?format=csv&layout=familiar[&ids=true]. */
export function familiarCsv(item, rows, withIds) {
  const primary = item.language ?? 'en';
  const hidden = item.hidden_fields ?? [];
  const columns = (item.questions ?? []).filter((question) => question.type !== 'statement').flatMap((question) => columnsOf(question, primary));
  const header = ['Submission ID', 'Submitted On', 'Locale', 'Tags', ...hidden.map((field) => field.label || field.id), ...columns.map((column) => column.header)];
  const ids = ['submission_id', 'submitted_on', 'locale', 'tags', ...hidden.map((field) => `hidden.${field.id}`), ...columns.map((column) => column.id)];
  const lines = [header, ...(withIds ? [ids] : []), ...rows.map((row) => {
    const view = responseView(row);
    const tags = [...(item.tags ?? []), ...(row.is_test ? ['test'] : [])].join(';');
    return [view.response_id, utc(view.created_at), view.language ?? '', tags, ...hidden.map((field) => row.hidden?.[field.id] ?? ''),
      ...columns.map((column) => column.read(row.answers[column.id.split('.')[0]]))];
  })];
  return `\uFEFF${lines.map((line) => line.map((value) => csvField(safe(String(value)))).join(',')).join('\r\n')}\r\n`;
}

const SPECIAL_FOLDS = { ł: 'l', Ł: 'l', ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', đ: 'd', Đ: 'd', ı: 'i', þ: 'th', ð: 'd' };

/** `<form-name-slug>-responses-<yyyy-mm-dd>.csv` as forms_v2_csv.py `_slug` makes it: the special letters folded too, and
 * no `-` left at the end of the 60-character cut (the form id when the name gives no slug). */
export function familiarFilename(item) {
  const folded = (item.name ?? '').replace(/[łŁßøØæÆœŒđĐıþð]/gu, (char) => SPECIAL_FOLDS[char] ?? char);
  const words = folded.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const slug = words.join('-').slice(0, 60).replace(/-+$/u, '');
  return `${slug || item.form_id}-responses-${new Date().toISOString().slice(0, 10)}.csv`;
}
