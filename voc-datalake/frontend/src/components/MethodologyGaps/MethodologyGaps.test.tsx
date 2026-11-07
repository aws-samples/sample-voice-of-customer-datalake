import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { optionalMethodologyBlock } from '../../api/methodologySchema'
import MethodologyGaps from './MethodologyGaps'

const block = (raw: unknown) => optionalMethodologyBlock.parse(raw)

describe('MethodologyGaps', () => {
  it('lists each warning by its code, in the reader\u2019s words', () => {
    render(<MethodologyGaps block={block({
      step: 'prd', skipped: [{ step: 'prfaq', reason: 'missing' }],
      warnings: [{ code: 'missing_upstream', step: 'prfaq', message: 'server text' }, { code: 'no_evidence', message: 'x' }],
      evidence: 0,
    })} />)
    const list = screen.getByTestId('methodology-gaps')
    expect(list).toHaveTextContent('Methodology gaps')
    expect(list).not.toHaveTextContent('server text')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows the server\u2019s sentence for a code it does not know', () => {
    render(<MethodologyGaps block={block({ step: 'prd', warnings: [{ code: 'brand_new', message: 'A new gap.' }] })} testId="gaps" />)
    expect(screen.getByTestId('gaps')).toHaveTextContent('A new gap.')
  })

  it.each([
    [{ code: 'missing_upstream', step: 'personas', message: 'x' }, 'Made without personas: the project had none.'],
    [{ code: 'missing_upstream', step: 'prd', message: 'x' }, 'Made without a PRD: the project had none.'],
    [{ code: 'missing_upstream', step: 'research', message: 'Server: no research.' }, 'Server: no research.'],
    [{ code: 'upstream_not_selected', step: 'feedback', message: 'x' }, 'Made without customer feedback: it was turned off for this document.'],
    [{ code: 'upstream_not_selected', step: 'personas', message: 'x' }, "Made without the project's personas: they were not selected."],
    [{ code: 'upstream_not_selected', step: 'prfaq', message: 'x' }, "Made without the project's PR/FAQ: it was not selected."],
    [{ code: 'upstream_not_selected', step: 'prd', message: 'Server: PRD off.' }, 'Server: PRD off.'],
    [{ code: 'reference_documents_skipped', document_ids: ['d4', 'd5'], cap: 3, message: 'x' }, '2 selected reference documents were left out (only the first 3 are read).'],
  ])('says %j as %s', (warning, text) => {
    render(<MethodologyGaps block={block({ step: 'prd', warnings: [warning] })} />)
    expect(screen.getByRole('listitem')).toHaveTextContent(text)
  })

  it('says a hand-written document cites no feedback yet', () => {
    render(<MethodologyGaps block={block({ step: 'prfaq', warnings: [{ code: 'no_evidence', message: 'x' }] })} handWritten />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Written by hand: cites no customer feedback yet.')
  })

  it.each([
    ['no block', undefined],
    ['a block without warnings', block({ step: 'research', skipped: [], warnings: [], evidence: null })],
  ])('renders nothing for %s', (_label, value) => {
    const { container } = render(<MethodologyGaps block={value} />)
    expect(container).toBeEmptyDOMElement()
  })
})
