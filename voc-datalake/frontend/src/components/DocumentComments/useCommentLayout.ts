/**
 * @fileoverview Where each thread's quote is in the rendered document, its highlight, and the
 * margin position of its bubble.
 *
 * Whenever the document's text changes (its `revision`, or any change to its DOM: the canvas
 * editor replaces nodes as one types or loads another version) and on resize, the threads with
 * an anchor are located in the content root's text (`anchors.ts`). A located thread gets a
 * `Range` (painted through `CSS.highlights`, when the browser has it: the DOM is never touched)
 * and a `top` in the margin: the quote's offset from the margin's top, pushed down so two
 * bubbles never overlap. Each bubble is measured as rendered (`bubbleRef`, a ResizeObserver), so
 * a tall card, or the open one growing a reply box, pushes the ones below it down by its real
 * height; each stays as close to its passage as that allows. A thread whose quote is not in the text (another version, or edited
 * away just now) is `outdated`; a thread with no anchor is about the whole document.
 *
 * @module components/DocumentComments/useCommentLayout
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { anchorRange, indexText } from './anchors'
import type { RefCallback, RefObject } from 'react'
import type { CommentThread } from '../../api/documentReviewSchema'
import { noCleanup } from '../../hooks/noCleanup'

const HIGHLIGHT = 'voc-comment'
const ACTIVE_HIGHLIGHT = 'voc-comment-active'
/** The room a bubble not measured yet is given before the next one starts (about one collapsed bubble). */
export const BUBBLE_MIN_GAP_PX = 64
/** The space between one measured bubble's bottom and the next one's top. */
const BUBBLE_GAP_PX = 8

interface ThreadPlacement {
  readonly thread: CommentThread
  /** Margin offset (px from the document's top); null when not placed. */
  readonly top: number | null
  readonly range: Range | null
}

interface MeasuredLayout {
  /** In document order, each bubble's `top` clear of the one above it. */
  readonly placed: readonly ThreadPlacement[]
  readonly outdated: readonly CommentThread[]
  readonly general: readonly CommentThread[]
}

export interface CommentLayout extends MeasuredLayout {
  /** Where the lowest bubble ends (px from the margin's top; 0 with none). */
  readonly bottom: number
  /** Goes on each placed bubble's box (`ref={bubbleRef(id)}`): its measured height spaces the ones below. */
  readonly bubbleRef: (commentId: string) => RefCallback<HTMLElement>
}

const EMPTY: MeasuredLayout = { placed: [], outdated: [], general: [] }

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

/** The room one bubble takes before the next may start: its measured height and the gap, else the estimate. */
function roomOf(height: number | undefined): number {
  return height === undefined || height <= 0 ?BUBBLE_MIN_GAP_PX : height + BUBBLE_GAP_PX
}

/**
 * Tops in document order: each bubble at its passage, unless the one above (at its measured height, the
 * open one taller) still reaches there: then just below it, so no two bubbles overlap.
 */
function spread(placed: readonly ThreadPlacement[], heights: ReadonlyMap<string, number>): ThreadPlacement[] {
  const ordered = [...placed].sort((a, b) => (a.top ?? 0) - (b.top ?? 0))
  return ordered.reduce<ThreadPlacement[]>((out, p) => {
    const previous = out.at(-1)
    const floor = previous?.top == null ? 0 : previous.top + roomOf(heights.get(previous.thread.comment_id))
    return [...out, { ...p, top: Math.max(p.top ?? 0, floor) }]
  }, [])
}

const sameHeights = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([id, height]) => b.get(id) === height)

/**
 * The bubbles' boxes by thread, each measured (`offsetHeight`) when it mounts and whenever it is
 * resized, at most once a frame; `onHeights` gets every box's height. `refOf(id)` is the box's ref
 * (one stable callback per thread); `start()` observes until the cleanup it returns.
 */
function heightTracker(onHeights: (heights: ReadonlyMap<string, number>) => void) {
  const elements = new Map<string, HTMLElement>()
  const refs = new Map<string, RefCallback<HTMLElement>>()
  const scheduler = frameScheduler(() => {
    onHeights(new Map([...elements].map(([id, element]) => [id, element.offsetHeight])))
  })
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduler.schedule)
  const register = (commentId: string, element: HTMLElement) => {
    elements.set(commentId, element)
    observer?.observe(element)
    scheduler.schedule()
    // The ref callback stays cached (one per thread for good): dropping it would hand React a new ref on the next
    // render, which detaches and re-attaches the box (StrictMode runs this cleanup on every mount, too).
    return () => {
      observer?.unobserve(element)
      if (elements.get(commentId) === element) elements.delete(commentId)
      scheduler.schedule()
    }
  }
  const refOf = (commentId: string): RefCallback<HTMLElement> => {
    const known = refs.get(commentId)
    if (known !== undefined) return known
    const ref: RefCallback<HTMLElement> = (element) => (element === null ? noCleanup : register(commentId, element))
    refs.set(commentId, ref)
    return ref
  }
  const start = () => {
    elements.forEach((element) => observer?.observe(element))
    scheduler.schedule()
    return () => {
      observer?.disconnect()
      scheduler.cancel()
    }
  }
  return { refOf, start }
}

/** Each bubble's rendered height, by thread; `bubbleRef(id)` goes on the bubble's box. */
function useBubbleHeights() {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [tracker] = useState(() => heightTracker((next) => {
    setHeights((previous) => (sameHeights(previous, next) ? previous : next))
  }))
  useEffect(() => tracker.start(), [tracker])
  return { heights, bubbleRef: tracker.refOf }
}

/** Each located thread at its quote's own offset (not spread yet), the rest sorted out. */
function layoutOf(root: HTMLElement, origin: number, threads: readonly CommentThread[]): MeasuredLayout {
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
  return { placed, outdated, general }
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
  const [measured, setLayout] = useState<MeasuredLayout>(EMPTY)
  const { heights, bubbleRef } = useBubbleHeights()
  const layout = useMemo(() => {
    const placed = spread(measured.placed, heights)
    const bottom = Math.max(0, ...placed.map((p) => (p.top ?? 0) + roomOf(heights.get(p.thread.comment_id))))
    return { ...measured, placed, bottom, bubbleRef }
  }, [measured, heights, bubbleRef])
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
