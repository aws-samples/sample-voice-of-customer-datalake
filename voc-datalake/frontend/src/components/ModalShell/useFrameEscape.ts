/**
 * @fileoverview Escape from INSIDE an opaque-origin frame in a dialog (#386).
 *
 * A prototype frame is sandboxed without `allow-same-origin`, so this page can neither
 * hear its keys nor listen inside it (ModalShell's NESTED FRAMES note). The prototype's
 * pin widget (lambda/shared/static/prototype-pin-widget.js) therefore forwards an Escape
 * it does not use itself as `{source: 'voc-pin-widget', type: 'escape'}`, and this hook
 * turns that message into the dialog's own Escape.
 *
 * The message is input from model-authored script, so it is accepted only when its
 * window is the `contentWindow` of a frame inside THIS panel, its origin is the
 * prototype's (`isPrototypeFrameOrigin`: opaque `'null'` or this app's own), and its
 * payload matches the schema exactly. A frame elsewhere on the page, or one navigated
 * to another site, cannot close the dialog.
 *
 * @module components/ModalShell/useFrameEscape
 */
import { useEffect, type RefObject } from 'react'
import { z } from 'zod'
import { isPrototypeFrameOrigin } from '../PrototypePins/pinMessages'
import { noCleanup } from '../../hooks/noCleanup'

const FrameEscapeSchema = z.strictObject({
  source: z.literal('voc-pin-widget'),
  type: z.literal('escape'),
})

/** Whether `data` is the widget's escape message (and nothing more). */
function isFrameEscapeMessage(data: unknown): boolean {
  return FrameEscapeSchema.safeParse(data).success
}

function isFrameOf(panel: HTMLElement, source: MessageEventSource | null): boolean {
  if (source === null) return false
  return [...panel.querySelectorAll('iframe')].some((frame) => Object.is(frame.contentWindow, source))
}

/**
 * While `isOpen`, calls `onEscape` for an escape message from a frame inside `panelRef`.
 * Pass a stable `onEscape` (ModalShell's reads its refs): a new identity re-subscribes the listener.
 */
export function useFrameEscape(panelRef: RefObject<HTMLElement | null>, isOpen: boolean, onEscape: () => void): void {
  useEffect(() => {
    const panel = panelRef.current
    if (!isOpen || panel === null) return noCleanup
    const onMessage = (event: MessageEvent) => {
      if (!isPrototypeFrameOrigin(event.origin) || !isFrameOf(panel, event.source)) return
      if (isFrameEscapeMessage(event.data)) onEscape()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [panelRef, isOpen, onEscape])
}
