import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import UsefulnessBadge from './UsefulnessBadge'
import { openTooltip } from '@test/tooltip'

describe('UsefulnessBadge', () => {
  it.each([
    ['high', 'High', 'badge-ok'],
    ['medium', 'Medium', 'badge-info'],
    ['low', 'Low', 'badge-muted'],
  ])('shows the %s band with a name that says what it measures', async (band, short, tone) => {
    render(<UsefulnessBadge band={band} />)
    const badge = screen.getByTestId('usefulness-badge')
    expect(badge).toHaveClass(tone)
    expect(badge).toHaveTextContent(`Usefulness: ${short}`)
    expect(await openTooltip(badge)).toHaveTextContent(`Usefulness: ${short}`)
  })

  it.each([undefined, 'unrated', 'bogus', 3])('shows nothing for an unscored review (%j)', (band) => {
    const { container } = render(<UsefulnessBadge band={band} />)
    expect(container).toBeEmptyDOMElement()
  })
})
