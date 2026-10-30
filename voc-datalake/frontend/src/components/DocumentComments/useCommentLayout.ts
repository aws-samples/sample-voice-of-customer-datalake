/**
 * @fileoverview Where each thread's quote is in the rendered document, its highlight, and the
 * margin position of its bubble.
 *
 * After every render of the document (and on resize) the threads with an anchor are located in
 * the container's text (`anchors.ts`). A located thread gets a `Range` (painted through
 * `CSS.highlights`, when the browser has it) and a `top` in the margin: the quote's offset from
 * the container's top, pushed down so two bubbles never overlap. A thread whose quote is not in
 * this version is `outdated`; a thread with no anchor is about the whole document.
 *
 * @module components/DocumentComments/useCommentLayout
 */
import { useCallback, useEffect, useState } from 'react'
import { anchorRange, indexText } from './anchors'
import type { RefObject } from 'react'
import type { CommentThread } from '../../api/documentReviewSchema'
import { noCleanup } from '../../hooks/noCleanup'

const HIGHLIGHT = 'voc-comment'
const ACTIVE_HIGHLIGHT = 'voc-comment-active'
/** The room one collapsed bubble needs before the next one starts. */
export const BUBBLE_MIN_GAP_PX = 64

export interface ThreadPlacement {
  readonly thread: CommentThread
  /** Margin offset (px from the document's top); null when not placed. */
  readonly top: number | null
  readonly range: Range | null
}

export interface CommentLayout {
  readonly placed: readonly ThreadPlacement[]
  readonly outdated: readonly CommentThread[]
  readonly general: readonly CommentThread[]
}

const EMPTY: CommentLayout = { placed: [], outdated: [], general: [] }

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? CSS.highlights : null
}

function paint(placed: readonly ThreadPlacement[], activeId: string | null): void {
  const registry = highlightRegistry()
  if (registry === null) return
  const ranges = placed.flatMap((p) => (p.range !== null && p.thread.comment_id !== activeId ? [p.range] : []))
  const active = placed.flatMap((p) => (p.range !== null && p.thread.comment_id === activeId ? [p.range] : []))
  registry.set(HIGHLIGHT, new Highlight(...ranges))
  registry.set(ACTIVE_HIGHLIGHT, new Highlight(...active))
}

function clearPaint(): void {
  const registry = highlightRegistry()
  registry?.delete(HIGHLIGHT)
  registry?.delete(ACTIVE_HIGHLIGHT)
}

/** Tops in document order, each at least BUBBLE_MIN_GAP_PX below the previous one. */
function spread(placed: readonly ThreadPlacement[]): ThreadPlacement[] {
  const ordered = [...placed].sort((a, b) => (a.top ?? 0) - (b.top ?? 0))
  return ordered.reduce<ThreadPlacement[]>((out, p) => {
    const previous = out.at(-1)?.top
    const floor = previous === undefined || previous === null ? 0 : previous + BUBBLE_MIN_GAP_PX
    return [...out, { ...p, top: Math.max(p.top ?? 0, floor) }]
  }, [])
}

function layoutOf(root: HTMLElement, threads: readonly CommentThread[]): CommentLayout {
  const index = indexText(root)
  const origin = root.getBoundingClientRect().top
  const placed: ThreadPlacement[] = []
  const outdated: CommentThread[] = []
  const general: CommentThread[] = []
  for (const thread of threads) {
    if (thread.anchor === null) {
      general.push(thread)
      continue
    }
    const range = anchorRange(root, thread.anchor, index)
    if (range === null) {
      outdated.push(thread)
      continue
    }
    placed.push({ thread, range, top: range.getBoundingClientRect().top - origin })
  }
  return { placed: spread(placed), outdated, general }
}

/** The layout of `threads` over the document in `rootRef`; re-measured when `content` or the size changes. */
export function useCommentLayout(
  rootRef: RefObject<HTMLElement | null>, threads: readonly CommentThread[], content: string, activeId: string | null,
): CommentLayout {
  const [layout, setLayout] = useState<CommentLayout>(EMPTY)
  const measure = useCallback(() => {
    const root = rootRef.current
    setLayout(root === null ? EMPTY : layoutOf(root, threads))
  }, [rootRef, threads])
  // Measured on the next frame, once the markdown (`content`) has rendered and laid out.
  useEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [measure, content])
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return noCleanup
    const observer = new ResizeObserver(() => measure())
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef, measure])
  useEffect(() => {
    paint(layout.placed, activeId)
  }, [layout, activeId])
  useEffect(() => clearPaint, [])
  return layout
}
