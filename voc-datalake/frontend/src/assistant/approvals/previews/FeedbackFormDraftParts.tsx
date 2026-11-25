/**
 * @fileoverview The pieces of the `draft_feedback_form` card (UX §12.5): the question list with its "Leave out"
 * buttons, the endings and hidden fields, the model's notes and warnings, and the addresses to confirm.
 *
 * @module assistant/approvals/previews/FeedbackFormDraftParts
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Flag, GitBranch, Link2, Sparkles, X } from 'lucide-react'
import type { FormV2, Question } from '../../../pages/FeedbackForms/model/formsV2'
import { isChoice } from '../../../pages/FeedbackForms/model/formsV2'
import { headlineShown } from '../../../pages/FeedbackForms/model/recall'
import { splitOtherwise } from '../../../pages/FeedbackForms/model/rules'
import TypeChip from '../../../pages/FeedbackForms/ui/TypeChip'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import type { DraftNote } from '../../../api/feedbackFormsV2Api'
import type { SuggestedAddress } from '../formSchemas'

const K = 'preview.feedbackFormDraft'

/** How many rules a question has (its Otherwise counts as one). */
function ruleCount(question: Question): number {
  const { rules, otherwise } = splitOtherwise(question)
  return rules.length + (otherwise === null ? 0 : 1)
}

function QuestionMeta({ question }: Readonly<{ question: Question }>) {
  const { t } = useTranslation('assistantTools')
  const rules = ruleCount(question)
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[12px] text-muted">
      {isChoice(question) && <span>{t(`${K}.options`, { count: question.options.length })}</span>}
      {rules > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <GitBranch className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">{t(`${K}.rules`, { count: rules })}</span>
          <span aria-hidden="true">{rules}</span>
        </span>
      )}
    </span>
  )
}

export function QuestionRows({ form, onLeaveOut }: Readonly<{ form: FormV2; onLeaveOut: (index: number) => void }>) {
  const { t } = useTranslation('assistantTools')
  const last = form.questions.length <= 1
  return (
    <>
      <ol className="space-y-1" aria-label={t(`${K}.questions`)}>
        {form.questions.map((question, index) => {
          const label = t(`${K}.leaveOut`, { number: index + 1 })
          return (
            <li key={question.id} className="flex items-center gap-2 text-[13px]" data-testid={`draft-question-${String(index + 1)}`}>
              <span className="w-4 shrink-0 text-right font-mono text-[12px] text-muted">{index + 1}</span>
              <TypeChip question={question} />
              <TruncatedText as="span" className="min-w-0 flex-1 truncate text-text" text={headlineShown(question.headline, form.language)} />
              <QuestionMeta question={question} />
              <Tooltip kind="label" content={label}>
                <button type="button" className="icon-btn" aria-label={label} aria-disabled={last ? true : undefined}
                  onClick={() => { if (!last) onLeaveOut(index) }}>
                  <X size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ol>
      {last && <p className="text-[12px] text-muted">{t(`${K}.lastQuestion`)}</p>}
    </>
  )
}

export function EndingsAndFields({ form }: Readonly<{ form: FormV2 }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div className="space-y-1 text-[13px]">
      <ul aria-label={t(`${K}.endings`)} className="space-y-0.5">
        {form.endings.map((ending) => (
          <li key={ending.id} className="flex items-center gap-1.5 text-text">
            <Flag className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            <TruncatedText as="span" className="min-w-0 truncate" text={headlineShown(ending.title, form.language)} />
          </li>
        ))}
      </ul>
      {form.hidden_fields.length > 0 && (
        <ul aria-label={t(`${K}.hiddenFields`)} className="flex flex-wrap gap-1">
          {form.hidden_fields.map((field) => <li key={field.id} className="badge badge-muted font-mono">{field.id}</li>)}
        </ul>
      )}
    </div>
  )
}

export function ModelNotes({ notes, warnings }: Readonly<{ notes: readonly DraftNote[]; warnings: readonly DraftNote[] }>) {
  const { t } = useTranslation('assistantTools')
  if (notes.length === 0 && warnings.length === 0) return null
  return (
    <section aria-label={t(`${K}.fromAi`)} className="space-y-1 rounded-md border border-aim/30 bg-aim-subtle p-2 text-[12px] text-text">
      <p className="flex items-center gap-1 font-medium">
        <Sparkles className="h-3.5 w-3.5 text-aim" aria-hidden="true" />
        {t(`${K}.fromAi`)}
      </p>
      <ul className="space-y-0.5">
        {warnings.map((warning) => (
          <li key={`w-${warning.message}`} className="flex items-start gap-1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span><span className="sr-only">{t(`${K}.warning`)}: </span>{warning.message}</span>
          </li>
        ))}
        {notes.map((note) => <li key={`n-${note.message}`} className="pl-[1.125rem]">{note.message}</li>)}
      </ul>
    </section>
  )
}

function AddressRow({ address, checked, onCheck, onRemove }: Readonly<{
  address: SuggestedAddress; checked: boolean; onCheck: (checked: boolean) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('assistantTools')
  const id = useId()
  const remove = t(`${K}.removeAddress`, { url: address.url })
  return (
    <li className="space-y-1 rounded-md border border-border p-2">
      <p className="flex items-center gap-1.5 break-all font-mono text-[12px] text-text">
        <Link2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        {address.url}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-2 text-[12px] text-text">
          <input id={id} type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} />
          {t(`${K}.checkedAddress`)}
        </label>
        <button type="button" className="btn btn-ghost btn-sm" aria-label={remove} onClick={onRemove}>
          <X size={14} aria-hidden="true" /> {t(`${K}.remove`)}
        </button>
      </div>
    </li>
  )
}

export function AddressChecks({ addresses, checked, onCheck, onRemove }: Readonly<{
  addresses: readonly SuggestedAddress[]
  checked: ReadonlySet<string>
  onCheck: (key: string, checked: boolean) => void
  onRemove: (address: SuggestedAddress) => void
}>) {
  const { t } = useTranslation('assistantTools')
  if (addresses.length === 0) return null
  return (
    <section aria-label={t(`${K}.addresses`)} className="space-y-1">
      <p className="text-[12px] font-medium text-text-strong">{t(`${K}.addresses`)}</p>
      <ul className="space-y-1">
        {addresses.map((address) => (
          <AddressRow key={address.key} address={address} checked={checked.has(address.key)}
            onCheck={(next) => onCheck(address.key, next)} onRemove={() => onRemove(address)} />
        ))}
      </ul>
    </section>
  )
}
