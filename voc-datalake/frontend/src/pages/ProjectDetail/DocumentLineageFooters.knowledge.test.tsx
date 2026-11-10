/**
 * @fileoverview The "Built from" line names the company knowledge a document was
 * given — company memories, web searches, company context — beside the reviews
 * it used, and says nothing about knowledge a document did not record.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DerivationFooter } from './DocumentLineageFooters'
import type { ProjectDocument } from '../../api/types'

const BASE = {
  sources: [], selected_document_count: 0, feedback_count: 12, persona_ids: [],
  visual_document_ids: [], product_context_included: false,
}

function renderFooter(derivation: ProjectDocument['derivation']) {
  const doc: ProjectDocument = {
    document_id: 'research_1', document_type: 'research', title: 'Refunds', content: 'Body',
    created_at: '2026-10-17T00:00:00Z', derivation,
  }
  render(<DerivationFooter doc={doc} documents={[doc]} onSelectDoc={vi.fn()} />)
  return screen.getByTestId('document-derivation').textContent
}

describe('DerivationFooter company knowledge', () => {
  it('lists reviews, company memories, web searches and the company context', () => {
    const text = renderFooter({ ...BASE, memory_ids: ['m1', 'm2', 'm3'], web_search_count: 2, company_context_included: true })
    expect(text).toContain('12 feedback items used · 3 company memories · 2 web searches · Company context')
  })

  it('says nothing about knowledge the document did not record', () => {
    const text = renderFooter(BASE)
    expect(text).not.toMatch(/company memor|web search|Company context/)
  })

  it('uses the singular forms', () => {
    const text = renderFooter({ ...BASE, memory_ids: ['m1'], web_search_count: 1 })
    expect(text).toContain('1 company memory · 1 web search')
  })

  it('names the company design system only when a prototype read it', () => {
    expect(renderFooter({ ...BASE, design_system_included: true })).toContain('Company design system')
  })

  it.each([false, undefined])('says nothing about the design system when recorded as %s', (recorded) => {
    expect(renderFooter({ ...BASE, design_system_included: recorded })).not.toContain('design system')
  })
})
