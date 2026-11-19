/**
 * @fileoverview "Focus this card's first field when its editor opens" (UX §3.3, §13.2: adding focuses the new item's
 * first field). The list asks as it adds a question or an ending; the editor takes the request when it mounts for
 * that card, once (`useRequestedFocus`).
 *
 * @module pages/FeedbackForms/questions/focusRequest
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const pending = new Set<string>()

/** Ask the editor of `id` to focus its first field when it opens. */
export function requestFocus(id: string): void {
  pending.add(id)
}

/** Whether a focus was asked for `id` (the request is used up). */
function takeFocusRequest(id: string): boolean {
  return pending.delete(id)
}

/** The ref of an editor's first field, which takes the focus when the editor of `id` opens after a request. */
export function useRequestedFocus<T extends HTMLElement>(id: string): RefObject<T | null> {
  const first = useRef<T>(null)
  useEffect(() => { if (takeFocusRequest(id)) first.current?.focus() }, [id])
  return first
}
