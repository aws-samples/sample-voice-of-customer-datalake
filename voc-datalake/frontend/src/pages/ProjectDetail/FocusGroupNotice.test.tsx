/**
 * The note under a saved focus group (7.64.00, FocusGroupNotice.tsx): a focus group, or any synthetic document, says
 * its statements are the personas', never evidence; any other document shows nothing.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FocusGroupNotice } from './FocusGroupNotice'
import type { ProjectDocument } from '../../api/types'

const doc = (extra: Partial<ProjectDocument>): ProjectDocument => ({
  document_id: 'doc-1', document_type: 'prd', title: 'Doc', content: '', created_at: '2026-11-21T09:00:00Z', ...extra,
})

describe('FocusGroupNotice', () => {
  it.each([
    ['a focus group', doc({ document_type: 'focus_group' })],
    ['a synthetic document', doc({ synthetic: true })],
  ])('notes %s as synthetic', (_label, document) => {
    render(<FocusGroupNotice doc={document} />)
    expect(screen.getByRole('note')).toHaveAttribute('data-testid', 'document-synthetic')
  })

  it('shows nothing under any other document', () => {
    const { container } = render(<FocusGroupNotice doc={doc({})} />)
    expect(container).toBeEmptyDOMElement()
  })
})
