/**
 * @fileoverview Fixtures shared by the Prioritization unit specs (the modules split
 * out of prioritizationUtils). Not a spec: imported by them.
 */
import { expect } from 'vitest'
import type { ProjectDocument } from '../../api/types'
import type { PrioritizationAggregate } from '../../api/projectTypes'
import { required } from '../../components/component-spec-fixtures'

/** Order-insensitive comparison of id lists: sort by the locale, as a reader would. */
export const byLocale = (a: string, b: string) => a.localeCompare(b)

export const project = (projectId: string, name: string) => ({
  project_id: projectId,
  name,
  description: '',
  status: 'active' as const,
  created_at: '',
  updated_at: '',
  persona_count: 0,
  document_count: 0,
})

export const doc = (
  documentId: string,
  documentType: ProjectDocument['document_type'],
  title: string,
  createdAt: string,
): ProjectDocument => ({
  document_id: documentId, document_type: documentType, title, content: '', created_at: createdAt,
})

/** A stored row record, as the wire sends it. */
export const storedRow = (
  rowId: string, projectId: string, documentIds: string[], prototypeId = '',
  isFrozen = false, isDefault = true,
) => ({
  row_id: rowId,
  project_id: projectId,
  document_ids: documentIds,
  prototype_id: prototypeId,
  is_default: isDefault,
  created_at: '2026-01-01',
  is_frozen: isFrozen,
})

/** One document's team view, all four axes at the same value unless told otherwise. */
export const aggregate = (
  fields: Partial<PrioritizationAggregate> & { reviewer_count: number },
): PrioritizationAggregate => ({
  impact: 0, time_to_market: 0, confidence: 0, strategic_fit: 0, score_spread: 0, ...fields,
})

/** `map[key]` of a normalized read, failing the spec when the read or the key is absent. */
export function entryOf<T>(map: Readonly<Record<string, T>> | undefined, key: string): T {
  const value = map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
  return required(value, `an entry for ${key}`)
}

/** The single item of `list`, failing the spec unless there is exactly one. */
export function onlyItem<T>(list: readonly T[], what: string): T {
  expect(list, what).toHaveLength(1)
  return required(list.at(0), what)
}

/**
 * A declared derivation naming `ids` as sources in the reference role, as
 * `lambda/shared/derivation.py` writes it — spread into a document fixture.
 */
export const builtFrom = (...ids: readonly string[]) => ({
  derivation: {
    sources: ids.map((id) => ({ document_id: id, role: 'reference' })),
    selected_document_count: ids.length,
    feedback_count: 0,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
})
