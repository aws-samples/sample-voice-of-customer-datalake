/**
 * @fileoverview The question editor's header (UX §3.4, §4.7): "1 · Multiple choice ▾" (the type select offers only
 * the conversions that keep the content, and asks first when one drops something), Duplicate, and ⋯ (Move up,
 * Move down, Delete…).
 *
 * @module pages/FeedbackForms/questions/EditorHeader
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import type { Question, QuestionType } from '../model/formsV2'
import { LIMITS } from '../model/formsV2'
import { convertQuestion, convertibleTypes } from '../model/defaults'
import type { Converted } from '../model/defaults'
import { updateQuestion } from '../model/mutations'
import { useDraft } from '../builder/formDraftContext'
import ActionsMenu from '../ui/ActionsMenu'
import TypeChip from '../ui/TypeChip'
import { typeNameKey } from '../ui/typeIcons'
import { useRequestedFocus } from './focusRequest'
import { useListActions } from './useListActions'

function TypeSelect({ question, index, onConvert }: Readonly<{ question: Question; index: number; onConvert: (type: QuestionType) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const select = useRequestedFocus<HTMLSelectElement>(`type:${question.id}`)
  const types = convertibleTypes(question)
  if (types.length === 0) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] tabular-nums text-muted">{index + 1}</span>
        <TypeChip question={question} />
        <span className="text-[12px] text-muted">{t('typeChange.none')}</span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <label htmlFor={id} className="font-mono text-[13px] tabular-nums text-muted">
        {index + 1}<span className="sr-only">{t('typeChange.label', { number: index + 1 })}</span>
      </label>
      <select ref={select} id={id} className="select select-sm w-auto" value={question.type}
        onChange={(event) => {
          const type = types.find((candidate) => candidate === event.target.value)
          if (type !== undefined) onConvert(type)
        }}>
        <option value={question.type}>{t(typeNameKey(question))}</option>
        {types.map((type) => <option key={type} value={type}>{t(`types.${type}.name`)}</option>)}
      </select>
    </span>
  )
}

export default function EditorHeader({ question, index }: Readonly<{ question: Question; index: number }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const actions = useListActions()
  const [pending, setPending] = useState<Converted | null>(null)
  const total = draft.form.questions.length
  const apply = (converted: Converted) => draft.update((form) => updateQuestion(form, question.id, () => converted.question))
  const convert = (type: QuestionType) => {
    const converted = convertQuestion(question, type)
    if (converted === null) return
    if (converted.lost.length > 0) setPending(converted)
    else apply(converted)
  }
  const duplicate = t('question.duplicate', { number: index + 1 })
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <TypeSelect question={question} index={index} onConvert={convert} />
      <div className="flex items-center gap-1">
        <Tooltip kind="label" content={duplicate}>
          <button type="button" className="icon-btn" aria-label={duplicate} aria-disabled={total >= LIMITS.questions ? true : undefined}
            onClick={() => { if (total < LIMITS.questions) actions.duplicate(question.id) }}>
            <Copy size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        <ActionsMenu label={t('questionList.cardMenu', { number: index + 1 })} items={[
          { label: t('questionList.moveUp'), icon: ArrowUp, onSelect: () => actions.move(question.id, index - 1), disabledReason: index === 0 ? t('questionList.alreadyFirst') : undefined },
          { label: t('questionList.moveDown'), icon: ArrowDown, onSelect: () => actions.move(question.id, index + 1), disabledReason: index === total - 1 ? t('questionList.alreadyLast') : undefined },
          null,
          { label: t('questionList.delete'), icon: Trash2, danger: true, onSelect: () => actions.requestDelete('question', question.id), disabledReason: total <= 1 ? t('questionList.lastQuestion') : undefined },
        ]} />
      </div>
      <ConfirmModal isOpen={pending !== null} variant="warning" title={t('typeChange.confirmTitle')}
        message={t('typeChange.confirmMessage', { lost: (pending?.lost ?? []).map((part) => t(`typeChange.lost.${part}`)).join(' · ') })}
        confirmLabel={t('typeChange.confirm')} onConfirm={() => {
          if (pending !== null) apply(pending)
          setPending(null)
        }} onCancel={() => setPending(null)} />
      <ConfirmModal isOpen={actions.pending !== null} variant="danger" title={t('questionList.deleteTitle')}
        message={actions.pending === null ? '' : [
          actions.pending.rules > 0 ? t('questionList.deleteRules', { count: actions.pending.rules }) : '',
          actions.pending.answers ? t('questionList.deleteAnswers') : '',
        ].filter((part) => part !== '').join(' ')}
        confirmLabel={t('questionList.deleteConfirm')} onConfirm={actions.confirmDelete} onCancel={actions.cancelDelete} />
    </div>
  )
}
