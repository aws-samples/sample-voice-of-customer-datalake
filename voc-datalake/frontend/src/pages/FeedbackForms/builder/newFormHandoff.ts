/**
 * @fileoverview How an unsaved new form reaches the builder (UX §2.1, D11): the picker (a template, or "Describe your
 * form") and the assistant's approval card ("Open in builder") navigate to `/feedback-forms/new/questions` with the
 * form in the history entry's state. Nothing is saved until the builder's first Save; a reload keeps the draft
 * (the state lives with the history entry), and a `/feedback-forms/new/<tab>` reached without one opens the picker.
 *
 * @module pages/FeedbackForms/builder/newFormHandoff
 */
import { z } from 'zod'
import type { DraftNote } from '../../../api/feedbackFormsV2Api'
import type { Channel, FormV2 } from '../model/formsV2'
import { CHANNELS } from '../model/formsV2'
import { parseFormV2, toWireForm } from '../model/formsV2Schema'
import type { ProblemLocation } from '../model/validateForm'

/** Where an AI draft came from, for the builder's AI banner and its markers (UX §12.3). */
interface AiDraftOrigin {
  readonly notes: readonly DraftNote[]
  readonly warnings: readonly DraftNote[]
  /** The description it was drafted from (Discard draft returns to the picker with it). */
  readonly description: string
  readonly channel: Channel
  /** The https addresses the AI suggested, still to be confirmed (an error until then). */
  readonly addresses: readonly ProblemLocation[]
}

export interface NewFormHandoff {
  readonly form: FormV2
  /** The template it was made from (Languages fills a new language from its catalogue). */
  readonly templateId: string | null
  readonly ai: AiDraftOrigin | null
}

const note = z.object({ message: z.string(), target: z.string().optional() })
const location = z.object({
  kind: z.enum(['question', 'ending', 'welcome', 'hidden', 'language', 'form']),
  id: z.string().optional(), field: z.string().optional(),
})
const handoff = z.object({
  newForm: z.object({
    form: z.unknown(),
    templateId: z.string().nullable().catch(null),
    ai: z.object({
      notes: z.array(note).catch([]),
      warnings: z.array(note).catch([]),
      description: z.string().catch(''),
      channel: z.enum(CHANNELS).catch('link'),
      addresses: z.array(location).catch([]),
    }).nullable().catch(null),
  }),
})

/** The history state that carries `form` to the builder. */
export function handoffState(value: NewFormHandoff): { newForm: unknown } {
  return { newForm: { ...value, form: toWireForm(value.form) } }
}

/** The new form a history entry carries, or null (none, or not one this app wrote). */
export function readHandoff(state: unknown): NewFormHandoff | null {
  const parsed = handoff.safeParse(state)
  if (!parsed.success) return null
  const form = parseFormV2(parsed.data.newForm.form)
  return form === null ? null : { form: { ...form, enabled: false }, templateId: parsed.data.newForm.templateId, ai: parsed.data.newForm.ai }
}
