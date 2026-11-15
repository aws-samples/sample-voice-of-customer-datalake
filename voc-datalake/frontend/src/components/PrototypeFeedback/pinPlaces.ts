/**
 * @fileoverview The prototype feedback read (docs/prototype-builder.md Part 3) as one query, shared by the
 * Feedback dialog, the draft banner's outcomes and the assistant's Incorporate card, and where each pin is in it:
 * its item, screen, element and the tester's words.
 * @module components/PrototypeFeedback/pinPlaces
 */
import { useQuery } from '@tanstack/react-query'
import { prototypeFeedbackQueryKey } from '../../api/prototypePinsApi'
import { getPrototypeFeedback } from '../../api/prototypeFeedbackSchema'
import type { PrototypeFeedback } from '../../api/prototypeFeedbackSchema'

/** Where a pin is, as the feedback read lists it. */
export interface PinPlace {
  readonly itemId: string
  readonly screen: string
  /** The element's text, else its selector ('' when the pin names neither). */
  readonly element: string
  readonly text: string
}

/** The series' feedback read (EDIT on the project); `enabled` false reads nothing. */
export function usePrototypeFeedback(projectId: string, documentId: string, enabled = true) {
  return useQuery({
    queryKey: prototypeFeedbackQueryKey(projectId, documentId),
    queryFn: () => getPrototypeFeedback(projectId, documentId),
    enabled,
  })
}

/** Every pin of the read, by id, to the item that folds it. */
function pinPlaces(feedback: PrototypeFeedback | undefined): ReadonlyMap<string, PinPlace> {
  const places = new Map<string, PinPlace>()
  for (const group of feedback?.groups ?? []) {
    for (const item of group.items) {
      const place = { itemId: item.item_id, screen: group.route, element: item.anchor.text_snippet || item.anchor.selector, text: item.text }
      for (const pinId of item.pin_ids) places.set(pinId, place)
    }
  }
  return places
}

/** The pins' places, from the shared read. */
export function usePinPlaces(projectId: string, documentId: string, enabled = true): ReadonlyMap<string, PinPlace> {
  return pinPlaces(usePrototypeFeedback(projectId, documentId, enabled).data)
}
