/**
 * Argument schema of `draft_feedback_form` (`forms` pack; docs/feedback-forms.md "AI drafts"): `{form, notes?,
 * warnings?, channel?}`, a feedback form in schema version 2 that the assistant drafts for the person with its notes
 * and warnings (each a sentence, or `{message, target?}` naming a question or ending id) and where it is meant to run,
 * shown on an approval card they edit (its name, a question left out) before Approve creates it Off
 * (`POST /feedback-forms` with `enabled: false`); the SPA's card reads the same shape
 * (frontend/src/assistant/approvals/formSchemas.ts). The route runs
 * the one validator (lambda/shared/forms_v2.py `validate_definition`), so this schema checks the shape, the
 * types, the id patterns and the limits a card can show problems for, and leaves the rest to the server.
 *
 * Bounds are lambda/shared/forms_v2.py's (form-draft.test.ts pins them). Browser-safe (zod only): the SPA's approval
 * boundary imports it through `@stream`.
 */
import { z } from 'zod';

export const FORM_DRAFT_LIMITS = {
  maxQuestions: 30, maxOptions: 50, maxRules: 20, maxHiddenFields: 20, maxEndings: 5,
  maxNameChars: 200, maxHeadlineChars: 500, maxLongTextChars: 2000, maxNotes: 10, maxNoteChars: 300,
} as const;

/** The app's nine locales (lambda/shared/forms_v2.py FORM_LOCALES). */
export const FORM_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl'] as const;
/** Where a form is meant to run (the AI draft route's `channel`). */
export const FORM_CHANNELS = ['link', 'embed', 'in_app'] as const;
const QUESTION_TYPES = [
  'open_text', 'single_select', 'multi_select', 'rating', 'nps', 'csat', 'ces', 'statement', 'consent', 'contact_info',
] as const;
const OPS = ['equals', 'not_equals', 'includes_any', 'includes_all', 'lt', 'lte', 'gt', 'gte', 'submitted', 'skipped'] as const;

const QUESTION_ID = /^q_[a-z0-9_]{1,40}$/;
const ENDING_ID = /^end_[a-z0-9_]{1,40}$/;
const OPTION_CODE = /^[a-z0-9_]{1,40}$/;
const HIDDEN_ID = /^[a-z][a-z0-9_]{0,39}$/;

const locale = z.enum(FORM_LOCALES);
const i18n = (max: number) => z.partialRecord(locale, z.string().max(max));
/** An https address (the server also refuses a user name, a password and control characters). */
const httpsUrl = z.string().max(2048).regex(/^https:\/\/[^\s/]+/, 'an https:// address');

const rule = z.strictObject({
  when: z.strictObject({ op: z.enum(OPS), value: z.union([z.string(), z.number(), z.array(z.string())]).optional() }),
  then: z.strictObject({ jump_to: z.string().max(44) }),
});

const option = z.strictObject({
  code: z.string().regex(OPTION_CODE),
  label: i18n(200),
  category: z.strictObject({ category: z.string().min(1).max(128), subcategory: z.string().max(128).optional() })
    .optional(),
});

/** One question: the common fields strictly, the per-type ones by name (the server refuses those of another type). */
const question = z.strictObject({
  id: z.string().regex(QUESTION_ID),
  type: z.enum(QUESTION_TYPES),
  headline: i18n(FORM_DRAFT_LIMITS.maxHeadlineChars),
  subheader: i18n(FORM_DRAFT_LIMITS.maxLongTextChars).optional(),
  required: z.boolean(),
  button_label: i18n(80).optional(),
  logic: z.array(rule).max(FORM_DRAFT_LIMITS.maxRules).optional(),
  long: z.boolean().optional(),
  input_type: z.enum(['text', 'email', 'number', 'phone', 'url']).optional(),
  placeholder: i18n(200).optional(),
  max_chars: z.number().int().min(1).max(5000).optional(),
  options: z.array(option).min(1).max(FORM_DRAFT_LIMITS.maxOptions).optional(),
  other: z.strictObject({ enabled: z.boolean(), label: i18n(200).optional(), placeholder: i18n(200).optional() }).optional(),
  none: z.strictObject({ enabled: z.boolean(), label: i18n(200).optional() }).optional(),
  shuffle: z.enum(['none', 'all', 'except_last']).optional(),
  display: z.enum(['auto', 'list', 'dropdown', 'chips']).optional(),
  min: z.number().int().min(1).optional(),
  max: z.number().int().min(1).optional(),
  scale: z.enum(['star', 'number', 'smiley']).optional(),
  range: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(7), z.literal(10)]).optional(),
  lower_label: i18n(200).optional(),
  upper_label: i18n(200).optional(),
  cta: z.strictObject({ label: i18n(80), url: httpsUrl.optional() }).optional(),
  label: i18n(FORM_DRAFT_LIMITS.maxLongTextChars).optional(),
  fields: z.partialRecord(z.enum(['name', 'email', 'phone', 'company']),
    z.strictObject({ show: z.boolean(), required: z.boolean() })).optional(),
});

const ending = z.strictObject({
  id: z.string().regex(ENDING_ID),
  title: i18n(FORM_DRAFT_LIMITS.maxHeadlineChars),
  description: i18n(FORM_DRAFT_LIMITS.maxLongTextChars).optional(),
  button: z.strictObject({ label: i18n(80), url: httpsUrl }).optional(),
});

/** Every question and ending id once, every rule's target an existing LATER question or an ending. */
function checkIds(args: { questions: Array<{ id: string; logic?: Array<{ then: { jump_to: string } }> }>;
  endings: Array<{ id: string }> }, ctx: z.RefinementCtx): void {
  const position = new Map(args.questions.map((q, index) => [q.id, index]));
  const endings = new Set(args.endings.map((e) => e.id));
  if (position.size !== args.questions.length) ctx.addIssue({ code: 'custom', message: 'a question id is used twice' });
  if (endings.size !== args.endings.length) ctx.addIssue({ code: 'custom', message: 'an ending id is used twice' });
  for (const [index, q] of args.questions.entries()) {
    for (const r of q.logic ?? []) {
      const target = position.get(r.then.jump_to);
      if (!(endings.has(r.then.jump_to) || (target !== undefined && target > index))) {
        ctx.addIssue({ code: 'custom', path: ['questions', index, 'logic'],
          message: `a rule of ${q.id} must jump to a later question or an ending` });
      }
    }
  }
}

/** The form itself: what `POST /feedback-forms` creates (Off). */
const draftForm = z.strictObject({
  name: z.string().trim().min(1).max(FORM_DRAFT_LIMITS.maxNameChars),
  language: locale,
  languages: z.array(locale).min(1).max(FORM_LOCALES.length).optional(),
  welcome: z.strictObject({
    enabled: z.boolean(), title: i18n(FORM_DRAFT_LIMITS.maxHeadlineChars).optional(),
    description: i18n(FORM_DRAFT_LIMITS.maxLongTextChars).optional(), button_label: i18n(80).optional(),
  }).optional(),
  questions: z.array(question).min(1).max(FORM_DRAFT_LIMITS.maxQuestions),
  hidden_fields: z.array(z.strictObject({ id: z.string().regex(HIDDEN_ID), label: z.string().max(64).optional() }))
    .max(FORM_DRAFT_LIMITS.maxHiddenFields).optional(),
  endings: z.array(ending).min(1).max(FORM_DRAFT_LIMITS.maxEndings),
}).superRefine(checkIds);

/** A note or warning of the model's: a sentence, or one naming the question or ending (`target`) it is about. */
const note = z.union([
  z.string().trim().min(1).max(FORM_DRAFT_LIMITS.maxNoteChars),
  z.strictObject({ message: z.string().trim().min(1).max(FORM_DRAFT_LIMITS.maxNoteChars), target: z.string().max(64).optional() }),
]);
const notes = z.array(note).max(FORM_DRAFT_LIMITS.maxNotes).optional();

export const draftFeedbackFormArgsSchema = z.strictObject({
  form: draftForm,
  notes,
  warnings: notes,
  channel: z.enum(FORM_CHANNELS).optional(),
});
