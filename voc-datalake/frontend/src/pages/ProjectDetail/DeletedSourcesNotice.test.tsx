/**
 * @fileoverview A document written from a persona, document or product doc that was later deleted
 * says so; one that never lost a source shows nothing. The boundary keeps only usable entries.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeletedSourcesNotice } from './DeletedSourcesNotice'
import { normalizeProjectDocument } from '../../api/projectDetailSchema'
import type { ProjectDocument } from '../../api/types'

const DOC: ProjectDocument = {
  document_id: 'prd_1', document_type: 'prd', title: 'Refunds PRD', content: 'Body', created_at: '2026-11-03T00:00:00Z',
}

function notice(deleted: unknown): string | null {
  const doc = normalizeProjectDocument({ ...DOC, deleted_sources: deleted })
  if (doc === null) throw new Error('the fixture document must normalize')
  render(<DeletedSourcesNotice doc={doc} />)
  return screen.queryByTestId('document-deleted-sources')?.textContent ?? null
}

describe('DeletedSourcesNotice', () => {
  it('names each deleted persona and says a document and a product doc are gone', () => {
    const text = notice([
      { kind: 'persona', id: 'p1', name: 'Budget Ben', deleted_at: '2026-11-03' },
      { kind: 'persona', id: 'p2', name: 'Busy Bea', deleted_at: '2026-11-03' },
      { kind: 'document', id: 'd1', deleted_at: '2026-11-03' },
      { kind: 'product_doc', id: 'v1', deleted_at: '2026-11-03' },
    ])
    expect(text).toContain('Written from a persona that was later deleted: Budget Ben')
    expect(text).toContain('Written from a persona that was later deleted: Busy Bea')
    expect(text).toContain('Written from a document that was later deleted')
    expect(text).toContain('Written using a product document that was later deleted')
  })

  it('says it once for unnamed personas and for several documents', () => {
    const text = notice([
      { kind: 'persona', id: 'p1' }, { kind: 'persona', id: 'p2' },
      { kind: 'document', id: 'd1' }, { kind: 'document', id: 'd2' },
    ])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(text).toContain('Written from a persona that was later deleted')
  })

  it.each([undefined, null, [], 'odd', [{ kind: 'stranger', id: 'x' }, { kind: 'persona', id: '' }]])(
    'shows nothing for %j', (deleted) => {
      expect(notice(deleted)).toBeNull()
    })
})

describe('the document boundary', () => {
  it('keeps the usable entries and drops the rest', () => {
    const doc = normalizeProjectDocument({
      ...DOC, deleted_sources: [{ kind: 'persona', id: 'p1', name: 'Ben', deleted_at: 't' }, { kind: 'x', id: 'y' }, 3],
    })
    expect(doc?.deleted_sources).toStrictEqual([{ kind: 'persona', id: 'p1', name: 'Ben', deleted_at: 't' }])
  })

  it('leaves a document that never lost a source without the field', () => {
    expect(normalizeProjectDocument(DOC)?.deleted_sources).toBeUndefined()
  })
})
