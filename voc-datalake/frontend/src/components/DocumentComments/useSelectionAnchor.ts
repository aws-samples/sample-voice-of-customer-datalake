/**
 * @fileoverview The text a reader selected inside the document, as an anchor plus where to show
 * the "Comment" button (just below the selection, inside the document's box).
 *
 * Read on `pointerup` / `keyup` inside the document (a mouse drag, a touch selection, Shift+arrows),
 * cleared when the selection collapses. Nothing is read while `enabled` is false.
 *
 * @module components/DocumentComments/useSelectionAnchor
 */
import { useCallback, useEffect, useState } from 'react'
import { anchorOfSelection } from './anchors'
import type { RefObject } from 'react'
import type { TextQuoteAnchor } from '../../api/documentReviewSchema'

export interface SelectionAnchor {
  readonly anchor: TextQuoteAnchor
  /** Offset of the button from the document's top-left, in px. */
  readonly top: number
  readonly left: number
}

const BUTTON_OFFSET_PX = 6

export function useSelectionAnchor(rootRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [selected, setSelected] = useState<SelectionAnchor | null>(null)
  const read = useCallback(() => {
    const root = rootRef.current
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    const anchor = root === null ? null : anchorOfSelection(root, selection)
    if (root === null || anchor === null || selection === null) {
      setSelected(null)
      return
    }
    const box = selection.getRangeAt(0).getBoundingClientRect()
    const origin = root.getBoundingClientRect()
    setSelected({ anchor, top: box.bottom - origin.top + BUTTON_OFFSET_PX, left: Math.max(0, box.left - origin.left) })
  }, [rootRef])
  useEffect(() => {
    const root = rootRef.current
    if (!enabled || root === null) return undefined
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed ?? true) setSelected(null)
    }
    root.addEventListener('pointerup', read)
    root.addEventListener('keyup', read)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      root.removeEventListener('pointerup', read)
      root.removeEventListener('keyup', read)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [rootRef, enabled, read])
  const clear = useCallback(() => {
    setSelected(null)
    window.getSelection()?.removeAllRanges()
  }, [])
  return { selected: enabled ? selected : null, clear }
}
