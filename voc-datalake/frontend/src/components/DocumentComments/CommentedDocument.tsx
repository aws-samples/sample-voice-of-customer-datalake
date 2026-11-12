/**
 * @fileoverview A document (any content: the canvas editor, or rendered Markdown) with its comment
 * threads in a rail beside it (docs/document-review.md -> Comments).
 *
 * The host renders the content as `children` and names the element the anchors index
 * (`contentRoot`); `revision` changes whenever its text does, so the threads are located again
 * while someone edits. The content sits in the reading column (~70ch, `readingColumn.ts`). From xl
 * up the rail (18rem) is beside it and each thread is a bubble beside its passage (highlighted in
 * the text through the CSS Custom Highlight API: the content's DOM is never rewritten); below xl
 * (tablet, phone) the rail is under the document, its threads one stacked list in reading order. A
 * thread whose quote is gone from the text is listed under "Not found in this version", next to
 * the comments on the whole document. The host decides who may do what (`CommentActions`).
 *
 * A comment on a passage starts from the current selection (`commentOnSelection`, through
 * `commentRef`: the canvas' floating bar, the Markdown view's floating button) or from the
 * keyboard: ⌘/Ctrl+Alt+M inside the document. A draft with text is never replaced: a second
 * selection (or "Comment on the whole document") then says to finish or cancel it, and focuses it.
 *
 * @module components/DocumentComments/CommentedDocument
 */
import clsx from 'clsx'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CommentComposer from './CommentComposer'
import CommentFiltersBar from './CommentFiltersBar'
import CommentThreadCard from './CommentThreadCard'
import { anchorOfSelection } from './anchors'
import { DEFAULT_FILTER, SHOW_EVERY_THREAD, matchesFilter } from './commentFilters'
import { BUBBLE_MIN_GAP_PX, useCommentLayout } from './useCommentLayout'
import { READING_COLUMN_CLASS } from '../DocumentCanvas/comments/readingColumn'
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from 'react'
import type { CommentActions, ViewedVersion } from './commentTypes'
import type { CommentFilter } from './commentFilters'
import type { CommentThread, TextQuoteAnchor } from '../../api/documentReviewSchema'

type BubbleStyle = CSSProperties & Record<'--bubble-top', string>
type MarginStyle = CSSProperties & Record<'--margin-height', string>

/** The reading column beside its rail from xl up (room for both); the rail under the text below xl. */
const DOCUMENT_GRID_CLASS = 'flex flex-col gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8'

/** Beside its passage from xl up; in the stacked list under the document, in reading order, below xl. */
const BUBBLE_CLASS = 'xl:absolute xl:inset-x-0 xl:top-[var(--bubble-top)]'

const bubbleStyle = (top: number | null): BubbleStyle => ({ '--bubble-top': `${top ?? 0}px` })

/** A new thread being written: on a quote (`anchor`) or on the whole document (null). */
interface Draft {
  readonly anchor: TextQuoteAnchor | null
  readonly top: number
}

export interface CommentedDocumentHandle {
  /** Opens a new thread on the text selected in the content; false (and says why) when none is usable. */
  readonly commentOnSelection: () => boolean
  /** Brings a thread into view, active and focused (the filter shows every thread if it hid it). */
  readonly showThread: (commentId: string) => void
}

interface CommentedDocumentProps {
  /** The document itself. */
  readonly children: ReactNode
  /** The element whose text the anchors index (the editor's DOM, or the rendered Markdown). */
  readonly contentRoot: () => HTMLElement | null
  /** Changes whenever the text does (the current Markdown): threads are located again. */
  readonly revision: string
  readonly threads: readonly CommentThread[]
  readonly viewed: ViewedVersion
  readonly actions: CommentActions
  readonly canComment: boolean
  /** Extra rail-header content (the persona review button). */
  readonly toolbar?: ReactNode
  /** A warning at the top of the rail (comments could not be loaded). */
  readonly notice?: ReactNode
  /** Wraps the comment rail (a tab panel beside the evidence); the rail as is by default. */
  readonly renderRail?: (rail: ReactNode) => ReactNode
  readonly commentRef?: Ref<CommentedDocumentHandle>
}

function ThreadSection({ title, threads, render }: Readonly<{
  title: string; threads: readonly CommentThread[]; render: (thread: CommentThread) => ReactNode
}>) {
  if (threads.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {threads.map(render)}
    </section>
  )
}

function DraftCard({ draft, onCreate, onCancel, onTextChange }: Readonly<{
  draft: Draft; onCreate: (text: string) => Promise<unknown>; onCancel: () => void; onTextChange: (text: string) => void
}>) {
  const { t } = useTranslation('components')
  return (
    <div className="rounded-lg border border-accent bg-card p-3 space-y-2 shadow-md"
      // Escape from the card's buttons closes it; in its box, the box decides (an empty one closes, text stays).
      onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) onCancel() }}>
      {draft.anchor === null ? (
        <p className="text-xs text-muted">{t('documentComments.onWholeDocument')}</p>
      ) : (
        <blockquote className="border-l-2 border-warn pl-2 text-xs text-muted line-clamp-3">{draft.anchor.exact}</blockquote>
      )}
      <CommentComposer label={t('documentComments.commentPlaceholder')} submitLabel={t('documentComments.comment')}
        autoFocus onSubmit={onCreate} onCancel={onCancel} onTextChange={onTextChange} />
    </div>
  )
}

/** Margin height from xl up: the lowest bubble's bottom (or the draft's top) plus room for it to open. */
const MARGIN_TAIL_PX = BUBBLE_MIN_GAP_PX * 3

function marginStyle(bottom: number, draft: Draft | null): MarginStyle {
  const lowest = Math.max(draft === null ? 0 : draft.top + BUBBLE_MIN_GAP_PX, bottom)
  return { '--margin-height': `${lowest + MARGIN_TAIL_PX}px` }
}

/** ⌘/Ctrl+Alt+M: comment on the selection (by the key's place, so a Mac's Option+M still counts). */
const isCommentShortcut = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.code === 'KeyM'

const identity = (rail: ReactNode) => rail

export default function CommentedDocument({
  children, contentRoot, revision, threads, viewed, actions, canComment, toolbar, notice, renderRail = identity, commentRef,
}: CommentedDocumentProps) {
  const { t } = useTranslation('components')
  const marginRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<CommentFilter>(DEFAULT_FILTER)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [message, setMessage] = useState('')
  // What the open draft holds so far: a draft with text is never replaced by another one.
  const draftText = useRef('')
  const draftBox = useRef<HTMLDivElement>(null)
  const visible = useMemo(() => threads.filter((thread) => matchesFilter(thread, filter)), [threads, filter])
  const layout = useCommentLayout(contentRoot, marginRef, visible, revision, activeId)
  /** Opens `next`, unless the open draft has text: then it says so and takes the person back to it. */
  const openDraft = useCallback((next: Draft) => {
    if (draft !== null && draftText.current.trim() !== '') {
      setMessage(t('projectDetail:canvas.comments.draftOpen'))
      draftBox.current?.querySelector('textarea')?.focus()
      return false
    }
    draftText.current = ''
    setDraft(next)
    setMessage('')
    return true
  }, [draft, t])
  const closeDraft = useCallback(() => {
    draftText.current = ''
    setDraft(null)
    setMessage('')
  }, [])
  const commentOnSelection = useCallback(() => {
    const root = contentRoot()
    const selection = globalThis.getSelection()
    const anchor = canComment && root !== null ? anchorOfSelection(root, selection) : null
    if (root === null || anchor === null || selection === null) {
      setMessage(canComment ? t('projectDetail:canvas.comments.selectFirst') : '')
      return false
    }
    const box = selection.getRangeAt(0).getBoundingClientRect()
    const origin = (marginRef.current ?? root).getBoundingClientRect().top
    return openDraft({ anchor, top: Math.max(0, box.top - origin) })
  }, [contentRoot, canComment, t, openDraft])
  // A thread asked for by `showThread`: focused once it is rendered (a filter it was hidden by is lifted first).
  const railRef = useRef<HTMLElement>(null)
  const [shown, setShown] = useState<string | null>(null)
  const showThread = useCallback((commentId: string) => {
    const thread = threads.find((row) => row.comment_id === commentId)
    if (thread === undefined) return
    if (!matchesFilter(thread, filter)) setFilter(SHOW_EVERY_THREAD)
    setActiveId(commentId)
    setShown(commentId)
  }, [threads, filter])
  useEffect(() => {
    if (shown === null) return
    const card = [...(railRef.current?.querySelectorAll<HTMLElement>('[data-thread-id]') ?? [])]
      .find((element) => element.dataset['threadId'] === shown)
    if (card === undefined) return
    setShown(null)
    card.scrollIntoView({ block: 'center' })
    card.focus({ preventScroll: true })
    // The layout places threads a frame later: once it holds the thread, its card is there.
  }, [shown, layout])
  useImperativeHandle(commentRef, () => ({ commentOnSelection, showThread }), [commentOnSelection, showThread])
  const card = (thread: CommentThread) => (
    <CommentThreadCard key={thread.comment_id} thread={thread} actions={actions} viewed={viewed}
      active={thread.comment_id === activeId} onActivate={setActiveId} />
  )
  const create = async (text: string) => {
    if (draft === null) return
    await actions.create({ text, anchor: draft.anchor })
    closeDraft()
  }
  const rail = (
    <aside ref={railRef} aria-label={t('documentComments.margin')} className="space-y-3 min-w-0">
      {notice}
      <div className="flex flex-wrap items-center gap-2">
        <CommentFiltersBar threads={threads} filter={filter} onFilterChange={setFilter}
          onCommentWhole={canComment ? () => { openDraft({ anchor: null, top: 0 }) } : undefined} />
        {toolbar}
      </div>
      {canComment ? (
        <div className="space-y-1 text-xs">
          <p className="text-muted">{t('projectDetail:canvas.comments.hint')}</p>
          {/* Always rendered, so a screen reader hears what is written into it. */}
          <p aria-live="polite" className="text-warn">{message}</p>
        </div>
      ) : null}
      <div ref={marginRef} className="relative space-y-2 xl:space-y-0 xl:min-h-[var(--margin-height)]"
        style={marginStyle(layout.bottom, draft)}>
        {draft === null ? null : (
          <div ref={draftBox} className={clsx(BUBBLE_CLASS, 'z-30')} style={bubbleStyle(draft.top)}>
            {/* Keyed by its passage: an empty draft moved to another passage starts afresh, focused. */}
            <DraftCard key={`${draft.anchor?.exact ?? ''}@${draft.top}`} draft={draft} onCreate={create}
              onCancel={closeDraft} onTextChange={(text) => { draftText.current = text }} />
          </div>
        )}
        {layout.placed.map((placement) => (
          <div key={placement.thread.comment_id} ref={layout.bubbleRef(placement.thread.comment_id)} style={bubbleStyle(placement.top)}
            className={clsx(BUBBLE_CLASS, placement.thread.comment_id === activeId && 'z-10')}>
            {card(placement.thread)}
          </div>
        ))}
      </div>
      <ThreadSection title={t('documentComments.wholeDocument')} threads={layout.general} render={card} />
      <ThreadSection title={t('documentComments.notFound')} threads={layout.outdated} render={card} />
    </aside>
  )
  return (
    <div className={DOCUMENT_GRID_CLASS}>
      <div className={clsx('relative', READING_COLUMN_CLASS)} data-testid="reading-column"
        onKeyDown={(event) => {
          if (!isCommentShortcut(event)) return
          event.preventDefault()
          commentOnSelection()
        }}>
        {children}
      </div>
      {renderRail(rail)}
    </div>
  )
}
