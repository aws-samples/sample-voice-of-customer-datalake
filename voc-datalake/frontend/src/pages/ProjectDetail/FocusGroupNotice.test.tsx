/**
 * The note under a saved focus group (7.64.00, FocusGroupNotice.tsx): a focus group, or any synthetic document, says
 * its statements are the personas', never evidence, a synthetic validation run (7.68.00) and a voice interview
 * (7.69.00) each in its own words; any other document shows nothing.
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

  it('says a voice interview\'s answers are the persona\'s and its audio was never kept (7.69.00)', () => {
    render(<FocusGroupNotice doc={doc({ document_type: 'persona_interview', synthetic: true })} />)
    expect(screen.getByRole('note')).toHaveTextContent(/voice interview with a synthetic persona.*the audio was never stored/)
  })

  it('says a synthetic validation run\'s verdicts never count towards "met" (7.68.00)', () => {
    render(<FocusGroupNotice doc={doc({ document_type: 'validation_run', synthetic: true })} />)
    expect(screen.getByRole('note')).toHaveTextContent(/synthetic validation run.*never count towards a criterion being met/)
  })

  it('shows nothing under any other document', () => {
    const { container } = render(<FocusGroupNotice doc={doc({})} />)
    expect(container).toBeEmptyDOMElement()
  })
})
