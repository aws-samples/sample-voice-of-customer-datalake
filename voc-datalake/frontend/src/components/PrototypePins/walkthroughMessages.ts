/**
 * @fileoverview The postMessage contract between the prototype walkthrough runtime
 * (lambda/shared/static/prototype-walkthrough.js, inside the prototype frame) and this app
 * (docs/prototype-builder.md Part 1). The runtime hands over its own private MessageChannel port with
 * its ready message, as the pin widget does; everything after goes over that port. Every message from
 * the frame is untrusted: it only moves this page's own UI and the viewer's "don't show again" flag.
 *
 *   frame → host  {type:'voc-walkthrough', event:'ready', steps}                 (with the port)
 *                 {type:'voc-walkthrough', event:'done'|'skipped'|'dont-show-again'}
 *                 {type:'voc-walkthrough', event:'picked', selector?, anchor}  /  {…, event:'pick-cancelled'}
 *   host → frame  {type:'voc-walkthrough', action:'start', step?, steps?}  /  {…, action:'pick'}
 *
 * @module components/PrototypePins/walkthroughMessages
 */
import { z } from 'zod'
import { WALKTHROUGH_LIMITS, walkthroughAnchorSchema } from '../../api/prototypeWalkthroughSchema'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'

const TYPE = 'voc-walkthrough'

const WalkthroughMessageSchema = z.discriminatedUnion('event', [
  z.object({ type: z.literal(TYPE), event: z.literal('ready'), steps: z.number().int().min(0).max(WALKTHROUGH_LIMITS.steps) }),
  z.object({ type: z.literal(TYPE), event: z.enum(['done', 'skipped', 'dont-show-again']) }),
  z.object({
    type: z.literal(TYPE), event: z.literal('picked'),
    selector: z.string().min(1).max(WALKTHROUGH_LIMITS.selector).optional().catch(undefined),
    anchor: walkthroughAnchorSchema,
  }),
  z.object({ type: z.literal(TYPE), event: z.literal('pick-cancelled') }),
])

export type WalkthroughMessage = z.infer<typeof WalkthroughMessageSchema>

/** A validated walkthrough message, or null for anything else. */
export function parseWalkthroughMessage(data: unknown): WalkthroughMessage | null {
  const parsed = WalkthroughMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

type HostAction =
  | { readonly action: 'start'; readonly step?: number; readonly steps?: readonly WalkthroughStep[] }
  | { readonly action: 'pick' }

/** Post to the walkthrough on its private port; no port (a version without the runtime) sends nothing. */
export function postToWalkthrough(port: MessagePort | null, message: HostAction): void {
  port?.postMessage({ type: TYPE, ...message })
}
