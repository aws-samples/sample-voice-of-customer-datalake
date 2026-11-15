/**
 * @fileoverview What the page's View menu switches, for as long as the page is open: the comments panel (a PR/FAQ or
 * PRD; shown at first), the outline ("Contents", shown at first) and the full width (off: the text keeps its
 * comfortable line length). `revealComments` shows the panel again when a comment is started while it is hidden.
 *
 * @module components/DocumentCanvas/page/usePageView
 */
import { useCallback, useMemo, useState } from 'react'
import type { CanvasViewControls } from '../actions/canvasMenus'

export interface PageView extends CanvasViewControls {
  readonly revealComments: () => void
}

const flip = (on: boolean) => !on

export function usePageView(commentable: boolean): PageView {
  const [comments, setComments] = useState(true)
  const [outline, setOutline] = useState(true)
  const [fullWidth, setFullWidth] = useState(false)
  const revealComments = useCallback(() => setComments(true), [])
  return useMemo(() => ({
    comments: commentable ? { on: comments, toggle: () => setComments(flip) } : undefined,
    outline: { on: outline, toggle: () => setOutline(flip) },
    fullWidth: { on: fullWidth, toggle: () => setFullWidth(flip) },
    revealComments,
  }), [commentable, comments, fullWidth, outline, revealComments])
}
