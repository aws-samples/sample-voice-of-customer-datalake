/**
 * @fileoverview Fixtures shared by the Prioritization unit specs (the modules split
 * out of prioritizationUtils). Not a spec: imported by them.
 */
import { expect } from 'vitest'
import type { ProjectDocument } from '../../api/types'
import type { PrioritizationAggregate } from '../../api/projectTypes'
import { required } from '../../components/component-spec-fixtures'
import { DEFAULT_AXES, compositeScore } from '../../api/prioritizationAxes'

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

/** The four default axes as flat fields, the way the wire and the old fixtures spell them. */
type DefaultAxisFields = Partial<Record<'impact' | 'time_to_market' | 'confidence' | 'strategic_fit', number>>

/**
 * One row's PARSED team view on the default setup: unset axes 0 (nobody scored them), the
 * composite by THE CONTRACT formula unless one is given — what `teamRead` produces.
 */
export const aggregate = (
  fields: DefaultAxisFields & { reviewer_count: number; score_spread?: number; composite?: number | null },
): PrioritizationAggregate => {
  const means = Object.fromEntries(DEFAULT_AXES.map((axis) => [axis.id, fields[axisKey(axis.id)] ?? 0]))
  return {
    means,
    reviewer_count: fields.reviewer_count,
    score_spread: fields.score_spread ?? 0,
    composite: fields.composite === undefined ? compositeScore(DEFAULT_AXES, means) : fields.composite,
  }
}

function axisKey(id: string): keyof DefaultAxisFields {
  switch (id) {
    case 'time_to_market': return 'time_to_market'
    case 'confidence': return 'confidence'
    case 'strategic_fit': return 'strategic_fit'
    default: return 'impact'
  }
}

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
