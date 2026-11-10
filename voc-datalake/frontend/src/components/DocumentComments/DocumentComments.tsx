/**
 * @fileoverview A PR/FAQ or PRD with its comment threads (docs/document-review.md -> Comments).
 *
 * Select text in the document and press "Comment": the thread is anchored by that quote. On a wide
 * screen each thread is a bubble in the margin beside its passage (highlighted in the text); on a
 * phone the threads are one stacked list under the document, in reading order. A thread whose
 * quote is gone from this version is listed under "Not found in this version"; comments on the
 * whole document come first. The host decides who may do what (`CommentActions`).
 *
 * @module components/DocumentComments/DocumentComments
 */
import clsx from 'clsx'
import { MessageSquarePlus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CommentComposer from './CommentComposer'
import CommentFiltersBar from './CommentFiltersBar'
import CommentThreadCard from './CommentThreadCard'
import { DEFAULT_FILTER, matchesFilter } from './commentFilters'
import { BUBBLE_MIN_GAP_PX, useCommentLayout } from './useCommentLayout'
import { useSelectionAnchor } from './useSelectionAnchor'
import type { CSSProperties, ReactNode } from 'react'
import type { CommentActions, ViewedVersion } from './commentTypes'
import type { CommentFilter } from './commentFilters'
import type { ThreadPlacement } from './useCommentLayout'
import type { CommentThread, TextQuoteAnchor } from '../../api/documentReviewSchema'

type BubbleStyle = CSSProperties & Record<'--bubble-top', string>
type MarginStyle = CSSProperties & Record<'--margin-height', string>

/** Beside its passage on a wide screen; in the stacked list below the document on a phone. */
const BUBBLE_CLASS = 'lg:absolute lg:inset-x-0 lg:top-[var(--bubble-top)]'

const bubbleStyle = (top: number | null): BubbleStyle => ({ '--bubble-top': `${top ?? 0}px` })

/** A new thread being written: on a quote (`anchor`) or on the whole document (null). */
interface Draft {
  readonly anchor: TextQuoteAnchor | null
  readonly top: number
}

interface DocumentCommentsProps {
  /** The markdown, already prepared for display. */
  readonly markdown: string
  readonly threads: readonly CommentThread[]
  readonly viewed: ViewedVersion
  readonly actions: CommentActions
  readonly canComment: boolean
  /** Extra toolbar content (the persona review and share buttons). */
  readonly toolbar?: ReactNode
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

function DraftCard({ draft, onCreate, onCancel }: Readonly<{
  draft: Draft; onCreate: (text: string) => Promise<unknown>; onCancel: () => void
}>) {
  const { t } = useTranslation('components')
  return (
    <div className="rounded-lg border border-accent bg-card p-3 space-y-2 shadow-md">
      {draft.anchor === null ? (
        <p className="text-xs text-muted">{t('documentComments.onWholeDocument')}</p>
      ) : (
        <blockquote className="border-l-2 border-warn pl-2 text-xs text-muted line-clamp-3">{draft.anchor.exact}</blockquote>
      )}
      <CommentComposer label={t('documentComments.commentPlaceholder')} submitLabel={t('documentComments.comment')}
        autoFocus onSubmit={onCreate} onCancel={onCancel} />
    </div>
  )
}

/** Margin height on a wide screen: the lowest bubble (or the draft) plus room for it to open. */
const MARGIN_TAIL_PX = BUBBLE_MIN_GAP_PX * 4

function marginStyle(placed: readonly ThreadPlacement[], draft: Draft | null): MarginStyle {
  const lowest = Math.max(draft?.top ?? 0, ...placed.map((p) => p.top ?? 0))
  return { '--margin-height': `${lowest + MARGIN_TAIL_PX}px` }
}

export default function DocumentComments({ markdown, threads, viewed, actions, canComment, toolbar }: DocumentCommentsProps) {
  const { t } = useTranslation('components')
  const rootRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<CommentFilter>(DEFAULT_FILTER)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const visible = useMemo(() => threads.filter((thread) => matchesFilter(thread, filter)), [threads, filter])
  const layout = useCommentLayout(rootRef, visible, markdown, activeId)
  const { selected, clear } = useSelectionAnchor(rootRef, canComment && draft === null)
  const card = (thread: CommentThread) => (
    <CommentThreadCard key={thread.comment_id} thread={thread} actions={actions} viewed={viewed}
      active={thread.comment_id === activeId} onActivate={setActiveId} />
  )
  const create = async (text: string) => {
    if (draft === null) return
    await actions.create({ text, anchor: draft.anchor })
    setDraft(null)
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <CommentFiltersBar threads={threads} filter={filter} onFilterChange={setFilter}
          onCommentWhole={canComment ? () => setDraft({ anchor: null, top: 0 }) : undefined} />
        {toolbar}
      </div>
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="relative min-w-0">
          <div ref={rootRef} className="md-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
          {selected === null ? null : (
            <button type="button" className="btn btn-primary btn-sm absolute z-20 shadow-md"
              style={{ top: selected.top, left: selected.left }}
              // Keep the selection: a mousedown on the button would collapse it first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setDraft({ anchor: selected.anchor, top: selected.top }); clear() }}>
              <MessageSquarePlus size={14} aria-hidden />{t('documentComments.comment')}
            </button>
          )}
        </div>
        <aside aria-label={t('documentComments.margin')}
          className="relative space-y-2 lg:space-y-0 lg:min-h-[var(--margin-height)]"
          style={marginStyle(layout.placed, draft)}>
          {draft === null ? null : (
            <div className={clsx(BUBBLE_CLASS, 'z-30')} style={bubbleStyle(draft.top)}>
              <DraftCard draft={draft} onCreate={create} onCancel={() => setDraft(null)} />
            </div>
          )}
          {layout.placed.map((placement) => (
            <div key={placement.thread.comment_id} style={bubbleStyle(placement.top)}
              className={clsx(BUBBLE_CLASS, placement.thread.comment_id === activeId && 'z-10')}>
              {card(placement.thread)}
            </div>
          ))}
        </aside>
      </div>
      <ThreadSection title={t('documentComments.wholeDocument')} threads={layout.general} render={card} />
      <ThreadSection title={t('documentComments.notFound')} threads={layout.outdated} render={card} />
    </div>
  )
}
