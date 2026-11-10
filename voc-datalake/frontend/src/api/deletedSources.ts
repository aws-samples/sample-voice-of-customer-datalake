/**
 * @fileoverview What a document cited that was later deleted (`deleted_sources`, lambda/shared/deleted_sources.py).
 *
 * When a persona, a document or a product doc is deleted, every document of the project that
 * was written from it gains an entry `{kind, id, deleted_at, name?}`; the ids stay in its
 * `derivation` (lineage). `name` is present for a persona only (a fictional archetype).
 * Lenient at the boundary: an unusable entry costs only itself.
 * @module api/deletedSources
 */

import { z } from 'zod'

const DELETED_SOURCE_KINDS = ['persona', 'document', 'product_doc'] as const

const DeletedSourceSchema = z.object({
  kind: z.enum(DELETED_SOURCE_KINDS),
  id: z.string().min(1),
  name: z.string().min(1).optional().catch(undefined),
  deleted_at: z.string().catch(''),
})

export type DeletedSource = z.output<typeof DeletedSourceSchema>

/** The usable entries of a stored `deleted_sources` value; [] for anything that is not a list. */
function normalizeDeletedSources(raw: unknown): DeletedSource[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const parsed = DeletedSourceSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * The document boundary's reading: the usable entries, or undefined when there are none (the
 * boundary then leaves the key out, so a document that never lost a source keeps its old shape).
 */
export function deletedSourcesOrUndefined(raw: unknown): DeletedSource[] | undefined {
  const sources = normalizeDeletedSources(raw)
  return sources.length > 0 ? sources : undefined
}

/** The notice a document shows: each deleted persona's name, and whether any unnamed one / document / product doc was cited. */
interface DeletedSourcesSummary {
  readonly personaNames: readonly string[]
  readonly unnamedPersona: boolean
  readonly document: boolean
  readonly productDoc: boolean
}

export function summarizeDeletedSources(sources: readonly DeletedSource[]): DeletedSourcesSummary | null {
  if (sources.length === 0) return null
  const personas = sources.filter((source) => source.kind === 'persona')
  const personaNames = [...new Set(personas.flatMap((source) => (source.name === undefined ? [] : [source.name])))]
  return {
    personaNames,
    unnamedPersona: personas.some((source) => source.name === undefined),
    document: sources.some((source) => source.kind === 'document'),
    productDoc: sources.some((source) => source.kind === 'product_doc'),
  }
}
