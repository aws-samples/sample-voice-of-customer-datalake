/**
 * @fileoverview The host half of the prototype pin widget: listens to the prototype
 * iframe, forwards a tester's pin to the PUBLIC `POST /feedback-forms/{form_id}/submit`
 * route (the prototype's CSP has no connect-src, so the widget cannot), and answers
 * the widget with the result.
 * @module components/PrototypePins/usePinBridge
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { api } from '../../api/client'
import { parseWidgetMessage, postToFrame, resultMessage } from './pinMessages'

interface PinBridgeOptions {
  /** The widget mounted (again — every frame load); `review` = `?review=1` in its URL. */
  readonly onReady?: (review: boolean) => void
  /** A pin was stored. */
  readonly onSubmitted?: () => void
}

export function usePinBridge(frameRef: RefObject<HTMLIFrameElement | null>, options: PinBridgeOptions): void {
  // Held in a ref so a new callback identity does not re-subscribe the listener.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      // Only OUR frame, and only same-origin: any other window's messages are ignored.
      if (frame === null) return
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return
      const message = parseWidgetMessage(event.data)
      if (!message) return
      if (message.type === 'ready') {
        optionsRef.current.onReady?.(message.review)
        return
      }
      void api.submitPrototypePin(message.formId, message.body).then(
        () => {
          postToFrame(frame, resultMessage(message.requestId, true))
          optionsRef.current.onSubmitted?.()
        },
        () => postToFrame(frame, resultMessage(message.requestId, false)),
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef])
}
