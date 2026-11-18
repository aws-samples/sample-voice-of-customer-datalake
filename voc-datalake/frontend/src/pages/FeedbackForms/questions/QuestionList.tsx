/**
 * @fileoverview The Questions tab's list (UX §3.3): "Questions (N)" and Improve with AI, the welcome card row, the
 * question cards (`<ol aria-label="Questions">`, with an "Add question here" gap between cards on hover or focus),
 * Add question, then the endings (`<ul aria-label="Endings">`) and Add ending. Reorder by dragging the grip, by
 * Alt+Shift+↑/↓, or from the ⋯ menu; deletes that matter ask first.
 *
 * @module pages/FeedbackForms/questions/QuestionList
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Copy, ArrowDown, ArrowUp, Plus, Replace, Sparkles, Trash2 } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { LIMITS } from '../model/formsV2'
import { convertibleTypes } from '../model/defaults'
import { missingLanguagesOf } from '../model/translatable'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import type { MenuAction } from '../ui/ActionsMenu'
import QuestionCard from './QuestionCard'
import type { CardDrag } from './QuestionCard'
import EndingCard from './EndingCard'
import TypePicker from './TypePicker'
import { useListActions } from './useListActions'
import type { PendingDelete } from './useListActions'
import { requestFocus } from './focusRequest'

export type CardRef = { readonly kind: 'question' | 'ending' | 'welcome'; readonly id: string }

interface DragState {
  readonly kind: 'question' | 'ending'
  readonly from: number
  readonly over: number | null
}

function deleteMessage(t: (key: string, options?: Record<string, unknown>) => string, pending: PendingDelete): string {
  if (pending.kind === 'ending') return t('endings.deleteRules', { count: pending.rules })
  const parts = [pending.rules > 0 ? t('questionList.deleteRules', { count: pending.rules }) : null, pending.answers ? t('questionList.deleteAnswers') : null]
  return parts.filter((part) => part !== null).join(' ')
}

function useDrag(onDrop: (kind: 'question' | 'ending', from: number, to: number) => void) {
  const [drag, setDrag] = useState<DragState | null>(null)
  return (kind: 'question' | 'ending', index: number): CardDrag => ({
    onDragStart: () => setDrag({ kind, from: index, over: null }),
    onDragOver: () => setDrag((current) => (current?.kind === kind && current.over !== index ? { ...current, over: index } : current)),
    onDrop: () => {
      if (drag?.kind === kind && drag.from !== index) onDrop(kind, drag.from, index)
      setDrag(null)
    },
    onDragEnd: () => setDrag(null),
    over: drag?.kind === kind && drag.over === index && drag.from !== index,
  })
}

export default function QuestionList({ selected, onSelect }: Readonly<{ selected: CardRef | null; onSelect: (card: CardRef) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { openImprove } = useBuilderUi()
  const actions = useListActions()
  const { form } = draft
  const total = form.questions.length
  const full = total >= LIMITS.questions
  const hasContact = form.questions.some((q) => q.type === 'contact_info')
  const dragFor = useDrag((kind, from, to) => {
    const id = kind === 'question' ? form.questions[from]?.id : form.endings[from]?.id
    if (id === undefined) return
    if (kind === 'question') actions.move(id, to)
    else actions.moveEndingTo(id, to)
  })
  const errorsOf = (kind: 'question' | 'ending', id: string) => problemsAt(draft.problems, kind, id).some((p) => p.severity === 'error')
  const marked = (id: string) => draft.ai?.marked.has(id) ?? false

  const questionMenu = (index: number, id: string): (MenuAction | null)[] => {
    const question = form.questions[index]
    return [
      { label: t('questionList.duplicate'), icon: Copy, onSelect: () => actions.duplicate(id), disabledReason: full ? t('questionList.limit') : undefined },
      { label: t('questionList.moveUp'), icon: ArrowUp, onSelect: () => actions.move(id, index - 1), disabledReason: index === 0 ? t('questionList.alreadyFirst') : undefined },
      { label: t('questionList.moveDown'), icon: ArrowDown, onSelect: () => actions.move(id, index + 1), disabledReason: index === total - 1 ? t('questionList.alreadyLast') : undefined },
      {
        label: t('questionList.changeType'), icon: Replace,
        onSelect: () => { requestFocus(`type:${id}`); onSelect({ kind: 'question', id }) },
        disabledReason: question !== undefined && convertibleTypes(question).length === 0 ? t('typeChange.none') : undefined,
      },
      null,
      { label: t('questionList.delete'), icon: Trash2, danger: true, onSelect: () => actions.requestDelete('question', id), disabledReason: total <= 1 ? t('questionList.lastQuestion') : undefined },
    ]
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-text-strong">{t('questionList.title', { count: total })}</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={openImprove}>
          <Sparkles size={14} className="text-aim" aria-hidden="true" />{t('questionList.improve')}
        </button>
      </div>
      <button type="button" data-card-id="welcome" aria-current={selected?.kind === 'welcome' ? 'true' : undefined}
        onClick={() => onSelect({ kind: 'welcome', id: 'welcome' })}
        className={clsx('w-full rounded-lg border border-dashed px-3 py-2 text-left text-[13px] focus-ring',
          selected?.kind === 'welcome' ? 'border-accent bg-accent-subtle text-text' : 'border-border text-muted hover:bg-bg-hover')}>
        {form.welcome.enabled ? t('questionList.welcomeOn') : t('questionList.welcomeOff')}
      </button>
      <ol aria-label={t('questionList.label')} className="space-y-1">
        {form.questions.map((question, index) => (
          <QuestionCard key={question.id} question={question} index={index} total={total} language={form.language}
              gap={index > 0 && !full
                ? <TypePicker label={t('questionList.addHere')} variant="ghost" hasContact={hasContact} onPick={(type) => actions.addQuestion(type, index)} />
                : null}
              selected={selected?.kind === 'question' && selected.id === question.id}
              missing={missingLanguagesOf(form, question.id)} hasError={errorsOf('question', question.id)} aiMarked={marked(question.id)}
              onSelect={() => onSelect({ kind: 'question', id: question.id })} onMove={(to) => actions.move(question.id, to)}
              menu={questionMenu(index, question.id)} drag={dragFor('question', index)} />
        ))}
      </ol>
      <div>
        <TypePicker label={t('questionList.add')} hasContact={hasContact} disabled={full} onPick={(type) => actions.addQuestion(type)} className="w-full md:w-auto" />
        {full && <p className="mt-1 text-[12px] text-muted">{t('questionList.limit')}</p>}
      </div>
      <EndingsSection selected={selected} onSelect={onSelect} actions={actions} dragFor={dragFor} errorsOf={errorsOf} marked={marked} />
      <ConfirmModal isOpen={actions.pending !== null} variant="danger"
        title={actions.pending?.kind === 'ending' ? t('endings.deleteTitle') : t('questionList.deleteTitle')}
        message={actions.pending === null ? '' : deleteMessage(t, actions.pending)}
        confirmLabel={t('questionList.deleteConfirm')} onConfirm={actions.confirmDelete} onCancel={actions.cancelDelete} />
    </div>
  )
}

type ListActions = ReturnType<typeof useListActions>

function EndingsSection({ selected, onSelect, actions, dragFor, errorsOf, marked }: Readonly<{
  selected: CardRef | null
  onSelect: (card: CardRef) => void
  actions: ListActions
  dragFor: (kind: 'question' | 'ending', index: number) => CardDrag
  errorsOf: (kind: 'question' | 'ending', id: string) => boolean
  marked: (id: string) => boolean
}>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const full = form.endings.length >= LIMITS.endings
  const endingMenu = (index: number, id: string): (MenuAction | null)[] => [
    { label: t('questionList.moveUp'), icon: ArrowUp, onSelect: () => actions.moveEndingTo(id, index - 1), disabledReason: index === 0 ? t('questionList.alreadyFirst') : undefined },
    { label: t('questionList.moveDown'), icon: ArrowDown, onSelect: () => actions.moveEndingTo(id, index + 1), disabledReason: index === form.endings.length - 1 ? t('questionList.alreadyLast') : undefined },
    null,
    { label: t('questionList.delete'), icon: Trash2, danger: true, onSelect: () => actions.requestDelete('ending', id), disabledReason: form.endings.length <= 1 ? t('endings.lastEnding') : undefined },
  ]

  return (
    <>
      <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('endings.heading')}</h3>
      <ul aria-label={t('endings.label')} className="space-y-1">
        {form.endings.map((ending, index) => (
          <EndingCard key={ending.id} ending={ending} index={index} total={form.endings.length} language={form.language}
            selected={selected?.kind === 'ending' && selected.id === ending.id} hasError={errorsOf('ending', ending.id)} aiMarked={marked(ending.id)}
            onSelect={() => onSelect({ kind: 'ending', id: ending.id })} onMove={(to) => actions.moveEndingTo(ending.id, to)}
            menu={endingMenu(index, ending.id)} drag={dragFor('ending', index)} />
        ))}
      </ul>
      <div>
        <button type="button" className={clsx('btn btn-secondary btn-sm', full && 'opacity-50')} aria-disabled={full ? true : undefined} onClick={actions.addEnding}>
          <Plus size={14} aria-hidden="true" />{t('endings.add')}
        </button>
        {full && <p className="mt-1 text-[12px] text-muted">{t('endings.limit')}</p>}
      </div>
    </>
  )
}
