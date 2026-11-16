/**
 * The Documents tab's selection is deep-linkable as a path: `/projects/<id>/documents/<docId>` selects that document
 * on load (a reload, the Decisions card's "PR/FAQ ready" link), and selecting a document writes it there: another
 * document as a history entry, a new version of the same one in place. A PRD / PR/FAQ address naming an older
 * version's row opens on the latest with that version shown (`/v/<n>`), once per address.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { ProjectDocument } from '../../api/types'
import { useDocumentSelection } from './useDocumentSelection'
import { useProjectPlace } from './useProjectPlace'

const doc = (documentId: string, extra: Partial<ProjectDocument> = {}): ProjectDocument => ({
  document_id: documentId, document_type: 'custom', title: `Doc ${documentId}`, content: '', created_at: '2026-10-01T00:00:00Z',
  ...extra,
})
const prfaq = (version: number) => doc(`prfaq_${String(version)}`, {
  document_type: 'prfaq', title: `Refunds (v${String(version)})`, base_title: 'Refunds', version,
})
const DOCS = [doc('a'), doc('b'), prfaq(1), prfaq(2), prfaq(3)]

function renderSelection(url: string, documents: readonly ProjectDocument[] | null = DOCS) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/projects/p1/overview', url]} initialIndex={1}>{children}</MemoryRouter>
  )
  return renderHook(({ docs }) => {
    const place = useProjectPlace()
    return { ...useDocumentSelection(docs, place), location: useLocation(), navigate: useNavigate() }
  }, { wrapper, initialProps: { docs: documents ?? undefined } })
}

describe('useDocumentSelection', () => {
  it('selects the document a path names, once the documents are loaded', () => {
    const { result, rerender } = renderSelection('/projects/p1/documents/b', null)
    expect(result.current.selectedDoc).toBeNull()

    rerender({ docs: DOCS })

    expect(result.current.selectedDoc?.document_id).toBe('b')
  })

  it('writes the selection into the path; another document is a history entry Back walks', () => {
    const { result } = renderSelection('/projects/p1/documents/a')

    act(() => { result.current.setSelectedDoc(DOCS[1] ?? null) })
    expect(result.current.location.pathname).toBe('/projects/p1/documents/b')

    act(() => { void result.current.navigate(-1) })
    expect(result.current.selectedDoc?.document_id).toBe('a')
  })

  it('moves to a new version of the same document in place, keeping full screen and showing that version', () => {
    const { result } = renderSelection('/projects/p1/documents/prfaq_3/v/1/focus')
    const saved = prfaq(4)

    act(() => { result.current.setSelectedDoc(saved) })
    expect([result.current.location.pathname, result.current.selectedDoc]).toStrictEqual(['/projects/p1/documents/prfaq_4/focus', saved])

    act(() => { void result.current.navigate(-1) })
    expect(result.current.location.pathname, 'replaced: Back goes to the page before').toBe('/projects/p1/overview')
  })

  it('drops a link to a document the project no longer has', () => {
    const { result } = renderSelection('/projects/p1/documents/gone')

    expect(result.current.selectedDoc).toBeNull()
    expect(result.current.location.pathname).toBe('/projects/p1/documents')
  })

  it('opens a link to an older version\'s row on the latest, with that version shown, in place', () => {
    const { result } = renderSelection('/projects/p1/documents/prfaq_1/focus')

    expect(result.current.location.pathname).toBe('/projects/p1/documents/prfaq_3/v/1/focus')
    expect(result.current.selectedDoc?.document_id).toBe('prfaq_3')
  })

  it('never moves a page whose newer version arrived later: an address is checked once', () => {
    const { result, rerender } = renderSelection('/projects/p1/documents/prfaq_3')
    // A teammate saved v4 while this page edits v3: the refetched list must not move the canvas.
    rerender({ docs: [...DOCS, prfaq(4)] })

    expect(result.current.location.pathname).toBe('/projects/p1/documents/prfaq_3')
  })

  it('drops an older version asked of a document whose page shows none (a decision)', () => {
    const { result } = renderSelection('/projects/p1/documents/dec_1/v/2', [...DOCS, doc('dec_1', { document_type: 'decision' })])

    expect(result.current.location.pathname).toBe('/projects/p1/documents/dec_1')
  })
})
