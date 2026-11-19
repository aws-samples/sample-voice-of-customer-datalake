/**
 * @fileoverview Step 1 of "Improve with AI" (UX §12.2): the instruction, its "Try" examples (and "Improve question N"
 * when a question is selected), what may change, and what the AI reads; while it drafts, the status line; when it
 * can't, why (§12.4).
 *
 * @module pages/FeedbackForms/ai/ImproveInstruction
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useDraft } from '../builder/formDraftContext'
import { LIMITS } from '../model/formsV2'
import AiRefusalNotice from './AiRefusalNotice'
import type { AiDraftRequest } from './useAiDraftRequest'

/** The "Try" instructions' keys, literal so the i18n audit sees them. */
const EXAMPLES = [
  'ai.improve.examples.translations', 'ai.improve.examples.shorter', 'ai.improve.examples.contact',
  'ai.improve.examples.hidden', 'ai.improve.examples.dropdown',
] as const

export default function ImproveInstruction({ instruction, onInstruction, empty, request, selected, onRetry }: Readonly<{
  instruction: string
  onInstruction: (value: string) => void
  /** Draft changes was pressed with no instruction. */
  empty: boolean
  request: AiDraftRequest
  /** The selected question's number, when one is selected. */
  selected: number | null
  onRetry: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const id = useId()
  const examples = [...EXAMPLES.map((key) => t(key)), ...(selected === null ? [] : [t('ai.improve.examples.question', { number: selected })])]
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium text-text">{t('ai.improve.instruction')}</label>
        <textarea id={id} className="input min-h-[4.5rem] max-h-48 resize-y" rows={3} value={instruction} maxLength={LIMITS.describeChars}
          readOnly={request.busy} aria-invalid={empty} aria-describedby={empty ? `${id}-empty` : undefined}
          onChange={(event) => { onInstruction(event.target.value); request.clear() }} />
        {empty && <p id={`${id}-empty`} className="text-[12px] text-danger">{t('ai.improve.emptyInstruction')}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">{t('ai.improve.try')}</span>
        {examples.map((example) => (
          <button key={example} type="button" className="btn btn-secondary btn-sm" disabled={request.busy} onClick={() => onInstruction(example)}>{example}</button>
        ))}
      </div>
      <p className="text-[12px] text-muted">{t('ai.improve.scope')}</p>
      <p className="text-[12px] text-muted">{t('ai.improve.reads', {
        questions: t('ai.improve.questionsCount', { count: draft.form.questions.length }),
        endings: t('ai.improve.endingsCount', { count: draft.form.endings.length }),
      })}</p>
      {request.busy && <p role="status" className="text-[13px] text-muted">{t('ai.improve.drafting')}</p>}
      {request.refusal !== null && <AiRefusalNotice refusal={request.refusal} waitMinutes={request.waitMinutes} onRetry={onRetry} />}
    </div>
  )
}
