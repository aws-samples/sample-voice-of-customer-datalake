/**
 * @fileoverview The host half of the prototype pin widget AND of the walkthrough runtime: listens to the
 * prototype iframe, forwards a tester's pin (and, since 7.68.00, the validation card's request, asked once per form for
 * the page session through the query cache, and answers) to the PUBLIC `POST /feedback-forms/{form_id}/submit` route and answers the widget with
 * the result; hands the walkthrough's
 * messages to the page
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
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { apiErrorCode } from '../../lib/errors'
import { isRecord } from '../../lib/typeGuards'
import { cardResultMessage, isPrototypeFrameOrigin, parseWidgetMessage, postToWidget, resultMessage } from './pinMessages'
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
 * The validation card a framed prototype asks for, per form, in the page's query cache (7.68.00; the `feedbackData`
 * family's five minutes, api/queryPolicies.ts): every frame load asks the host for it, and each ask is a request on
 * the PUBLIC submit route, whose throttle every form shares. The Validate tab's save removes them all, so the next
 * frame load shows the card as saved. A prototype opened standalone asks its submit route itself, once a page load:
 * its document is sandboxed to an opaque origin with no storage, and its CSP's single `connect-src` is that one URL.
 */
export const prototypeCardKeys = {
  all: ['prototype-card'] as const,
  form: (formId: string) => ['prototype-card', formId] as const,
}
/** The submit route's answer to a card request on a form that asks no validation questions: "no card", kept too. */
const NO_CARD = { status: 400, code: 'validation_closed' } as const

/** The card of `formId`, or null when the form asks none; a failure that is not that refusal (no network, a 5xx, a
 * 429) is not kept and not retried (the next frame load asks again: a retry would be one more request on the shared
 * public throttle). Kept for the `prototype-card` family's five minutes (api/queryPolicies.ts). */
function cardOf(queryClient: QueryClient, formId: string, body: unknown): Promise<unknown> {
  return queryClient.query({
    queryKey: prototypeCardKeys.form(formId),
    queryFn: async () => {
      try {
        const answer = await api.submitPrototypePin(formId, body)
        return isRecord(answer) ? (answer['card'] ?? null) : null
      } catch (error: unknown) {
        if (apiErrorStatus(error) === NO_CARD.status && apiErrorCode(error) === NO_CARD.code) return null
        throw error
      }
    },
    retry: false,
  })
}

/**
 * The validation card (7.68.00): its request (once per form for the page session, `cardOf`) or an answer on the same
 * public route, the result (the card, or the answer's) handed back on `port`.
 */
function forwardCard(queryClient: QueryClient, message: { readonly type: 'card' | 'answer'; readonly formId: string;
                       readonly requestId: string; readonly body: unknown }, port: MessagePort | null): void {
  const asked = message.type === 'card' ? cardOf(queryClient, message.formId, message.body)
    : api.submitPrototypePin(message.formId, message.body).then(() => null)
  void asked.then(
    (card) => postToWidget(port, cardResultMessage(message.type, message.requestId, true, card ?? undefined)),
    () => postToWidget(port, cardResultMessage(message.type, message.requestId, false)),
  )
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
  const queryClient = useQueryClient()

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
      if (message.type === 'card' || message.type === 'answer') {
        forwardCard(queryClient, message, port)
        return
      }
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
  }, [frameRef, queryClient])

  return portRef
}
