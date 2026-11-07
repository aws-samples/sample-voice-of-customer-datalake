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
    ['no block', undefined],
    ['a block without warnings', block({ step: 'research', skipped: [], warnings: [], evidence: null })],
  ])('renders nothing for %s', (_label, value) => {
    const { container } = render(<MethodologyGaps block={value} />)
    expect(container).toBeEmptyDOMElement()
  })
})
