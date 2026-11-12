/**
 * @fileoverview Where each thread's quote is in the rendered document, its highlight, and the
 * margin position of its bubble.
 *
 * Whenever the document's text changes (its `revision`, or any change to its DOM: the canvas
 * editor replaces nodes as one types or loads another version) and on resize, the threads with
 * an anchor are located in the content root's text (`anchors.ts`). A located thread gets a
 * `Range` (painted through `CSS.highlights`, when the browser has it: the DOM is never touched)
 * and a `top` in the margin: the quote's offset from the margin's top, pushed down so two
 * bubbles never overlap. A thread whose quote is not in the text (another version, or edited
 * away just now) is `outdated`; a thread with no anchor is about the whole document.
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

function layoutOf(root: HTMLElement, origin: number, threads: readonly CommentThread[]): CommentLayout {
  const index = indexText(root)
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

/** How many frames to wait for a content root that mounts after its host (the editor builds its DOM in an effect). */
const ROOT_WAIT_FRAMES = 30

/** One measuring call per frame at most, however many changes came in it. */
function frameScheduler(run: () => void) {
  const pending = { frame: 0 }
  return {
    schedule: () => {
      cancelAnimationFrame(pending.frame)
      pending.frame = requestAnimationFrame(run)
    },
    cancel: () => cancelAnimationFrame(pending.frame),
  }
}

/** Re-measure whenever the content's DOM changes or the content or the margin is resized. */
function observeChanges(root: HTMLElement, margin: HTMLElement | null, onChange: () => void): () => void {
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onChange)
  resize?.observe(root)
  if (margin !== null) resize?.observe(margin)
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onChange)
  mutation?.observe(root, { subtree: true, childList: true, characterData: true })
  return () => {
    resize?.disconnect()
    mutation?.disconnect()
  }
}

/**
 * The layout of `threads` over the document `contentRoot()` names, bubbles measured from the
 * top of `marginRef`'s element; re-measured when `revision` changes, the content's DOM changes
 * or either is resized.
 */
export function useCommentLayout(
  contentRoot: () => HTMLElement | null, marginRef: RefObject<HTMLElement | null>,
  threads: readonly CommentThread[], revision: string, activeId: string | null,
): CommentLayout {
  const [layout, setLayout] = useState<CommentLayout>(EMPTY)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const measure = useCallback(() => {
    const current = contentRoot()
    setRoot(current)
    const origin = (marginRef.current ?? current)?.getBoundingClientRect().top ?? 0
    setLayout(current === null ? EMPTY : layoutOf(current, origin, threads))
  }, [contentRoot, marginRef, threads])
  // Measured on the next frame, once the new text (`revision`) has rendered and laid out; a root
  // that is not there yet is waited for a few frames.
  useEffect(() => {
    const tries = { left: ROOT_WAIT_FRAMES }
    const scheduler = frameScheduler(() => {
      measure()
      if (contentRoot() === null && tries.left-- > 0) scheduler.schedule()
    })
    scheduler.schedule()
    return scheduler.cancel
  }, [measure, contentRoot, revision])
  useEffect(() => {
    if (root === null) return noCleanup
    const scheduler = frameScheduler(measure)
    const stop = observeChanges(root, marginRef.current, scheduler.schedule)
    return () => {
      stop()
      scheduler.cancel()
    }
  }, [root, marginRef, measure])
  useEffect(() => {
    paint(layout.placed, activeId)
  }, [layout, activeId])
  useEffect(() => clearPaint, [])
  return layout
}
