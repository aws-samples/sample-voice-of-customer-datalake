/**
 * @fileoverview The postMessage contract between the prototype pin widget
 * (lambda/shared/static/prototype-pin-widget.js, inside the prototype iframe) and
 * this app (its host frame). Everything the widget sends is validated here before
 * it is acted on: the prototype runs model-authored script (in an opaque-origin sandbox), so
 * a message from the frame is input, not a trusted call.
 * @module components/PrototypePins/pinMessages
 */
import { z } from 'zod'
import type { PrototypePin } from '../../api/prototypePinsApi'

const FORM_ID = /^pf_[0-9a-f]{16}$/
const MAX_COMMENT_CHARS = 2000

const SubmitMessageSchema = z.object({
  source: z.literal('voc-pin-widget'),
  type: z.literal('submit'),
  formId: z.string().regex(FORM_ID),
  requestId: z.string().min(1).max(40),
  body: z.object({
    text: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
    // Shape and size are the server's to check (shared/prototype_pins.py); here it
    // only has to be an object, so nothing but a pin is forwarded.
    pin: z.record(z.string(), z.unknown()),
  }),
})

// The validation card (7.68.00, lambda/shared/prototype_validation.py): an empty response asks for the card, any other
// answers it. Shape and bounds are the server's to check; here only what can be an answer is forwarded.
const MAX_ANSWERS = 30
const MAX_ANSWER_TEXT = 5000
const AnswerValueSchema = z.union([
  z.number().int(), z.string().max(MAX_ANSWER_TEXT), z.object({ code: z.string().max(40) }).strict(),
])
const CardBodySchema = z.object({
  answers: z.record(z.string().max(44), AnswerValueSchema).refine((answers) => Object.keys(answers).length <= MAX_ANSWERS),
  form_revision: z.number().int().positive().optional(),
  language: z.string().max(10).optional(),
}).strict()

const CardMessageSchema = z.object({
  source: z.literal('voc-pin-widget'),
  type: z.enum(['card', 'answer']),
  formId: z.string().regex(FORM_ID),
  requestId: z.string().min(1).max(40),
  body: CardBodySchema,
})

const ReadyMessageSchema = z.object({
  source: z.literal('voc-pin-widget'),
  type: z.literal('ready'),
  formId: z.string().regex(FORM_ID),
  review: z.boolean().catch(false),
})

const WidgetMessageSchema = z.union([SubmitMessageSchema, ReadyMessageSchema, CardMessageSchema])

type WidgetMessage = z.infer<typeof WidgetMessageSchema>

/** A validated widget message, or null for anything else (other scripts' messages included). */
export function parseWidgetMessage(data: unknown): WidgetMessage | null {
  const parsed = WidgetMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

interface MarkerPin {
  readonly pin_id: string
  readonly number: number
  readonly selector: string
  readonly bbox: PrototypePin['anchor']['bbox']
  readonly status: PrototypePin['status']
}

type HostMessage =
  | { readonly source: 'voc-pin-host'; readonly type: 'result'; readonly requestId: string; readonly ok: boolean }
  | { readonly source: 'voc-pin-host'; readonly type: 'card' | 'answer'; readonly requestId: string; readonly ok: boolean
    readonly card?: unknown }
  | { readonly source: 'voc-pin-host'; readonly type: 'show'; readonly pins: readonly MarkerPin[] }
  | { readonly source: 'voc-pin-host'; readonly type: 'hide' }

export const resultMessage = (requestId: string, ok: boolean): HostMessage =>
  ({ source: 'voc-pin-host', type: 'result', requestId, ok })

/** The answer to a card request (`card`: the server's card, which the widget checks before it draws it) or to an answer. */
export const cardResultMessage = (type: 'card' | 'answer', requestId: string, ok: boolean, card?: unknown): HostMessage =>
  ({ source: 'voc-pin-host', type, requestId, ok, ...(card === undefined ? {} : { card }) })

/** Markers only — selector, position, status and number. Comments never enter the frame. */
export const showMessage = (pins: readonly PrototypePin[]): HostMessage => ({
  source: 'voc-pin-host',
  type: 'show',
  pins: pins.map((pin, index) => ({
    pin_id: pin.pin_id, number: index + 1, selector: pin.anchor.selector, bbox: pin.anchor.bbox, status: pin.status,
  })),
})

export const hideMessage = (): HostMessage => ({ source: 'voc-pin-host', type: 'hide' })

/**
 * Post to the prototype widget on the private port it handed over with its ready
 * message (event.ports[0]). The frame is sandboxed without `allow-same-origin`
 * (its CSP, lib/utils/prototype-csp.ts, and the iframe attribute), so its origin
 * is OPAQUE and no window targetOrigin short of `'*'` could reach it; the port
 * reaches exactly the widget that created it and nothing else. No port (a widget
 * that predates it) → nothing is sent.
 */
export function postToWidget(port: MessagePort | null, message: HostMessage): void {
  port?.postMessage(message)
}

/**
 * The origins a message from the prototype frame may carry: `'null'` (the opaque
 * origin its sandbox gives it) or this app's own (a response served before the
 * sandbox existed). A frame navigated to any other site is refused even though it
 * is still the same `contentWindow`.
 */
export function isPrototypeFrameOrigin(origin: string): boolean {
  return origin === 'null' || origin === window.location.origin
}
