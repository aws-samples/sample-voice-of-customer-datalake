/**
 * What the History list says about the page's document: its own version (a series row by its id, a revision the
 * current one), the latest number (the current row's, else the highest, none for an empty list), and what choosing a
 * row means (back to its own, on to the series' latest document, or an older version read only).
 */
import { describe, expect, it } from 'vitest'
import { normalizeDocumentVersions } from '../../../api/projectDetailSchema'
import { choiceOf, latestNumber, ownVersion } from './versionChoices'
import { custom, prd } from './canvas-document-fixtures'

/** The PRD series: v3 (the latest, its own document), v2 (the page's), v1. */
const SERIES = normalizeDocumentVersions({ versions: [
  { version_id: 'prd-3', document_id: 'prd-3', version: 3, current: true },
  { version_id: 'prd-2', document_id: 'prd-2', version: 2, current: false },
  { version_id: 'prd-1', document_id: 'prd-1', version: 1, current: false },
] })
/** A custom document's saved revisions, none marked current. */
const REVISIONS = normalizeDocumentVersions({ versions: [
  { version_id: 'r4', version: 4 }, { version_id: 'r7', version: 7 }, { version_id: 'r5', version: 5 },
] })

describe('versionChoices', () => {
  it('finds the page\'s own row by its id, else the current one', () => {
    expect(ownVersion(SERIES, prd)?.version).toBe(2)
    expect(ownVersion(SERIES, custom)?.version).toBe(3)
  })

  it('reads the latest number from the current row, else the highest, and none from an empty list', () => {
    expect([latestNumber(SERIES), latestNumber(REVISIONS), latestNumber([])]).toStrictEqual([3, 7, null])
  })

  it('says what choosing a row means: the page\'s own, the series\' latest document, or an older version', () => {
    expect(SERIES.map((version) => choiceOf(version, SERIES, prd))).toStrictEqual([
      { kind: 'latest', documentId: 'prd-3' }, { kind: 'own' }, { kind: 'older', number: 1 },
    ])
  })
})
