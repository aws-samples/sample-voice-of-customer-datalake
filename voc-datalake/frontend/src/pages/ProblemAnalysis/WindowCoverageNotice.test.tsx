/**
 * @fileoverview Tests for WindowCoverageNotice (U5b).
 *
 * Asserts the real English strings rather than key names — the test setup loads
 * the actual `problemAnalysis` catalogue, so a key that goes missing or stops
 * resolving fails here instead of rendering a raw key into the UI.
 */
import { render, screen } from '@testing-library/react'

import { WindowCoverageNotice } from './WindowCoverageNotice'

const complete = {
  isLoadingMore: false,
  isPartial: false,
  loadedCount: 40,
  totalCount: 40,
}

describe('WindowCoverageNotice', () => {
  it('renders nothing when the window was read in full', () => {
    const { container } = render(<WindowCoverageNotice {...complete} />)
    // A complete count needs no caveat, and an always-present line would train
    // people to ignore it.
    expect(container).toBeEmptyDOMElement()
  })

  it('reports progress while further pages are loading', () => {
    render(<WindowCoverageNotice {...complete} isLoadingMore loadedCount={200} totalCount={615} />)

    expect(screen.getByText('Loading feedback… 200 of 615 so far.')).toBeInTheDocument()
  })

  it('says the counts undercount when the walk stopped short', () => {
    render(<WindowCoverageNotice {...complete} isPartial loadedCount={2000} totalCount={5000} />)

    expect(
      screen.getByText('Counts cover 2000 of 5000 items in this window.')
    ).toBeInTheDocument()
  })

  it('shows progress rather than the partial caveat while still loading', () => {
    // Both can be true at once; "still arriving" is the more useful reading,
    // because the partial verdict is not final until the walk stops.
    render(<WindowCoverageNotice {...complete} isLoadingMore isPartial loadedCount={100} totalCount={900} />)

    expect(screen.getByText('Loading feedback… 100 of 900 so far.')).toBeInTheDocument()
    expect(screen.queryByText(/Counts cover/)).not.toBeInTheDocument()
  })

  it('announces itself to assistive technology as a status', () => {
    render(<WindowCoverageNotice {...complete} isPartial loadedCount={100} totalCount={900} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
