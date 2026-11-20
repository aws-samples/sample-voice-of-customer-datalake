/**
 * draft_feedback_form (docs/feedback-forms.md "AI drafts"): its schema (a schema version 2 form, the bounds pinned
 * against lambda/shared/forms_v2.py), its summary, and its gating: the `forms` pack, card-only, never a plan step,
 * open to every caller (the create route is the gate: a workspace's editors and admins).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, CLIENT_TOOLS } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { clientToolLookup, fakeContext } from '../test-fixtures.js';
import { FORM_DRAFT_LIMITS, FORM_LOCALES, RESERVED_HIDDEN_IDS, draftFeedbackFormArgsSchema } from './form-draft-schemas.js';

const PYTHON = readFileSync(join(__dirname, '../../../../../shared/forms_v2.py'), 'utf8');
const pythonInt = (name: string) => Number(new RegExp(`^${name}: Final = ([\\d_]+)`, 'm').exec(PYTHON)?.[1]?.replaceAll('_', ''));
const page = fakeContext('feedback-forms');

const FORM = {
  name: 'Powrót do starego interfejsu', language: 'pl', languages: ['pl'],
  questions: [
    { id: 'q_reason', type: 'single_select', headline: { pl: 'Dlaczego?' }, required: true,
      options: [{ code: 'missing', label: { pl: 'Brakuje funkcji' } }, { code: 'slow', label: { pl: 'Wolniej' } }],
      other: { enabled: true }, logic: [{ when: { op: 'equals', value: 'missing' }, then: { jump_to: 'q_which' } }] },
    { id: 'q_which', type: 'open_text', headline: { pl: 'Której funkcji?' }, required: false, long: false },
  ],
  hidden_fields: [{ id: 'app_version', label: 'App version' }],
  endings: [{ id: 'end_thanks', title: { pl: 'Dziękujemy' }, button: { label: { pl: 'Pomoc' }, url: 'https://example.com/pomoc' } }],
};
const ARGS = {
  form: FORM, notes: ['Reasons first, then one follow-up.'],
  warnings: [{ message: 'Check the help address.', target: 'end_thanks' }], channel: 'in_app',
};

describe('the bounds the form route holds (lambda/shared/forms_v2.py)', () => {
  it.each([
    ['maxQuestions', 'MAX_QUESTIONS'], ['maxOptions', 'MAX_OPTIONS'], ['maxRules', 'MAX_RULES'],
    ['maxHiddenFields', 'MAX_HIDDEN_FIELDS'], ['maxEndings', 'MAX_ENDINGS'], ['maxHeadlineChars', 'HEADLINE_CHARS'],
    ['maxLongTextChars', 'LONG_TEXT_CHARS'],
  ] as const)('%s is %s', (ours, theirs) => {
    expect(FORM_DRAFT_LIMITS[ours]).toBe(pythonInt(theirs));
  });

  it('refuses the hidden-field names the server reserves', () => {
    const reserved = /^RESERVED_HIDDEN_IDS: Final = frozenset\(\{([^}]*)\}\)/m.exec(PYTHON)?.[1] ?? '';
    expect(new Set(RESERVED_HIDDEN_IDS)).toStrictEqual(new Set([...reserved.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])));
  });

  it('offers the nine locales the server knows', () => {
    const locales = /^FORM_LOCALES: Final = \(([^)]*)\)/m.exec(PYTHON)?.[1] ?? '';
    expect([...FORM_LOCALES]).toStrictEqual([...locales.matchAll(/'([a-z]{2})'/g)].map((match) => match[1]));
  });
});

describe('draft_feedback_form arguments', () => {
  const tool = clientToolLookup()('draft_feedback_form');

  it('accepts {form, notes?, warnings?, channel?} (the SPA card\'s shape) and summarizes what Approve creates', async () => {
    const result = await tool.validate(ARGS, page);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await tool.validate({ form: FORM }, page)).ok).toBe(true);
    expect(tool.summarize(draftFeedbackFormArgsSchema.parse(ARGS)))
      .toBe("Create the feedback form 'Powrót do starego interfejsu' (Off): 2 questions, 1 ending, 1 hidden field.");
  });

  it.each([
    ['the form at the top level', FORM],
    ['an unknown top-level field', { ...ARGS, enabled: true }],
    ['a channel the route has not', { ...ARGS, channel: 'email' }],
    ['an empty note', { ...ARGS, notes: [''] }],
    ['a warning without its message', { ...ARGS, warnings: [{ target: 'end_thanks' }] }],
  ])('refuses %s', async (_what, args) => {
    expect((await tool.validate(args, page)).ok).toBe(false);
  });

  it.each([
    ['an unknown field', { ...FORM, enabled: true }],
    ['an http address', { ...FORM, endings: [{ ...FORM.endings[0], button: { label: { pl: 'x' }, url: 'http://x.example' } }] }],
    ['a question id of another shape', { ...FORM, questions: [{ ...FORM.questions[1], id: 'Which' }] }],
    ['an option code with a space', { ...FORM, questions: [{ ...FORM.questions[0], options: [{ code: 'a b', label: { pl: 'x' } }] }] }],
    ['a backward jump', { ...FORM, questions: [FORM.questions[1], FORM.questions[0]] }],
    ['a jump to nowhere', { ...FORM, questions: [{ ...FORM.questions[0], logic: [{ when: { op: 'submitted' }, then: { jump_to: 'q_gone' } }] }, FORM.questions[1]] }],
    ['a question id used twice', { ...FORM, questions: [FORM.questions[1], FORM.questions[1]] }],
    ['no ending', { ...FORM, endings: [] }],
    ['31 questions', { ...FORM, questions: Array.from({ length: 31 }, (_, n) => ({ ...FORM.questions[1], id: `q_${n}` })) }],
    ['a locale the app has not', { ...FORM, language: 'it' }],
  ])('refuses a form with %s', async (_what, form) => {
    const result = await tool.validate({ ...ARGS, form }, page);
    expect(result.ok).toBe(false);
  });

  it.each(RESERVED_HIDDEN_IDS)('refuses the reserved hidden field %s, as the form route does', async (id) => {
    expect((await tool.validate({ ...ARGS, form: { ...FORM, hidden_fields: [{ id }] } }, page)).ok).toBe(false);
    expect((await tool.validate({ ...ARGS, form: { ...FORM, hidden_fields: [{ id: `${id.replaceAll('_', '')}_field` }] } }, page)).ok).toBe(true);
  });

  it('is a forms write any caller may propose, only on its card, never in a plan', () => {
    expect(CLIENT_TOOLS.forms).toContain('draft_feedback_form');
    expect(ADMIN_ONLY_CLIENT_TOOLS).not.toContain('draft_feedback_form');
    expect(CARD_ONLY_WRITE_TOOLS).toContain('draft_feedback_form');
    expect(planWriteTools('forms')).not.toContain('draft_feedback_form');
  });
});
