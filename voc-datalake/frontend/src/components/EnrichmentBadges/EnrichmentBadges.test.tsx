import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EnrichmentBadges } from '.'

describe('EnrichmentBadges', () => {
  it('renders the localized field and value', () => {
    render(<EnrichmentBadges enrichment={{ usefulness: 'high' }} />)
    expect(screen.getByText('Usefulness: High')).toBeInTheDocument()
  })

  it('tones the badge by the value\'s position in the declared order', () => {
    const { rerender } = render(<EnrichmentBadges enrichment={{ usefulness: 'high' }} />)
    expect(screen.getByText('Usefulness: High')).toHaveClass('bg-green-100')

    rerender(<EnrichmentBadges enrichment={{ usefulness: 'low' }} />)
    expect(screen.getByText('Usefulness: Low')).toHaveClass('bg-gray-100')
  })

  it('renders nothing for an unscored item', () => {
    for (const enrichment of [undefined, {}]) {
      const { container, unmount } = render(<EnrichmentBadges enrichment={enrichment} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('ignores fields outside the registry', () => {
    const { container } = render(<EnrichmentBadges enrichment={{ invented_field: 'high' }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
