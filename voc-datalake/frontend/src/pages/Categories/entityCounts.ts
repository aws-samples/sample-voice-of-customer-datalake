/**
 * @fileoverview Lenient reads of the count maps in a `/feedback/entities` response.
 * @module pages/Categories/entityCounts
 *
 * `EntitiesResponse` declares every map, but the filter dropdowns that read them
 * (Categories, Problem Analysis) have always tolerated a response, or a map,
 * that is missing — the wire-shape rule: never trust runtime data to match the
 * declared type. Parsing here keeps that tolerance without optional chains the
 * declared type calls unnecessary.
 */
import { z } from 'zod'

const CountMapSchema = z.record(z.string(), z.number().catch(0)).catch({})

const EntityCountsSchema = z.object({
  entities: z.object({
    sources: CountMapSchema,
    categories: CountMapSchema,
  }).catch({ sources: {}, categories: {} }),
})

type EntityAxis = 'sources' | 'categories'

/** `entities[axis]` of an entities response; `{}` when the response or the map is absent or malformed. */
function entityCounts(response: unknown, axis: EntityAxis): Readonly<Record<string, number>> {
  const parsed = EntityCountsSchema.safeParse(response)
  return parsed.success ? parsed.data.entities[axis] : {}
}

/** The keys of `entities[axis]`, most frequent first. */
export function rankEntityKeys(response: unknown, axis: EntityAxis): string[] {
  const counts = new Map(Object.entries(entityCounts(response, axis)))
  return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
}
