/**
 * @fileoverview The host half of the prototype pin widget AND of the walkthrough runtime: listens to the
 * prototype iframe, forwards a tester's pin to the PUBLIC `POST /feedback-forms/{form_id}/submit`
 * route and answers the widget with the result; hands the walkthrough's messages to the page
 * (docs/prototype-builder.md Part 1). Framed, the widget always uses this bridge; only a prototype
 * opened standalone posts to that route itself (the one connect-src its CSP allows, docs/feedback-forms.md).
 *
 * The frame is sandboxed to an OPAQUE origin (lib/utils/prototype-csp.ts), so the
 * host cannot address it by origin. The widget, and the walkthrough runtime on its own, hand over a
 * private MessageChannel port with every ready message; answers, markers and the walkthrough's
 * start / pick go back on those ports only. A draft's frame has no bridge at all (6.12.00).
 * @module components/PrototypePins/usePinBridge
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { api } from '../../api/client'
import { isPrototypeFrameOrigin, parseWidgetMessage, postToWidget, resultMessage } from './pinMessages'
import { parseWalkthroughMessage } from './walkthroughMessages'
import type { WalkthroughMessage } from './walkthroughMessages'

interface PinBridgeOptions {
  /** The widget mounted (again — every frame load); `review` = `?review=1` in its URL. */
  readonly onReady?: (review: boolean) => void
  /** A pin was stored. */
  readonly onSubmitted?: () => void
  /**
   * A walkthrough message (its ready one included, once its port is adopted), with the port to answer on.
   * Untrusted: UI and the viewer's flag only.
   */
  readonly onWalkthrough?: (message: WalkthroughMessage, port: MessagePort | null) => void
}

/** The port of the latest ready message, swapped in (old one closed) on each frame load. */
function adoptPort(portRef: { current: MessagePort | null }, port: MessagePort | undefined): void {
  if (portRef.current !== null && portRef.current !== port) portRef.current.close()
  portRef.current = port ?? null
}

/** Listen on the walkthrough's own port: what it sends there is checked like any frame message. */
function listen(port: MessagePort | undefined, handle: (message: WalkthroughMessage) => void): void {
  if (port === undefined) return
  port.onmessage = (event: MessageEvent) => {
    const message = parseWalkthroughMessage(event.data)
    if (message !== null && message.event !== 'ready') handle(message)
  }
}

/**
 * Returns the pin widget's port (markers; null until it sends one). The walkthrough's port goes to
 * `onWalkthrough` with each of its messages.
 */
export function usePinBridge(frameRef: RefObject<HTMLIFrameElement | null>, options: PinBridgeOptions): RefObject<MessagePort | null> {
  // Held in a ref so a new callback identity does not re-subscribe the listener.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const portRef = useRef<MessagePort | null>(null)
  const walkthroughRef = useRef<MessagePort | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      // Only OUR frame (identity of the window: the sandboxed prototype's origin is
      // opaque, 'null'), and never a frame navigated to another site. Any other
      // window's messages are ignored; the payload is schema-checked below.
      if (frame === null) return
      if (event.source !== frame.contentWindow || !isPrototypeFrameOrigin(event.origin)) return
      const walkthrough = parseWalkthroughMessage(event.data)
      if (walkthrough?.event === 'ready') {
        adoptPort(walkthroughRef, event.ports[0])
        listen(event.ports[0], (message) => { optionsRef.current.onWalkthrough?.(message, walkthroughRef.current) })
        optionsRef.current.onWalkthrough?.(walkthrough, walkthroughRef.current)
        return
      }
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
      adoptPort(walkthroughRef, undefined)
    }
  }, [frameRef])

  return portRef
}
