/**
 * `draft_feedback_form` (`forms` pack; docs/feedback-forms.md "AI drafts"): a feedback form the assistant drafts
 * for what the person describes, in schema version 2. Saved only through its approval card, which the person edits:
 * the card shows the questions, endings and hidden fields, lets the person rename the form or leave a question out
 * (the rules that went to it dropped with it), holds Approve until every suggested address is checked,
 * and its Approve creates the form OFF (`POST /feedback-forms`, `enabled: false`): nothing is public until they
 * publish it. "Open in builder" opens the card's draft, unsaved, instead.
 *
 * A CARD_ONLY_WRITE_TOOLS entry (plan/schema.ts): the person edits the draft on the card, so a plan never names it.
 * The create route validates the whole form (lambda/shared/forms_v2.py); the schema here checks what a card can show.
 */
import type { ClientToolDefinition } from '../../types.js';
import type { JsonSchemaProperties } from '../spec.js';
import { defineClientTool, q } from './define.js';
import { FORM_CHANNELS, FORM_DRAFT_LIMITS as L, FORM_LOCALES, draftFeedbackFormArgsSchema } from './form-draft-schemas.js';

const amountOf = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const texts = 'texts are objects keyed by locale, e.g. {"pl": "…"}, the primary language\'s required';
const note: JsonSchemaProperties[string] = {
  anyOf: [{ type: 'string', maxLength: L.maxNoteChars },
    { type: 'object', properties: { message: { type: 'string', maxLength: L.maxNoteChars },
      target: { type: 'string', description: 'The question or ending id it is about.' } }, required: ['message'] }],
};

function draftFeedbackForm(): ClientToolDefinition {
  return defineClientTool({
    name: 'draft_feedback_form',
    pack: 'forms',
    description: 'Draft a feedback form for what the user describes (who it is for, what to learn, the answers to '
      + `offer): {form, notes?, warnings?, channel?}, the form in schema version 2; ${texts}. Short forms `
      + `(3-7 questions), one thing per question, choices before open text, a thank-you ending. Question types: `
      + `open_text {long, input_type, placeholder?}; single_select / multi_select {options: 1-${L.maxOptions} {code, label}, other?, none? (multi), display?, min?/max? (multi)}; `
      + 'rating {scale: star|number|smiley, range: 3|4|5|7|10}; nps; csat; ces; statement {cta?}; consent {label}; '
      + 'contact_info {fields: {name, email, phone, company}: {show, required}}. Ids: questions q_<words>, endings '
      + 'end_<words>, option codes snake_case ("other" and "none" are reserved). Logic: rules {when: {op, value?}, '
      + 'then: {jump_to: a LATER question id or an ending id}}, the first match wins. Addresses https only. The '
      + 'approval card lets the user rename it, leave questions out or open it in the form builder; approving creates '
      + 'it Off. After "executed", call list_feedback_forms: the result names it.',
    properties: {
      form: {
        type: 'object', description: 'The form (no `enabled`: approving creates it Off).',
        properties: {
          name: { type: 'string', maxLength: L.maxNameChars, description: 'The form\'s internal name.' },
          language: { type: 'string', enum: [...FORM_LOCALES], description: 'The primary language.' },
          languages: { type: 'array', items: { type: 'string', enum: [...FORM_LOCALES] },
            description: 'The primary plus any translations.' },
          welcome: { type: 'object', description: '{enabled, title?, description?, button_label?} (no welcome in an app).' },
          questions: { type: 'array', minItems: 1, maxItems: L.maxQuestions, items: { type: 'object' },
            description: '{id, type, headline, subheader?, required, button_label?, logic?, ...the type\'s fields}.' },
          hidden_fields: {
            type: 'array', maxItems: L.maxHiddenFields, description: 'Values the link or the app passes in (no personal data).',
            items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id'] },
          },
          endings: { type: 'array', minItems: 1, maxItems: L.maxEndings, items: { type: 'object' },
            description: '{id, title, description?, button?: {label, url (https)}}.' },
        },
        required: ['name', 'language', 'questions', 'endings'],
      },
      notes: { type: 'array', maxItems: L.maxNotes, items: note,
        description: 'One short sentence per choice worth telling the user.' },
      warnings: { type: 'array', maxItems: L.maxNotes, items: note,
        description: 'What the user must check before publishing (an address, a translation left out).' },
      channel: { type: 'string', enum: [...FORM_CHANNELS], description: 'Where the form runs: a link, an embed or in an app.' },
    },
    required: ['form'],
    schema: draftFeedbackFormArgsSchema,
    summarize: ({ form }) => `Create the feedback form ${q(form.name)} (Off): ${amountOf(form.questions.length, 'question', 'questions')}, `
      + `${amountOf(form.endings.length, 'ending', 'endings')}, ${amountOf(form.hidden_fields?.length ?? 0, 'hidden field', 'hidden fields')}.`,
  });
}

export function createFormDraftClientTools(): ClientToolDefinition[] {
  return [draftFeedbackForm()];
}
