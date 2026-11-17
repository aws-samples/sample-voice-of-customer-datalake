/**
 * @fileoverview The Registry's addresses (7.52.00), as paths (utils/pathPlace.ts, the path-URL rule):
 *
 * - `/agents/registry`: the agent cards (the roles' and the ones made from a skill);
 * - `/agents/registry/gates`: its **Quality gates** filter (the owner moved Quality gates into the Registry);
 * - `/agents/registry/gates/briefs/<id>`: an owner's gate brief on a page of its own (the panel's "Open full page");
 * - `/agents/registry/<card>`: one card (a role's id, `fixer`, or a made card's, `fixer-careful`).
 *
 * `gates` is never a card's id: a role's id is one of the bundle's roles and a made card's is `<role>-<slug>`. The
 * scope a card is composed for stays a filter of the query (`?connection=`). Anything else is replaced by the nearest
 * place it names, in place.
 *
 * @module pages/Agents/Registry/registryPaths
 */
import { pathOf, segmentsUnder } from '../../../utils/pathPlace'
import type { Address, PlaceRead } from '../../../utils/pathPlace'

export const REGISTRY_PATH = '/agents/registry'
const GATES = 'gates'
const BRIEFS = 'briefs'
/** A card's id (engineering/registry/cards.py CARD_ID) and a brief's (the bundle's ids). */
const CARD_ID = /^[a-z][a-z0-9-]{0,63}$/u
const BRIEF_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export type RegistryPlace =
  | { readonly view: 'cards' }
  | { readonly view: 'gates' }
  | { readonly view: 'brief'; readonly brief: string }
  | { readonly view: 'card'; readonly card: string }

/** The Registry's filters, in the order the segmented control shows them. */
export const REGISTRY_FILTERS = ['cards', 'gates'] as const
export type RegistryFilter = (typeof REGISTRY_FILTERS)[number]

export function registryPath(place: RegistryPlace): string {
  switch (place.view) {
    case 'cards': return REGISTRY_PATH
    case 'gates': return pathOf(['agents', 'registry', GATES])
    case 'brief': return pathOf(['agents', 'registry', GATES, BRIEFS, place.brief])
    default: return pathOf(['agents', 'registry', place.card])
  }
}

/** An owner's brief on its own page (`/agents/registry/gates/briefs/<id>`). */
export const gateBriefPath = (brief: string) => registryPath({ view: 'brief', brief })

/** A card's page (`/agents/registry/<card>`). */
export const registryCardPath = (card: string) => registryPath({ view: 'card', card })

/** The filter a place sits under (a card under the cards, a brief under the gates). */
export function filterOf(place: RegistryPlace): RegistryFilter {
  return place.view === 'gates' || place.view === 'brief' ? 'gates' : 'cards'
}

function placeOf(segments: readonly string[]): { readonly place: RegistryPlace; readonly own: boolean } {
  const [first, second, third, ...rest] = segments
  if (first === undefined) return { place: { view: 'cards' }, own: true }
  if (first === GATES) {
    if (second === undefined) return { place: { view: 'gates' }, own: true }
    if (second === BRIEFS && third !== undefined && BRIEF_ID.test(third)) {
      return { place: { view: 'brief', brief: third }, own: rest.length === 0 }
    }
    return { place: { view: 'gates' }, own: false }
  }
  if (!CARD_ID.test(first)) return { place: { view: 'cards' }, own: false }
  return { place: { view: 'card', card: first }, own: second === undefined }
}

/** The place an address of the Registry names and the address to replace it with (null: its own); null off it. */
export function readRegistryAddress(address: Address): PlaceRead<RegistryPlace> | null {
  const segments = segmentsUnder(REGISTRY_PATH, address.pathname)
  if (segments === null) return null
  const { place, own } = placeOf(segments)
  return { place, replaceWith: own ? null : { pathname: registryPath(place), search: address.search } }
}
