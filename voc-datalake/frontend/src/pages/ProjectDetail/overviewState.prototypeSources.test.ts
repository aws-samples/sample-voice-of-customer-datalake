/**
 * `prototypeSources` — the candidate lists the picker offers, and the ORDER of them.
 *
 * The order is a contract with the backend, not a presentation choice. The picker
 * offers `[0]` as its default and the build request then names it explicitly, so if
 * this sort and `_newest_document_id`'s ranking disagreed, the dialog would state
 * one document and the build would read another — the exact defect the feature was
 * built to remove.
 *
 * Added after review round 1 on PR #320: the backend has
 * `test_a_tie_on_created_at_resolves_on_id_descending`, the frontend only covered
 * the distinct-date case, and `ordinalByType`'s tie test is a different code path.
 * So the "ties included" claim in the PR body was untested on this side.
 */
import { describe, it, expect } from 'vitest'
import { deriveOverviewState } from './overviewState'
import type { ProjectDocument } from '../../api/types'

function doc(
  documentType: ProjectDocument['document_type'],
  id: string,
  createdAt: string,
): ProjectDocument {
  return { document_id: id, document_type: documentType, title: id, content: 'x', created_at: createdAt }
}

function sources(documents: ProjectDocument[]) {
  return deriveOverviewState({ personas: [], documents, productContext: undefined }).prototypeSources
}

describe('prototypeSources ordering mirrors the backend newest-of-type rule', () => {
  it('puts the newest of each type first, by date and not by id', () => {
    // Ids reverse-alphabetical to creation order, so an id-ranked sort inverts this.
    const { prdOptions, prfaqOptions } = sources([
      doc('prd', 'zz_prd_old', '2026-01-01T00:00:00Z'),
      doc('prd', 'aa_prd_new', '2026-06-01T00:00:00Z'),
      doc('prfaq', 'prfaq_only', '2026-02-01T00:00:00Z'),
    ])

    expect(prdOptions.map((o) => o.document_id)).toEqual(['aa_prd_new', 'zz_prd_old'])
    expect(prfaqOptions.map((o) => o.document_id)).toEqual(['prfaq_only'])
  })

  it('breaks a same-second tie on document_id DESCENDING, as the backend does', () => {
    // Not hypothetical: ids carry a whole-second timestamp, and the project this
    // was built against has four prototypes sharing one date. Whichever document
    // the backend would call "newest" must be the one this offers as default.
    const sameSecond = '2026-06-01T00:00:00Z'
    const { prdOptions } = sources([
      doc('prd', 'prd_a', sameSecond),
      doc('prd', 'prd_c', sameSecond),
      doc('prd', 'prd_b', sameSecond),
    ])

    expect(prdOptions.map((o) => o.document_id)).toEqual(['prd_c', 'prd_b', 'prd_a'])
  })

  it('keeps hasPrd/hasPrfaq consistent with the lists they summarise', () => {
    const empty = sources([])
    expect(empty.hasPrd).toBe(false)
    expect(empty.prdOptions).toHaveLength(0)

    const one = sources([doc('prd', 'prd_1', '2026-01-01T00:00:00Z')])
    expect(one.hasPrd).toBe(true)
    expect(one.hasPrfaq).toBe(false)
    expect(one.prfaqOptions).toHaveLength(0)
  })

  it('carries the title and date the picker renders', () => {
    const { prdOptions } = sources([doc('prd', 'prd_1', '2026-03-04T00:00:00Z')])

    expect(prdOptions[0]).toEqual({
      document_id: 'prd_1',
      title: 'prd_1',
      created_at: '2026-03-04T00:00:00Z',
    })
  })

  it('ignores document types that are not prototype sources', () => {
    const { prdOptions, prfaqOptions } = sources([
      doc('research', 'research_1', '2026-01-01T00:00:00Z'),
      doc('prototype', 'proto_1', '2026-01-02T00:00:00Z'),
    ])

    expect(prdOptions).toHaveLength(0)
    expect(prfaqOptions).toHaveLength(0)
  })
})
