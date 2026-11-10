import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { normalizePersona } from '../../api/projectDetailSchema'
import NoEvidenceNote from './NoEvidenceNote'

function personaFrom(raw: Record<string, unknown>) {
  const persona = normalizePersona({ persona_id: 'persona_1', ...raw })
  if (persona === null) throw new Error('fixture must parse')
  return persona
}

describe('NoEvidenceNote', () => {
  it('says an imported persona has no customer evidence', () => {
    render(<NoEvidenceNote persona={personaFrom({ imported_from: 'text', evidence: { source: 'import', count: 0 } })} />)
    expect(screen.getByTestId('persona-no-evidence')).toHaveTextContent('No customer evidence: imported')
  })

  it('names an imported origin on a copy without reviews', () => {
    render(<NoEvidenceNote persona={personaFrom({ evidence: { source: 'copy', count: 0, origin: 'import' } })} />)
    expect(screen.getByTestId('persona-no-evidence')).toHaveTextContent('copied from an imported persona')
  })

  it('says a copy of a persona without reviews has none', () => {
    render(<NoEvidenceNote persona={personaFrom({ evidence: { source: 'copy', count: 0, origin: 'unknown' } })} />)
    expect(screen.getByTestId('persona-no-evidence')).toHaveTextContent('copied from a persona without reviews')
  })

  it('reads a persona imported before the marker existed by its imported_from', () => {
    render(<NoEvidenceNote persona={personaFrom({ imported_from: 'image' })} />)
    expect(screen.getByTestId('persona-no-evidence')).toHaveTextContent('No customer evidence: imported')
  })

  it.each([
    ['a copy that kept its reviews', { evidence: { source: 'copy', count: 4, inherited: true, origin: 'generated' } }],
    ['a generated persona', { input_feedback_ids: ['fb1'] }],
    ['a malformed marker', { evidence: { source: 'invented', count: 'many' } }],
  ])('renders nothing for %s', (_label, raw) => {
    const { container } = render(<NoEvidenceNote persona={personaFrom(raw)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
