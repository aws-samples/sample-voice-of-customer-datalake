/**
 * @fileoverview What the picker's two ways do (UX §2.1, §12.1): "Use this template" and a successful "Draft it" both
 * open the builder with an unsaved new form (`/feedback-forms/new/questions`, the form in the history state). Using a
 * template while the AI drafts asks first, then cancels the draft.
 *
 * @module pages/FeedbackForms/picker/usePickerActions
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FormLanguage } from '../model/formsV2'
import type { TemplateFlow } from '../templates/templateKit'
import { builderPath } from '../builder/builderPaths'
import { handoffState } from '../builder/newFormHandoff'
import type { NewFormHandoff } from '../builder/newFormHandoff'
import { draftAddresses } from '../ai/aiAddresses'
import { onBrand, useSavedFormBrand } from '../theme/useFormBrand'
import type { AiDraftRequest } from '../ai/useAiDraftRequest'
import type { CreateInCopy } from './useCreateInCopy'
import type { DescribeSubmit } from './DescribePanel'

export interface PickerActions {
  /** "Use this template" asked while drafting: the confirm is open. */
  readonly stopDraft: boolean
  readonly use: () => void
  readonly draft: (submit: DescribeSubmit) => void
  readonly confirmStop: () => void
  readonly cancelStop: () => void
}

export function usePickerActions({ flow, copy, language, request }: Readonly<{
  flow: TemplateFlow | null
  copy: CreateInCopy
  language: FormLanguage
  request: AiDraftRequest
}>): PickerActions {
  const navigate = useNavigate()
  const [stopDraft, setStopDraft] = useState(false)
  // A new form starts on the workspace's form brand when one is saved (templates and AI drafts carry the default).
  const brand = useSavedFormBrand()
  const openBuilder = (handoff: NewFormHandoff) => {
    void navigate(builderPath(null, 'questions'), { state: handoffState({ ...handoff, form: onBrand(handoff.form, brand) }) })
  }
  const open = (picked: TemplateFlow) => openBuilder({ form: copy.formOf(picked), templateId: picked.id, ai: null })
  const draft = async ({ description, channel }: DescribeSubmit) => {
    const answer = await request.run({ description, language, channel })
    if (answer === null) return
    openBuilder({
      form: answer.form, templateId: null,
      ai: { notes: answer.notes, warnings: answer.warnings, description, channel, addresses: draftAddresses(answer.form) },
    })
  }
  return {
    stopDraft,
    use: () => {
      if (flow === null || !copy.ready) return
      if (request.busy) setStopDraft(true)
      else open(flow)
    },
    draft: (submit) => { void draft(submit) },
    confirmStop: () => {
      request.cancel()
      setStopDraft(false)
      if (flow !== null) open(flow)
    },
    cancelStop: () => setStopDraft(false),
  }
}
