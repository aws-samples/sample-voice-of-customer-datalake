/**
 * @fileoverview The validation card a framed prototype's pin widget asks for (7.68.00), kept per form for the page
 * session. Every load of a prototype frame (a version opened, a tab reopened, a reload) asks the host for the card,
 * and each ask was one request on the PUBLIC `POST /feedback-forms/{form_id}/submit` route, whose throttle every form
 * shares. So the host asks once per form and hands every later load the same answer for five minutes: the card, or
 * the 400 of a form that asks none. A failure that is not that refusal (no network, a 5xx, a 429) is not kept, so the
 * next load asks again; saving the card on the Validate tab forgets every answer, so the next load shows the new one.
 *
 * A prototype opened standalone asks its submit route itself, once per page load: its document is sandboxed to an
 * opaque origin (lib/utils/prototype-csp.ts), which has no storage to keep an answer in, and its CSP's single
 * `connect-src` is that one URL.
 * @module components/PrototypePins/prototypeCardCache
 */
import { apiErrorStatus } from '../../api/apiErrorStatus'

/** How long an answer stands: a card opened or closed meanwhile on another device shows after it. */
const CARD_TTL_MS = 5 * 60 * 1000
/** The submit route's answer to a card request on a form that asks no validation questions (`validation_closed`). */
const NO_CARD_STATUS = 400

interface KeptCard {
  readonly at: number
  readonly answer: Promise<unknown>
}

const cards = new Map<string, KeptCard>()

/** The card answer of `formId`: the one asked within the last five minutes, else `ask()`'s, kept unless it fails
 * otherwise than the form's refusal. */
export function cachedCard(formId: string, ask: () => Promise<unknown>, now: number = Date.now()): Promise<unknown> {
  const kept = cards.get(formId)
  if (kept !== undefined && now - kept.at < CARD_TTL_MS) return kept.answer
  const entry: KeptCard = { at: now, answer: ask() }
  cards.set(formId, entry)
  entry.answer.catch((error: unknown) => {
    if (apiErrorStatus(error) !== NO_CARD_STATUS && cards.get(formId) === entry) cards.delete(formId)
  })
  return entry.answer
}

/** Forget every kept answer: the card was saved, so the next frame load asks again. */
export function forgetPrototypeCards(): void {
  cards.clear()
}
