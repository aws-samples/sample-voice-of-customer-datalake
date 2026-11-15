/**
 * A feedback draft's outcomes as the banner lists them (docs/prototype-builder.md Part 3), as pure rules.
 *
 * The model answers per PIN; the editor selected ITEMS (pins folded by the feedback read). Each outcome is
 * named by its item (the screen and the tester's words, which the editor already saw in the Feedback dialog),
 * and two pins of one item with the same outcome and note read as one row. A pin the feedback read does not
 * list (gone, or past its caps) is named by its place in the draft's outcomes, the same number wherever the
 * banner names it (the outcomes and Apply's not-written line).
 *
 * @module pages/ProjectDetail/draftOutcomes
 */
import type { PinOutcome } from '../../api/prototypeDraftSchema'
import type { PinPlace } from '../../components/PrototypeFeedback/pinPlaces'

export interface OutcomeRow {
  readonly key: string
  readonly outcome: PinOutcome['outcome']
  readonly note: string
  /** null: the read does not list the pin (the row is named by `index`). */
  readonly place: PinPlace | null
  /** The pin's 1-based position in the draft's outcomes. */
  readonly index: number
}

/** The 1-based position of `pinId` in the draft's outcomes (0 when it has none). */
export const outcomeNumber = (outcomes: readonly PinOutcome[], pinId: string): number =>
  outcomes.findIndex((outcome) => outcome.pin_id === pinId) + 1

/** One row per item, outcome and note, in the answer's order. */
export function outcomeRows(outcomes: readonly PinOutcome[], places: ReadonlyMap<string, PinPlace>): OutcomeRow[] {
  const seen = new Set<string>()
  return outcomes.flatMap((outcome, index) => {
    const place = places.get(outcome.pin_id) ?? null
    const key = `${place?.itemId ?? outcome.pin_id}\u0000${outcome.outcome}\u0000${outcome.note}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ key, outcome: outcome.outcome, note: outcome.note, place, index: index + 1 }]
  })
}
