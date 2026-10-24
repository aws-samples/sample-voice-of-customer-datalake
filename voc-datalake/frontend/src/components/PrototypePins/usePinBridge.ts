/**
 * @fileoverview The host half of the prototype pin widget: listens to the prototype
 * iframe, forwards a tester's pin to the PUBLIC `POST /feedback-forms/{form_id}/submit`
 * route, and answers the widget with the result. Framed, the widget always uses this
 * bridge; only a prototype opened standalone posts to that route itself (the one
 * connect-src its CSP allows, docs/feedback-forms.md).
 *
 * The frame is sandboxed to an OPAQUE origin (lib/utils/prototype-csp.ts), so the
 * host cannot address it by origin. The widget hands over a private MessagePort
 * with every ready message; answers and markers go back on that port only.
 * @module components/PrototypePins/usePinBridge
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { api } from '../../api/client'
import { isPrototypeFrameOrigin, parseWidgetMessage, postToWidget, resultMessage } from './pinMessages'

interface PinBridgeOptions {
  /** The widget mounted (again — every frame load); `review` = `?review=1` in its URL. */
  readonly onReady?: (review: boolean) => void
  /** A pin was stored. */
  readonly onSubmitted?: () => void
}

/** The port of the widget's latest ready message, swapped in (old one closed) on each frame load. */
function adoptPort(portRef: { current: MessagePort | null }, port: MessagePort | undefined): void {
  if (portRef.current !== null && portRef.current !== port) portRef.current.close()
  portRef.current = port ?? null
}

/** Returns the widget's port (null until a widget that sends one is ready), for markers. */
export function usePinBridge(
  frameRef: RefObject<HTMLIFrameElement | null>, options: PinBridgeOptions,
): RefObject<MessagePort | null> {
  // Held in a ref so a new callback identity does not re-subscribe the listener.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const portRef = useRef<MessagePort | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      // Only OUR frame (identity of the window: the sandboxed prototype's origin is
      // opaque, 'null'), and never a frame navigated to another site. Any other
      // window's messages are ignored; the payload is schema-checked below.
      if (frame === null) return
      if (event.source !== frame.contentWindow || !isPrototypeFrameOrigin(event.origin)) return
      const message = parseWidgetMessage(event.data)
      if (!message) return
      if (message.type === 'ready') {
        adoptPort(portRef, event.ports[0])
        optionsRef.current.onReady?.(message.review)
        return
      }
      // The port at submit time: a reload in between hands over a new widget, which
      // never asked and must not be told.
      const port = portRef.current
      void api.submitPrototypePin(message.formId, message.body).then(
        () => {
          postToWidget(port, resultMessage(message.requestId, true))
          optionsRef.current.onSubmitted?.()
        },
        () => postToWidget(port, resultMessage(message.requestId, false)),
      )
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      adoptPort(portRef, undefined)
    }
  }, [frameRef])

  return portRef
}
