/**
 * @fileoverview The Questions tab (UX §3.2): from xl three panes (the cards, the selected card's editor, the live
 * preview), at lg two (the preview a panel over the editor's end edge, opened from the editor's header), and on a
 * narrow screen the list is the page: a card opens its editor full width, with "‹ Questions", "2 of 5" and ‹ ›; from
 * md the editor's Preview opens the panel over it, below md the preview window in a new tab (a phone's real size).
 * The selected card is the path (`/questions/<qid>`, `/questions/end/<eid>`, `/questions/welcome`); on a wide screen
 * with none, the first question is selected. Opening a card the AI added or changed clears its AI marker.
 *
 * From lg the builder is as tall as the window (FormBuilderPage) and each pane scrolls on its own, so the page does
 * not scroll twice. The preview follows the selected card, the Welcome card and the endings included. Its Style
 * button opens the Style panel (preview/StylePanel): from xl in place of the editor while the preview stays, below
 * xl as a dialog with its own phone; the palette it edits is the one the preview shows.
 *
 * Room for the editor (F28): from lg the person can hide or show the in-pane preview (Hide preview in its toolbar,
 * Show preview over the editor; remembered in this browser), and while the preview window is open (its
 * BroadcastChannel says so) the in-pane one collapses on its own, giving the editor the width, and comes back when
 * the window closes. Show preview brings it back while the window is open too.
 *
 * @module pages/FeedbackForms/questions/QuestionsTab
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { useRegisterKeepClear } from '../../../components/StickyActionBar/actionBarRegistry'
import { selectedCard } from '../builder/builderPaths'
import { useBuilderUi } from '../builder/builderUi'
import { useDraft } from '../builder/formDraftContext'
import PreviewPane from '../preview/PreviewPane'
import { cardTarget } from '../preview/previewForm'
import { usePreviewWindow } from '../preview/previewWindowContext'
import { StyleColumn, StyleSheet } from '../preview/StylePanel'
import type { PreviewScheme } from '../preview/widgetScript'
import QuestionList from './QuestionList'
import type { CardRef } from './QuestionList'
import QuestionEditor from './QuestionEditor'
import EndingEditor from './EndingEditor'
import WelcomeEditor from './WelcomeEditor'
import StatusLineProvider from './statusLine'
import { MEDIUM, WIDE, useMedia } from './useMedia'

/** ≥ md (768 px): the editor's Preview opens the panel over the editor; below it, the preview window in a tab. */
const TABLET = '(min-width: 768px)'
/** The person's choice of the in-pane preview from lg, kept in this browser. */
const PANE_PREVIEW_KEY = 'voc-form-builder-preview'
type PanePreviewChoice = 'shown' | 'hidden'

function storedPanePreview(): PanePreviewChoice | null {
  try {
    const stored = window.localStorage.getItem(PANE_PREVIEW_KEY)
    return stored === 'shown' || stored === 'hidden' ? stored : null
  } catch {
    return null
  }
}

/**
 * Whether the in-pane preview shows (from lg): the person's choice (from xl shown, at lg closed, until they choose),
 * except while the preview window is open, when it collapses on its own (`inWindow`) unless the person asked for it
 * again during that window's life.
 */
function usePanePreview(wide: boolean) {
  const openSince = usePreviewWindow()?.openSince ?? null
  const [choice, setChoice] = useState<PanePreviewChoice | null>(storedPanePreview)
  // (the window, by the time it opened, that the person asked for the in-pane preview beside: a new window collapses it again)
  const [hereFor, setHereFor] = useState<number | null>(null)
  const wanted = choice ?? (wide ? 'shown' : 'hidden')
  const collapsed = openSince !== null && hereFor !== openSince
  const set = (shown: boolean) => {
    const next: PanePreviewChoice = shown ? 'shown' : 'hidden'
    setChoice(next)
    try {
      window.localStorage.setItem(PANE_PREVIEW_KEY, next)
    } catch {
      // (storage refused: the choice lasts as long as this page)
    }
    setHereFor(shown ? openSince : null)
  }
  return { shown: wanted === 'shown' && !collapsed, inWindow: wanted === 'shown' && collapsed, set }
}

type PanePreview = ReturnType<typeof usePanePreview>

/** Over the editor from lg: why the preview went, when the window took it, beside the toggle that brings it back. */
function PreviewPlace({ pane, children }: Readonly<{ pane: PanePreview; children: ReactNode }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {pane.inWindow && <p className="text-[12px] text-muted">{t('preview.inWindow')}</p>}
      {children}
    </div>
  )
}

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
          <button title={t('questionList.previous')} type="button" className="icon-btn" aria-label={t('questionList.previous')} aria-disabled={index === 0 ? true : undefined} onClick={() => step(-1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button title={t('questionList.next')} type="button" className="icon-btn" aria-label={t('questionList.next')} aria-disabled={index === form.questions.length - 1 ? true : undefined} onClick={() => step(1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  )
}

function PreviewToggle({ open, onToggle }: Readonly<{ open: boolean; onToggle: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const label = open ? t('preview.hide') : t('preview.showPane')
  return (
    <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={onToggle}>
      {open ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{label}
    </button>
  )
}

/** Below md: Preview opens the preview window in a new tab, at the phone's own size. */
function PreviewInTab() {
  const { t } = useTranslation('feedbackForms')
  const previewWindow = usePreviewWindow()
  const [blocked, setBlocked] = useState(false)
  if (previewWindow === null) return null
  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-secondary btn-sm" aria-label={t('preview.openTab')}
        onClick={() => setBlocked(!previewWindow.open('phone', { tab: true }))}>
        <ExternalLink size={14} aria-hidden="true" />{t('preview.show')}
      </button>
      {blocked && <span role="alert" className="text-[12px] text-warn">{t('preview.blocked')}</span>}
    </span>
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

/** The grid of the panes: from lg it fills the tab's height (one row), each pane scrolling on its own; from xl without
 * the preview's column while it is hidden, so the editor takes its width. */
function gridClass(wide: boolean, medium: boolean, previewShown: boolean): string {
  if (wide && !previewShown) return 'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 grid-cols-[18rem_minmax(0,1fr)]'
  if (wide) {
    // (from 1600 px the preview's column grows, so the 390 px phone shows unscaled)
    return 'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 grid-cols-[18rem_minmax(0,44rem)_22rem] min-[1600px]:grid-cols-[18rem_minmax(0,44rem)_minmax(22rem,28rem)]'
  }
  return medium ? 'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 grid-cols-[18rem_minmax(0,1fr)]' : 'grid gap-4'
}

/**
 * A pane of the full-height grid: as tall as the grid, scrolling on its own. `relative`: the pane is the containing
 * block of the absolute elements inside it (`.sr-only` spans), which would otherwise be placed against the page's
 * scroller, out of the pane's clip, and make the page scroll after all.
 */
const PANE_SCROLL = 'relative h-full min-h-0 overflow-y-auto pr-1'

type PreviewFit = 'window' | 'fill'

/** The editor pane: on a narrow screen with its nav; below xl with the preview toggle and its panel. */
function EditorPane({ card, wide, medium, pane, preview, onSelect }: Readonly<{
  card: CardRef; wide: boolean; medium: boolean; pane: PanePreview; preview: (fit: PreviewFit) => ReactNode
  onSelect: (card: CardRef | null) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const tablet = useMedia(TABLET)
  const [previewOpen, setPreviewOpen] = useState(false)
  // (the assistant launcher stands beside the preview, never on its Next: components/StickyActionBar/actionBarRegistry)
  const previewRef = useRef<HTMLElement>(null)
  useRegisterKeepClear(previewRef, { mode: 'beside' })
  if (wide) {
    return (
      <div className={clsx('min-w-0 space-y-3', PANE_SCROLL)}>
        {!pane.shown && <PreviewPlace pane={pane}><PreviewToggle open={false} onToggle={() => pane.set(true)} /></PreviewPlace>}
        <SelectedEditor card={card} />
      </div>
    )
  }
  if (medium) {
    // (the toggle stays put above the editor's own scroll; the panel spans the pane's height beside it)
    return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-col gap-3">
        <PreviewPlace pane={pane}><PreviewToggle open={pane.shown} onToggle={() => pane.set(!pane.shown)} /></PreviewPlace>
        <div className={clsx('min-h-0 flex-1 space-y-3', PANE_SCROLL)}><SelectedEditor card={card} /></div>
        {pane.shown && (
          <aside ref={previewRef} aria-label={t('preview.label')}
            className="card absolute bottom-0 right-0 top-10 z-20 w-[22rem] overflow-y-auto p-3 shadow-lg">
            {preview('fill')}
          </aside>
        )}
      </div>
    )
  }
  const toggle = <PreviewToggle open={previewOpen} onToggle={() => setPreviewOpen(!previewOpen)} />
  return (
    <div className="relative min-w-0 space-y-3">
      <NarrowNav card={card} onSelect={onSelect} />
      <div className="flex justify-end">{tablet ? toggle : <PreviewInTab />}</div>
      {tablet && previewOpen && (
        <aside ref={previewRef} aria-label={t('preview.label')} className="card absolute right-0 top-20 z-20 w-[22rem] p-3 shadow-lg">
          {preview('window')}
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

/** The Style panel's state: open or not, and the palette it is editing (the one the preview shows meanwhile). */
function useStylePanel() {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<PreviewScheme | null>(null)
  const close = () => {
    setOpen(false)
    setEditing(null)
  }
  return { open, editing, setEditing, toggle: () => (open ? close() : setOpen(true)), close, scheme: open ? editing : null }
}

export default function QuestionsTab() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { rest, go } = useBuilderUi()
  const wide = useMedia(WIDE)
  const medium = useMedia(MEDIUM)
  const card = selectedCard(rest)
  const style = useStylePanel()
  const pane = usePanePreview(wide)
  useSelectFirst(card, medium)
  useClearAiMarker(card)
  const select = (next: CardRef | null) => {
    style.close()
    go('questions', next === null ? [] : cardRest(next))
  }
  const preview = (fit: PreviewFit, onHide?: () => void) => (
    <PreviewPane form={draft.form} selection={cardTarget(card)} scheme={style.scheme} styleOpen={style.open} onStyle={style.toggle} fit={fit} onHide={onHide} />
  )
  // (the assistant launcher stands beside the preview, never on its Next: components/StickyActionBar/actionBarRegistry)
  const previewRef = useRef<HTMLElement>(null)
  useRegisterKeepClear(previewRef, { mode: 'beside' })
  const styleInColumn = wide && style.open
  return (
    <div className={clsx(medium && 'flex h-full min-h-0 flex-col')}>
      <StatusLineProvider>
        <div className={gridClass(wide, medium, pane.shown)}>
          {(medium || card === null) && (
            <div className={clsx(medium && PANE_SCROLL)}><QuestionList selected={card} onSelect={select} /></div>
          )}
          {styleInColumn && <div className={clsx('min-w-0', PANE_SCROLL)}><StyleColumn onBack={style.close} onEditingSchemeChange={style.setEditing} /></div>}
          {!styleInColumn && card !== null && <EditorPane card={card} wide={wide} medium={medium} pane={pane} preview={preview} onSelect={select} />}
          {wide && pane.shown && (
            <aside ref={previewRef} aria-label={t('preview.label')} className={PANE_SCROLL}>{preview('fill', () => pane.set(false))}</aside>
          )}
        </div>
      </StatusLineProvider>
      <StyleSheet isOpen={!wide && style.open} onClose={style.close} form={draft.form} scheme={style.editing} onEditingSchemeChange={style.setEditing} />
    </div>
  )
}
