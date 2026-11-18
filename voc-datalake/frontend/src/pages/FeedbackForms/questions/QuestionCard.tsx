/**
 * @fileoverview One question's card in the list (UX §3.3): the grip (drag), its number, type chip and ⋯ menu, the
 * headline in the primary language (two lines), the meta line, the rule count, and state badges only when they
 * apply: a language missing texts (`badge-warn`), a problem (`badge-danger`), the AI's marker (`badge-aim`).
 * Alt+Shift+↑/↓ on the focused card moves it.
 *
 * @module pages/FeedbackForms/questions/QuestionCard
 */
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CircleX, GitBranch, GripVertical, Languages, Sparkles } from 'lucide-react'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import type { FormLanguage, Question } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { splitOtherwise } from '../model/rules'
import TypeChip from '../ui/TypeChip'
import ActionsMenu from '../ui/ActionsMenu'
import type { MenuAction } from '../ui/ActionsMenu'
import { questionCardMeta } from './cardMeta'
import { moveOnArrowKeys } from '../../../lib/reorderKeys'

export interface CardDrag {
  readonly onDragStart: () => void
  readonly onDragOver: () => void
  readonly onDrop: () => void
  readonly onDragEnd: () => void
  /** Draw the insertion line above this card. */
  readonly over: boolean
}

export interface QuestionCardProps {
  readonly question: Question
  readonly index: number
  readonly total: number
  readonly language: FormLanguage
  readonly selected: boolean
  readonly missing: readonly FormLanguage[]
  readonly hasError: boolean
  readonly aiMarked: boolean
  readonly onSelect: () => void
  readonly onMove: (to: number) => void
  readonly menu: readonly (MenuAction | null)[]
  readonly drag: CardDrag
  /** The "Add question here" control above the card (shown on hover or focus). */
  readonly gap?: ReactNode
}

/** "en missing", one badge per language, collapsed to "3 languages missing" past two. */
function MissingBadges({ missing }: Readonly<{ missing: readonly FormLanguage[] }>) {
  const { t } = useTranslation('feedbackForms')
  if (missing.length === 0) return null
  const labels = missing.length > 2 ? [t('questionList.languagesMissing', { count: missing.length })] : missing.map((lng) => t('questionList.languageMissing', { language: lng }))
  return labels.map((label) => (
    <span key={label} className="badge badge-warn inline-flex items-center gap-1"><Languages size={12} aria-hidden="true" />{label}</span>
  ))
}

function CardBadges({ question, missing, hasError, aiMarked }: Readonly<Pick<QuestionCardProps, 'question' | 'missing' | 'hasError' | 'aiMarked'>>) {
  const { t } = useTranslation('feedbackForms')
  const logic = splitOtherwise(question)
  const rules = logic.rules.length + (logic.otherwise === null ? 0 : 1)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {rules > 0 && (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted">
          <GitBranch size={12} aria-hidden="true" />{t('questionList.rules', { count: rules })}
        </span>
      )}
      <MissingBadges missing={missing} />
      {hasError && <span className="badge badge-danger inline-flex items-center gap-1"><CircleX size={12} aria-hidden="true" />{t('questionList.problem')}</span>}
      {aiMarked && <span className="badge badge-aim inline-flex items-center gap-1"><Sparkles size={12} aria-hidden="true" />{t('questionList.ai')}</span>}
    </span>
  )
}

export default function QuestionCard(props: QuestionCardProps) {
  const { question, index, total, language, selected, onSelect, onMove, menu, drag, gap = null } = props
  const { t } = useTranslation('feedbackForms')
  const headline = textIn(question.headline, language)
  const number = index + 1
  const onKey = (event: KeyboardEvent<HTMLLIElement>) => { moveOnArrowKeys(event, index, total, onMove) }
  const allowDrop = (event: DragEvent<HTMLLIElement>) => { event.preventDefault(); drag.onDragOver() }
  return (
    <li onKeyDown={onKey} onDragOver={allowDrop} onDrop={(event) => { event.preventDefault(); drag.onDrop() }}>
      {gap !== null && <div className="py-0.5 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">{gap}</div>}
      <div className={clsx('flex items-start gap-1.5 rounded-lg border p-2.5', selected ? 'border-accent bg-accent-subtle' : 'border-border bg-card hover:bg-bg-hover',
        drag.over && 'shadow-[0_-2px_0_0_var(--accent)]')}>
        <span draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} aria-hidden="true"
          className="mt-0.5 cursor-grab text-muted" data-testid={`grip-${question.id}`}>
          <GripVertical size={14} />
        </span>
        <button type="button" data-card-id={question.id} aria-current={selected ? 'true' : undefined} onClick={onSelect}
          className="min-w-0 flex-1 space-y-1 rounded-md text-left focus-ring">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[12px] tabular-nums text-muted">{number}</span>
            <TypeChip question={question} />
            <span className="sr-only">{t('questionList.cardName', { number, total })}</span>
          </span>
          <TruncatedText as="span" className="block line-clamp-2 text-sm text-text-strong" text={headline === '' ? t('question.newQuestion') : headline} />
          <span className="block text-[12px] text-muted">{questionCardMeta(t, question)}</span>
          <CardBadges {...props} />
        </button>
        <ActionsMenu label={t('questionList.cardMenu', { number })} items={menu} />
      </div>
    </li>
  )
}
