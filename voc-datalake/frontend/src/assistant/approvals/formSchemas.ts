/**
 * @fileoverview The SPA approval boundary of `draft_feedback_form` (7.55.00, UX §12.5): the form the assistant
 * drafted, which its card shows editable before Approve creates it, Off.
 *
 * The args are `{ form, notes?, warnings?, channel? }`: `form` is a forms-v2 form (the stream Lambda's tool has run
 * it through the forms_v2 validator already, contract "Describe it, and the AI builds the form"); `notes` and
 * `warnings` are the model's, each a string or `{message, target?}` (a question or ending id it names); `channel`
 * is where the form is meant to run. The form is re-read here leniently (`parseFormV2`) and checked with the
 * editor's own validator: a form that does not parse, or has a problem that blocks a save, is invalid (the card's
 * "the assistant's request is invalid" with the validator's words). Whatever the model sent, the form is Off.
 *
 * @module assistant/approvals/formSchemas
 */
import { z } from 'zod'
import i18n from 'i18next'
import { CHANNELS } from '../../pages/FeedbackForms/model/formsV2'
import type { FormV2 } from '../../pages/FeedbackForms/model/formsV2'
import { parseFormV2 } from '../../pages/FeedbackForms/model/formsV2Schema'
import { headlineShown } from '../../pages/FeedbackForms/model/recall'
import { blockingProblems, validateForm } from '../../pages/FeedbackForms/model/validateForm'
import type { FormProblem } from '../../pages/FeedbackForms/model/validateForm'
import type { DraftNote } from '../../api/feedbackFormsV2Api'
import { withoutAddress } from '../../pages/FeedbackForms/ai/aiAddresses'

export const DRAFT_FEEDBACK_FORM_TOOL = 'draft_feedback_form'

/** At most this many notes and warnings are kept from the model (a card is not a log). */
const MAX_NOTES = 20
const MAX_NOTE_CHARS = 500

const note = z.union([
  z.string().trim().min(1).max(MAX_NOTE_CHARS).transform((message): DraftNote => ({ message })),
  z.object({ message: z.string().trim().min(1).max(MAX_NOTE_CHARS), target: z.string().max(64).optional() })
    .transform((n): DraftNote => (n.target === undefined ? { message: n.message } : { message: n.message, target: n.target })),
])
const notes = z.array(note).max(MAX_NOTES).optional().transform((list): DraftNote[] => list ?? [])

/** Where a problem is, in words the card's Details list reads ("Q4", "Ending “Thank you”", a recall placeholder in an
 * ending's title as `[id]`, 7.71.04). */
function problemWhere(form: FormV2, problem: FormProblem): string {
  const { at } = problem
  if (at.kind === 'question') {
    const index = form.questions.findIndex((question) => question.id === at.id)
    return i18n.t('feedbackForms:problems.where.question', { number: index + 1 })
  }
  if (at.kind === 'ending') {
    const ending = form.endings.find((candidate) => candidate.id === at.id)
    return i18n.t('feedbackForms:problems.where.ending', { title: ending === undefined ? at.id ?? '' : headlineShown(ending.title, form.language) })
  }
  return i18n.t(`feedbackForms:problems.where.${at.kind}`, { id: at.id ?? '', language: at.id ?? '' })
}

/** A blocking problem as the card lists it: "Q4: Write the question." */
function draftProblemMessage(form: FormV2, problem: FormProblem): string {
  const key = `feedbackForms:problems.${problem.code}`
  return `${problemWhere(form, problem)}: ${i18n.t(key, problem.params)}`
}

export const draftFeedbackFormArgs = z.strictObject({
  form: z.unknown(),
  notes,
  warnings: notes,
  channel: z.enum(CHANNELS).optional(),
}).transform((args, ctx) => {
  const form = parseFormV2(args.form)
  if (form === null) {
    ctx.addIssue({ code: 'custom', path: ['form'], message: i18n.t('assistantTools:preview.feedbackFormDraft.notAForm') })
    return z.NEVER
  }
  const blocking = blockingProblems(validateForm(form))
  for (const problem of blocking) ctx.addIssue({ code: 'custom', path: ['form'], message: draftProblemMessage(form, problem) })
  if (blocking.length > 0) return z.NEVER
  return { form: { ...form, enabled: false }, notes: args.notes, warnings: args.warnings, channel: args.channel ?? 'link' }
})
export type DraftFeedbackFormArgs = z.infer<typeof draftFeedbackFormArgs>

/** An https address the AI suggested (an ending's button, a statement's link), which the card asks to confirm. */
export interface SuggestedAddress {
  /** `ending:<id>` or `question:<id>`: the address's owner, as the builder's problem location names it. */
  readonly key: string
  readonly kind: 'ending' | 'question'
  readonly id: string
  readonly url: string
}

/** Every address the form links to: its endings' buttons, then its statements' links, in form order. */
export function suggestedAddresses(form: FormV2): SuggestedAddress[] {
  const fromStatements = form.questions.flatMap((question): SuggestedAddress[] => {
    const url = question.type === 'statement' ? question.cta?.url ?? '' : ''
    return url === '' ? [] : [{ key: `question:${question.id}`, kind: 'question', id: question.id, url }]
  })
  const fromEndings = form.endings.flatMap((ending): SuggestedAddress[] => (ending.button === undefined ? []
    : [{ key: `ending:${ending.id}`, kind: 'ending', id: ending.id, url: ending.button.url }]))
  return [...fromEndings, ...fromStatements]
}

/** `form` without the address `address`, as the builder removes one (ai/aiAddresses.ts): an ending's button goes, a
 * statement's link button loses its address. */
export function withoutSuggestedAddress(form: FormV2, address: SuggestedAddress): FormV2 {
  return withoutAddress(form, { kind: address.kind, id: address.id, field: address.kind === 'ending' ? 'button_url' : 'cta_url' })
}
