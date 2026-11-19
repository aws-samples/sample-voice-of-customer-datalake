/**
 * @fileoverview The Approve of a `draft_feedback_form` card (UX §12.5): it creates the form the card shows, as the
 * person edited it (shown.ts `feedbackFormDraft`), through the forms route with the person's own session, always Off
 * (nothing is public until someone publishes it in the builder). It creates nothing when the card had no form that
 * could be created yet.
 *
 * @module assistant/approvals/formExecutors
 */
import { z } from 'zod'
import { feedbackFormsV2Api } from '../../api/feedbackFormsV2Api'
import { builderPath } from '../../pages/FeedbackForms/builder/builderPaths'
import { keysFor, refreshAfterWrite } from './invalidation'
import { StaleApprovalError, shownOf } from './shown'
import type { DraftFeedbackFormArgs } from './formSchemas'
import type { ResultLink, WriteToolExecutionContext } from '../types'

export const FORM_NOT_SHOWN_MESSAGE = 'The card had no form that could be created yet; nothing was created. '
  + 'Propose draft_feedback_form again.'

export async function createDraftedForm(_args: DraftFeedbackFormArgs, ctx: WriteToolExecutionContext) {
  // (the card's edited form, never the model's: the person may have renamed it or left questions out)
  const shown = shownOf(ctx)?.feedbackFormDraft
  if (shown === undefined) throw new StaleApprovalError(FORM_NOT_SHOWN_MESSAGE)
  const { form, meta } = await feedbackFormsV2Api.createForm({ ...shown.form, enabled: false })
  refreshAfterWrite(ctx, keysFor.feedbackForms())
  return {
    summary: `Created the feedback form “${form.name}” (${meta.form_id}), Off, with ${String(form.questions.length)} `
      + `question${form.questions.length === 1 ? '' : 's'} and ${String(form.endings.length)} ending`
      + `${form.endings.length === 1 ? '' : 's'}. Nobody can answer it until someone publishes it in the form builder.`,
    data: { form_id: meta.form_id, name: form.name },
  }
}

const createdData = z.object({ form_id: z.string().min(1) })

/** The resolved card's link: the new form's Questions in the builder (none until it is created). */
export function draftedFormLink(_args: DraftFeedbackFormArgs, data?: unknown): ResultLink | undefined {
  const created = createdData.safeParse(data)
  return created.success ? { to: builderPath(created.data.form_id, 'questions'), labelKey: 'assistantTools:card.openForm' } : undefined
}
