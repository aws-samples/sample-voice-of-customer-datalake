/**
 * @fileoverview The Questions tab (UX §3.2): from xl three panes (the cards, the selected card's editor, the live
 * preview), at lg two (the preview a panel over the editor's end edge, opened from the editor's header), and on a
 * narrow screen the list is the page: a card opens its editor full width, with "‹ Questions", "2 of 5" and ‹ ›.
 * The selected card is the path (`/questions/<qid>`, `/questions/end/<eid>`, `/questions/welcome`); on a wide screen
 * with none, the first question is selected. Opening a card the AI added or changed clears its AI marker.
 *
 * @module pages/FeedbackForms/questions/QuestionsTab
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import { selectedCard } from '../builder/builderPaths'
import { useBuilderUi } from '../builder/builderUi'
import { useDraft } from '../builder/formDraftContext'
import PreviewPane from '../preview/PreviewPane'
import QuestionList from './QuestionList'
import type { CardRef } from './QuestionList'
import QuestionEditor from './QuestionEditor'
import EndingEditor from './EndingEditor'
import WelcomeEditor from './WelcomeEditor'
import StatusLineProvider from './statusLine'
import { MEDIUM, WIDE, useMedia } from './useMedia'

const cardRest = (card: CardRef): string[] => {
  if (card.kind === 'welcome') return ['welcome']
  return card.kind === 'ending' ? ['end', card.id] : [card.id]
}

function SelectedEditor({ card }: Readonly<{ card: CardRef }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  if (card.kind === 'welcome') return <WelcomeEditor />
  if (card.kind === 'ending') {
    const ending = form.endings.find((e) => e.id === card.id)
    return ending === undefined ? <p className="text-sm text-muted">{t('questionList.gone')}</p> : <EndingEditor key={ending.id} ending={ending} />
  }
  const index = form.questions.findIndex((q) => q.id === card.id)
  const question = form.questions[index]
  return question === undefined ? <p className="text-sm text-muted">{t('questionList.gone')}</p> : <QuestionEditor key={question.id} question={question} index={index} />
}

/** The narrow editor's header: back to the list, "2 of 5", and the previous and next question. */
function NarrowNav({ card, onSelect }: Readonly<{ card: CardRef; onSelect: (card: CardRef | null) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const index = card.kind === 'question' ? form.questions.findIndex((q) => q.id === card.id) : -1
  const step = (by: number) => {
    const next = form.questions[index + by]
    if (next !== undefined) onSelect({ kind: 'question', id: next.id })
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(null)}>
        <ChevronLeft size={14} aria-hidden="true" />{t('questionList.back')}
      </button>
      {index !== -1 && (
        <span className="flex items-center gap-1">
          <span className="text-[12px] tabular-nums text-muted">{t('questionList.position', { n: index + 1, total: form.questions.length })}</span>
          <Tooltip kind="label" content={t('questionList.previous')}>
            <button type="button" className="icon-btn" aria-label={t('questionList.previous')} aria-disabled={index === 0 ? true : undefined} onClick={() => step(-1)}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip kind="label" content={t('questionList.next')}>
            <button type="button" className="icon-btn" aria-label={t('questionList.next')} aria-disabled={index === form.questions.length - 1 ? true : undefined} onClick={() => step(1)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  )
}

function PreviewToggle({ open, onToggle }: Readonly<{ open: boolean; onToggle: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const label = open ? t('preview.hide') : t('preview.show')
  return (
    <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={onToggle}>
      {open ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{label}
    </button>
  )
}

/** Clears the AI marker of the card just opened (UX §12.3: "until the person opens it"). */
function useClearAiMarker(card: CardRef | null): void {
  const { ai, setAi } = useDraft()
  const id = card?.id
  const marked = id !== undefined && (ai?.marked.has(id) ?? false)
  useEffect(() => {
    if (!marked) return
    setAi((current) => (current === null ? null : { ...current, marked: new Set([...current.marked].filter((other) => other !== id)) }))
  }, [marked, id, setAi])
}

function gridClass(wide: boolean, medium: boolean): string {
  if (wide) return 'grid gap-4 grid-cols-[18rem_minmax(0,44rem)_22rem]'
  return medium ? 'grid gap-4 grid-cols-[18rem_minmax(0,1fr)]' : 'grid gap-4'
}

const PANE_SCROLL = 'max-h-[calc(100vh-12rem)] overflow-y-auto pr-1'

/** The editor pane: on a narrow screen with its nav; below xl with the preview toggle and its panel. */
function EditorPane({ card, wide, medium, preview, onSelect }: Readonly<{
  card: CardRef; wide: boolean; medium: boolean; preview: ReactNode; onSelect: (card: CardRef | null) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [previewOpen, setPreviewOpen] = useState(false)
  return (
    <div className={clsx('relative min-w-0 space-y-3', medium && PANE_SCROLL)}>
      {!medium && <NarrowNav card={card} onSelect={onSelect} />}
      {!wide && <div className="flex justify-end"><PreviewToggle open={previewOpen} onToggle={() => setPreviewOpen(!previewOpen)} /></div>}
      {!wide && previewOpen && (
        <aside aria-label={t('preview.label')} className={clsx('card p-3', medium && 'absolute right-0 top-10 z-20 w-[22rem] shadow-lg')}>
          {preview}
        </aside>
      )}
      <SelectedEditor card={card} />
    </div>
  )
}

/** On a screen with room for the editor and no card selected, the first question is (the address is replaced). */
function useSelectFirst(card: CardRef | null, medium: boolean): void {
  const draft = useDraft()
  const { go } = useBuilderUi()
  const first = draft.form.questions[0]?.id
  useEffect(() => {
    if (card === null && medium && first !== undefined) go('questions', [first], { replace: true })
  }, [card, medium, first, go])
}

export default function QuestionsTab() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { rest, go, formId } = useBuilderUi()
  const wide = useMedia(WIDE)
  const medium = useMedia(MEDIUM)
  const card = selectedCard(rest)
  useSelectFirst(card, medium)
  useClearAiMarker(card)
  const select = (next: CardRef | null) => go('questions', next === null ? [] : cardRest(next))
  const preview = <PreviewPane form={draft.form} formId={formId} selectedQuestionId={card?.kind === 'question' ? card.id : null} />
  return (
    <StatusLineProvider>
      <div className={gridClass(wide, medium)}>
        {(medium || card === null) && (
          <div className={clsx(medium && PANE_SCROLL)}><QuestionList selected={card} onSelect={select} /></div>
        )}
        {card !== null && <EditorPane card={card} wide={wide} medium={medium} preview={preview} onSelect={select} />}
        {wide && <aside aria-label={t('preview.label')} className="sticky top-4 self-start">{preview}</aside>}
      </div>
    </StatusLineProvider>
  )
}
