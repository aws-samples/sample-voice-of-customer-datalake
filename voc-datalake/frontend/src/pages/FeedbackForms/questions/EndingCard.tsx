/**
 * @fileoverview One ending's card under the questions (UX §7): its title in the primary language, "default" on the
 * first (respondents who reach the end without a jump see it), its problem and AI badges, and the same reorder
 * (grip, Alt+Shift+↑/↓, ⋯) as a question.
 *
 * @module pages/FeedbackForms/questions/EndingCard
 */
import type { DragEvent, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CircleX, Flag, GripVertical, Sparkles } from 'lucide-react'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import type { Ending, FormLanguage } from '../model/formsV2'
import { headlineShown } from '../model/recall'
import ActionsMenu from '../ui/ActionsMenu'
import type { MenuAction } from '../ui/ActionsMenu'
import type { CardDrag } from './QuestionCard'
import { moveOnArrowKeys } from '../../../lib/reorderKeys'

export default function EndingCard({ ending, index, total, language, selected, hasError, aiMarked, onSelect, onMove, menu, drag }: Readonly<{
  ending: Ending
  index: number
  total: number
  language: FormLanguage
  selected: boolean
  hasError: boolean
  aiMarked: boolean
  onSelect: () => void
  onMove: (to: number) => void
  menu: readonly (MenuAction | null)[]
  drag: CardDrag
}>) {
  const { t } = useTranslation('feedbackForms')
  const title = headlineShown(ending.title, language)
  const onKey = (event: KeyboardEvent<HTMLLIElement>) => { moveOnArrowKeys(event, index, total, onMove) }
  const allowDrop = (event: DragEvent<HTMLLIElement>) => { event.preventDefault(); drag.onDragOver() }
  return (
    <li onKeyDown={onKey} onDragOver={allowDrop} onDrop={(event) => { event.preventDefault(); drag.onDrop() }}
      className={clsx('rounded-lg border p-2.5', selected ? 'border-accent bg-accent-subtle' : 'border-border bg-card hover:bg-bg-hover',
        drag.over && 'shadow-[0_-2px_0_0_var(--accent)]')}>
      <div className="flex items-start gap-1.5">
        <span draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} aria-hidden="true" className="mt-0.5 cursor-grab text-muted">
          <GripVertical size={14} />
        </span>
        <button type="button" data-card-id={ending.id} aria-current={selected ? 'true' : undefined} onClick={onSelect}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md text-left focus-ring">
          <Flag size={14} className={clsx('shrink-0', selected ? 'text-text' : 'text-muted')} aria-hidden="true" />
          <TruncatedText as="span" className="min-w-0 flex-1 truncate text-sm text-text-strong" text={title === '' ? t('endings.untitled') : title} />
          {index === 0 && <span className="badge badge-muted">{t('endings.default')}</span>}
          {hasError && <span className="badge badge-danger inline-flex items-center gap-1"><CircleX size={12} aria-hidden="true" />{t('questionList.problem')}</span>}
          {aiMarked && <span className="badge badge-aim inline-flex items-center gap-1"><Sparkles size={12} aria-hidden="true" />{t('questionList.ai')}</span>}
        </button>
        <ActionsMenu label={t('endings.cardMenu', { title: title === '' ? t('endings.untitled') : title })} items={menu} />
      </div>
    </li>
  )
}
