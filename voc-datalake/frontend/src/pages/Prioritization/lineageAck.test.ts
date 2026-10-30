/**
 * "Keep both versions" (#399): an acknowledged crossing reads as acknowledged only for
 * the document set it was given for. Driven through `rowLineageOf`, so the classifier's
 * real answer is what the mark is applied to, and through `collectRows`, so the wiring
 * from the stored row is covered too.
 */
import { describe, it, expect } from 'vitest'
import { isLineageAcknowledged, withLineageAck } from './lineageAck'
import { rowLineageOf } from './rowLineage'
import { collectRows } from './rowCollection'
import { doc, onlyItem, project, storedRow } from './prioritization-unit-fixtures'

const prd1 = doc('prd_1', 'prd', 'PRD v1', '2026-01-01T00:00:00+00:00')
const prd2 = doc('prd_2', 'prd', 'PRD v2', '2026-02-01T00:00:00+00:00')
const prfaq1 = doc('prfaq_1', 'prfaq', 'PR/FAQ', '2026-02-02T00:00:00+00:00')
const projectDocs = [prd1, prd2, prfaq1]
const ack = (documentIds: string[]) => ({ document_ids: documentIds, acknowledged_at: '2026-03-01T00:00:00+00:00' })

/** Two PRD versions in one row: `crossGeneration` / `repeatedType`. */
const twoVersions = rowLineageOf({ is_frozen: false, documents: [prd2, prd1] }, projectDocs)

describe('isLineageAcknowledged', () => {
  it('starts from a row the classifier calls a crossing', () => {
    expect(twoVersions).toMatchObject({ state: 'crossGeneration', reason: 'repeatedType' })
  })

  it('acknowledges a crossing whose mark names the row set, in any order', () => {
    expect(isLineageAcknowledged(twoVersions, ack(['prd_1', 'prd_2']), ['prd_2', 'prd_1'])).toBe(true)
  })

  it('re-warns once the row holds a set the mark does not name', () => {
    // Recomposed after the mark: one more document, one fewer, or a swapped one.
    expect(isLineageAcknowledged(twoVersions, ack(['prd_1', 'prd_2']), ['prd_1', 'prd_2', 'prfaq_1'])).toBe(false)
    expect(isLineageAcknowledged(twoVersions, ack(['prd_1', 'prd_2']), ['prd_2'])).toBe(false)
    expect(isLineageAcknowledged(twoVersions, ack(['prd_1', 'prd_2']), ['prd_2', 'prfaq_1'])).toBe(false)
  })

  it('does not count a repeated id as covering a different document', () => {
    expect(isLineageAcknowledged(twoVersions, ack(['prd_1', 'prd_1']), ['prd_1', 'prd_2'])).toBe(false)
  })

  it('does nothing without a mark', () => {
    expect(isLineageAcknowledged(twoVersions, null, ['prd_1', 'prd_2'])).toBe(false)
    expect(isLineageAcknowledged(twoVersions, undefined, ['prd_1', 'prd_2'])).toBe(false)
  })

  it('never acknowledges a row that is not a crossing', () => {
    const coherentOrAbsent = rowLineageOf({ is_frozen: false, documents: [prd2, prfaq1] }, projectDocs)
    expect(coherentOrAbsent.state).not.toBe('crossGeneration')
    expect(isLineageAcknowledged(coherentOrAbsent, ack(['prd_2', 'prfaq_1']), ['prd_2', 'prfaq_1'])).toBe(false)
  })
})

describe('withLineageAck', () => {
  it('marks an acknowledged crossing and keeps the classification', () => {
    const marked = withLineageAck(twoVersions, { document_ids: ['prd_1', 'prd_2'], lineage_ack: ack(['prd_2', 'prd_1']) })
    expect(marked).toStrictEqual({ ...twoVersions, acknowledged: true })
  })

  it('hands back the very same lineage when the mark does not apply', () => {
    const row = { document_ids: ['prd_1', 'prd_2', 'prfaq_1'], lineage_ack: ack(['prd_1', 'prd_2']) }
    expect(withLineageAck(twoVersions, row)).toBe(twoVersions)
    expect(withLineageAck(twoVersions, { document_ids: ['prd_1', 'prd_2'] })).toBe(twoVersions)
  })
})

describe('collectRows carries the stored mark onto the row', () => {
  const details = [{ documents: projectDocs }]
  const projects = [project('p1', 'P1')]
  const rowWith = (documentIds: string[], lineageAck: ReturnType<typeof ack> | null) => ({
    'row-1': { ...storedRow('row-1', 'p1', documentIds), lineage_ack: lineageAck },
  })

  it('an acknowledged set suppresses the warning', () => {
    const row = onlyItem(collectRows(rowWith(['prd_1', 'prd_2'], ack(['prd_1', 'prd_2'])), details, projects), 'row')
    expect(row.lineage).toMatchObject({ state: 'crossGeneration', acknowledged: true })
  })

  it('a changed set warns again', () => {
    const row = onlyItem(collectRows(rowWith(['prd_1', 'prd_2', 'prfaq_1'], ack(['prd_1', 'prd_2'])), details, projects), 'row')
    expect(row.lineage.state).toBe('crossGeneration')
    expect(row.lineage.acknowledged).toBeUndefined()
  })

  it('compares against the STORED set, so a deleted member re-warns', () => {
    // prd_9 no longer resolves: the row shows prd_1 + prd_2, but the mark named the
    // stored set, and the stored set is not what was acknowledged.
    const row = onlyItem(collectRows(rowWith(['prd_1', 'prd_2', 'prd_9'], ack(['prd_1', 'prd_2'])), details, projects), 'row')
    expect(row.lineage.acknowledged).toBeUndefined()
  })

  it('flags a row whose stored set did not fully resolve, so the mark is not offered for it', () => {
    const truncated = onlyItem(collectRows(rowWith(['prd_1', 'prd_2', 'prd_9'], null), details, projects), 'row')
    const whole = onlyItem(collectRows(rowWith(['prd_1', 'prd_2'], null), details, projects), 'row')
    expect(truncated.composition_truncated).toBe(true)
    expect(whole.composition_truncated).toBe(false)
  })

  it.each([
    ['an editor', { role: 'editor' as const, can_view: true, can_edit: true, can_manage: false }, true],
    ['a viewer', { role: 'viewer' as const, can_view: true, can_edit: false, can_manage: false }, false],
    ['a project without access fields', undefined, false],
  ])('carries whether the caller may edit the project for %s', (_who, access, canEdit) => {
    const withAccess = [{ ...project('p1', 'P1'), access }]
    const row = onlyItem(collectRows(rowWith(['prd_1', 'prd_2'], null), details, withAccess), 'row')
    expect(row.can_edit).toBe(canEdit)
  })
})
