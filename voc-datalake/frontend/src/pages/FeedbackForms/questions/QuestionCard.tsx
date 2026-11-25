/**
 * @fileoverview One question's card in the list (UX §3.3): the grip (drag), its number, type chip and ⋯ menu, the
 * headline in the primary language (two lines), the meta line, the rule count, and state badges only when they
 * apply: a language missing texts (`badge-warn`), a problem (`badge-danger`), the AI's marker (`badge-aim`).
 * Alt+Shift+↑/↓ on the focused card moves it. On the selected card the secondary text is `text-text`: `text-muted`
 * on `bg-accent-subtle` is only 4.06:1 in dark.
 *
 * Between two cards is an insertion line that takes no room: it sits in the 8 px gap above the card and shows, with
 * its 24 px round "+", on hover or focus (and while its menu is open). Touch has no hover, so the card's ⋯ menu has
 * Add question below too.
 *
 * @module pages/FeedbackForms/questions/QuestionCard
 */
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CircleX, GitBranch, GripVertical, Languages, Sparkles } from 'lucide-react'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import type { FormLanguage, Question } from '../model/formsV2'
import { headlineShown } from '../model/recall'
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
  /** The insertion line's "+" above the card (shown on hover or focus); null on the first card. */
  readonly gap?: ReactNode
}

/** Shown while the insertion zone is hovered or holds focus, or its type menu is open. */
const INSERT_SHOWN = 'group-hover/insert:opacity-100 group-focus-within/insert:opacity-100 group-has-[[aria-expanded=true]]/insert:opacity-100'

/**
 * The insertion line in the gap above a card: absolute, so it takes no room. The zone is the 8 px gap plus a few px
 * of each card's padding (nothing to press there); the "+" ignores the pointer until the zone is hovered, so a hidden
 * "+" never takes a press meant for a card.
 */
function InsertLine({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="group/insert absolute inset-x-0 -top-3 flex h-4 items-center">
      <span aria-hidden="true" className={clsx('h-0.5 flex-1 rounded-full bg-accent opacity-0 transition-opacity motion-reduce:transition-none', INSERT_SHOWN)} />
      <div className={clsx('pointer-events-none opacity-0 transition-opacity motion-reduce:transition-none group-hover/insert:pointer-events-auto', INSERT_SHOWN)}>
        {children}
      </div>
      <span aria-hidden="true" className={clsx('h-0.5 flex-1 rounded-full bg-accent opacity-0 transition-opacity motion-reduce:transition-none', INSERT_SHOWN)} />
    </div>
  )
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

function CardBadges({ question, missing, hasError, aiMarked, secondary }: Readonly<Pick<QuestionCardProps, 'question' | 'missing' | 'hasError' | 'aiMarked'> & {
  /** The secondary text's colour (`text-text` on the selected card). */
  secondary: string
}>) {
  const { t } = useTranslation('feedbackForms')
  const logic = splitOtherwise(question)
  const rules = logic.rules.length + (logic.otherwise === null ? 0 : 1)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {rules > 0 && (
        <span className={clsx('inline-flex items-center gap-1 text-[12px]', secondary)}>
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
  const headline = headlineShown(question.headline, language)
  const number = index + 1
  const onKey = (event: KeyboardEvent<HTMLLIElement>) => { moveOnArrowKeys(event, index, total, onMove) }
  const allowDrop = (event: DragEvent<HTMLLIElement>) => { event.preventDefault(); drag.onDragOver() }
  const secondary = selected ? 'text-text' : 'text-muted'
  return (
    <li className="relative" onKeyDown={onKey} onDragOver={allowDrop} onDrop={(event) => { event.preventDefault(); drag.onDrop() }}>
      {gap !== null && <InsertLine>{gap}</InsertLine>}
      <div className={clsx('flex items-start gap-1.5 rounded-lg border p-2.5', selected ? 'border-accent bg-accent-subtle' : 'border-border bg-card hover:bg-bg-hover',
        drag.over && 'shadow-[0_-2px_0_0_var(--accent)]')}>
        <span draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} aria-hidden="true"
          className="mt-0.5 cursor-grab text-muted" data-testid={`grip-${question.id}`}>
          <GripVertical size={14} />
        </span>
        <button type="button" data-card-id={question.id} aria-current={selected ? 'true' : undefined} onClick={onSelect}
          className="min-w-0 flex-1 space-y-1 rounded-md text-left focus-ring">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={clsx('font-mono text-[12px] tabular-nums', secondary)}>{number}</span>
            <TypeChip question={question} />
            <span className="sr-only">{t('questionList.cardName', { number, total })}</span>
          </span>
          {/* (no `block` beside the clamp: it would win over line-clamp's -webkit-box, and the headline grow) */}
          <TruncatedText as="span" className="line-clamp-2 text-sm text-text-strong" text={headline === '' ? t('question.newQuestion') : headline} />
          <span className={clsx('block text-[12px]', secondary)}>{questionCardMeta(t, question)}</span>
          <CardBadges {...props} secondary={secondary} />
        </button>
        <ActionsMenu label={t('questionList.cardMenu', { number })} items={menu} />
      </div>
    </li>
  )
}
