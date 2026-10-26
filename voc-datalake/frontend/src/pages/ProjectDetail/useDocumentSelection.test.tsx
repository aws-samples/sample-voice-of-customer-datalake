/**
 * The Documents tab's selection is deep-linkable: `?doc=<id>` selects that
 * document on load (a reload, the Decisions card's "PR/FAQ ready" link), and
 * selecting a document writes it there.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { ProjectDocument } from '../../api/types'
import { projectDocumentPath, useDocumentSelection } from './useDocumentSelection'

const doc = (documentId: string): ProjectDocument => ({
  document_id: documentId, document_type: 'prfaq', title: `Doc ${documentId}`, content: '', created_at: '2026-10-01T00:00:00Z',
})
const DOCS = [doc('a'), doc('b')]

function renderSelection(url: string, documents: readonly ProjectDocument[] | null = DOCS) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  )
  return renderHook(({ docs }) => ({ ...useDocumentSelection(docs), location: useLocation() }), {
    wrapper, initialProps: { docs: documents ?? undefined },
  })
}

describe('useDocumentSelection', () => {
  it('selects the document a link names, once the documents are loaded', () => {
    const { result, rerender } = renderSelection('/projects/p1?tab=documents&doc=b', null)
    expect(result.current.selectedDoc).toBeNull()

    rerender({ docs: DOCS })

    expect(result.current.selectedDoc?.document_id).toBe('b')
  })

  it('writes the selection into the address, keeping the tab', () => {
    const { result } = renderSelection('/projects/p1?tab=documents')

    act(() => { result.current.setSelectedDoc(DOCS[0] ?? null) })

    expect(result.current.location.search).toBe('?tab=documents&doc=a')
  })

  it('drops a link to a document the project no longer has', () => {
    const { result } = renderSelection('/projects/p1?tab=documents&doc=gone')

    expect(result.current.selectedDoc).toBeNull()
    expect(result.current.location.search).toBe('?tab=documents')
  })

  it('builds the path that opens one document', () => {
    expect(projectDocumentPath('p 1', 'prfaq_1')).toBe('/projects/p%201?tab=documents&doc=prfaq_1')
  })
})
