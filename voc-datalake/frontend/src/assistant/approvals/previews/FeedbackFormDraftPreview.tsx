/**
 * @fileoverview The `draft_feedback_form` card (UX §12.5): the form the assistant drafted, editable as far as the
 * `save_categories` pattern goes — its name, and leaving a question out (the rules that went to it go too, and the
 * card says so). Anything more is **Open in builder**: the form opens in the builder, unsaved, with the AI draft
 * banner, and the card is declined with the reason (so the assistant does not try again).
 *
 * Approve ("Approve and create") is held until the form has a name, every address the AI suggested is ticked "I've
 * checked this address" or removed, and the person may create forms (a workspace's admins and editors). What the
 * card shows when it is approved is what the executor creates (shown.ts `feedbackFormDraft`), always Off.
 *
 * @module assistant/approvals/previews/FeedbackFormDraftPreview
 */
import { useContext, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import type { FormV2 } from '../../../pages/FeedbackForms/model/formsV2'
import { removeQuestion } from '../../../pages/FeedbackForms/model/mutations'
import { splitOtherwise } from '../../../pages/FeedbackForms/model/rules'
import { builderPath } from '../../../pages/FeedbackForms/builder/builderPaths'
import { handoffState } from '../../../pages/FeedbackForms/builder/newFormHandoff'
import { onBrand, useSavedFormBrand } from '../../../pages/FeedbackForms/theme/useFormBrand'
import type { ProblemLocation } from '../../../pages/FeedbackForms/model/validateForm'
import { languageNames } from '../../../i18n/languages'
import { useCurrentWorkspace } from '../../../workspace/currentWorkspace'
import { ApprovalDeclineContext, ApprovalHoldContext, ShownContext, recordFeedbackFormDraft } from '../shown'
import { suggestedAddresses, withoutSuggestedAddress } from '../formSchemas'
import type { DraftFeedbackFormArgs, SuggestedAddress } from '../formSchemas'
import { CardNote } from './FieldDiff'
import { AddressChecks, EndingsAndFields, ModelNotes, QuestionRows } from './FeedbackFormDraftParts'

const K = 'preview.feedbackFormDraft'

/** The reason the card resolves with when the person opens the draft in the builder instead (the model reads it). */
export const OPENED_IN_BUILDER_REASON = 'Opened in the form builder to edit; not created.'

/** A question left out, as the card says it: its number, and the questions whose rules went to it. */
interface LeftOut {
  readonly number: number
  readonly rules: number
  readonly sources: readonly number[]
}

/** The numbers (from 1) of the questions with a rule (or Otherwise) to `target`, and how many such rules. */
function rulesInto(form: FormV2, target: string): { rules: number; sources: number[] } {
  const counts = form.questions.map((question) => {
    const { rules, otherwise } = splitOtherwise(question)
    return rules.filter((rule) => rule.then.jump_to === target).length + (otherwise === target ? 1 : 0)
  })
  return {
    rules: counts.reduce((sum, count) => sum + count, 0),
    sources: counts.flatMap((count, index) => (count > 0 ? [index + 1] : [])),
  }
}

const locationOf = (address: SuggestedAddress): ProblemLocation => (address.kind === 'ending'
  ? { kind: 'ending', id: address.id, field: 'button_url' }
  : { kind: 'question', id: address.id, field: 'cta_url' })

function Summary({ form, channel }: Readonly<{ form: FormV2; channel: DraftFeedbackFormArgs['channel'] }>) {
  const { t } = useTranslation('assistantTools')
  const parts = [
    languageNames[form.language],
    t(`${K}.channel.${channel}`),
    t(`${K}.questionCount`, { count: form.questions.length }),
    t(`${K}.endingCount`, { count: form.endings.length }),
    ...(form.hidden_fields.length === 0 ? [] : [t(`${K}.hiddenCount`, { count: form.hidden_fields.length })]),
  ]
  return <p className="text-[12px] text-muted">{parts.join(' · ')}</p>
}

function LeftOutLine({ leftOut }: Readonly<{ leftOut: LeftOut | null }>) {
  const { t } = useTranslation('assistantTools')
  if (leftOut === null) return <p role="status" className="sr-only" />
  const sentences = [
    t(`${K}.leftOut`, { number: leftOut.number }),
    ...(leftOut.rules === 0 ? [] : [t(`${K}.rulesDropped`, { count: leftOut.rules, questions: leftOut.sources.join(', ') })]),
  ]
  return <p role="status" className="text-[12px] text-text">{sentences.join(' ')}</p>
}

export function FeedbackFormDraftPreview({ args }: Readonly<{ args: DraftFeedbackFormArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const hold = useContext(ApprovalHoldContext)
  const decline = useContext(ApprovalDeclineContext)
  const navigate = useNavigate()
  const workspace = useCurrentWorkspace()
  const nameId = useId()
  const [form, setForm] = useState<FormV2>(args.form)
  // A new form starts on the workspace's form brand when one is saved, as a template or the picker's draft does.
  const brand = useSavedFormBrand()
  const branded = useMemo(() => onBrand(form, brand), [form, brand])
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [leftOut, setLeftOut] = useState<LeftOut | null>(null)
  // (a workspace's admins and editors; outside a workspace, whoever may open the forms page)
  const allowed = workspace?.role !== 'viewer'
  const addresses = useMemo(() => suggestedAddresses(form), [form])
  const unchecked = addresses.filter((address) => !checked.has(address.key))
  const named = form.name.trim() !== ''
  const ready = allowed && named && unchecked.length === 0

  // What Approve creates, recorded as the card shows it (the executor creates exactly this form, or nothing).
  useEffect(() => {
    if (shown !== null) recordFeedbackFormDraft(shown, ready ? { ...branded, name: branded.name.trim(), enabled: false } : undefined)
    hold(!ready)
  }, [shown, hold, ready, branded])

  const leaveOut = (index: number) => {
    const question = form.questions[index]
    if (question === undefined || form.questions.length <= 1) return
    setLeftOut({ number: index + 1, ...rulesInto(form, question.id) })
    setForm(removeQuestion(form, question.id))
  }
  const check = (key: string, next: boolean) => setChecked((current) => new Set(next
    ? [...current, key] : [...current].filter((entry) => entry !== key)))
  const openInBuilder = () => {
    const ai = { notes: args.notes, warnings: args.warnings, description: '', channel: args.channel, addresses: unchecked.map(locationOf) }
    void navigate(builderPath(null, 'questions'), { state: handoffState({ form: { ...branded, enabled: false }, templateId: null, ai }) })
    decline?.(OPENED_IN_BUILDER_REASON)
  }

  return (
    <div className="space-y-2" role="group" aria-label={t(`${K}.label`)}>
      <div className="space-y-1">
        <label htmlFor={nameId} className="block text-[12px] font-medium text-text">{t(`${K}.name`)}</label>
        <input id={nameId} className="input w-full" value={form.name} aria-invalid={!named}
          aria-describedby={named ? undefined : `${nameId}-hint`} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        {!named && <p id={`${nameId}-hint`} className="text-[12px] text-danger">{t(`${K}.nameMissing`)}</p>}
      </div>
      <Summary form={form} channel={args.channel} />
      <QuestionRows form={form} onLeaveOut={leaveOut} />
      <LeftOutLine leftOut={leftOut} />
      <EndingsAndFields form={form} />
      <ModelNotes notes={args.notes} warnings={args.warnings} />
      <AddressChecks addresses={addresses} checked={checked} onCheck={check}
        onRemove={(address) => setForm(withoutSuggestedAddress(form, address))} />
      {allowed
        ? <CardNote text={t(`${K}.createsOff`)} />
        : <p role="note" className="text-[12px] text-warn">{t(`${K}.notAllowed`)}</p>}
      {allowed && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={openInBuilder}>
          <ExternalLink size={14} aria-hidden="true" /> {t(`${K}.openInBuilder`)}
        </button>
      )}
    </div>
  )
}
