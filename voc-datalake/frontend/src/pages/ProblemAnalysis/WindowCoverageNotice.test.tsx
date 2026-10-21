/**
 * @fileoverview Tests for WindowCoverageNotice (U5b).
 *
 * Asserts the real English strings rather than key names — the test setup loads
 * the actual `problemAnalysis` catalogue, so a key that goes missing or stops
 * resolving fails here instead of rendering a raw key into the UI.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { WindowCoverageNotice } from './WindowCoverageNotice'

const complete = {
  isPartial: false,
  hasFailed: false,
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

  it('says the counts undercount when the walk stopped short', () => {
    render(<WindowCoverageNotice {...complete} isPartial loadedCount={2000} totalCount={5000} />)

    // Thousands separators come from the locale, via `{{loaded, number}}`.
    expect(
      screen.getByText('Counts cover 2,000 of 5,000 items in this window.')
    ).toBeInTheDocument()
  })

  it('announces the terminal partial state to assistive technology', () => {
    render(<WindowCoverageNotice {...complete} isPartial loadedCount={100} totalCount={900} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  describe('when nothing could be read', () => {
    it('reports the failure instead of implying the window is empty', () => {
      render(<WindowCoverageNotice {...complete} hasFailed loadedCount={0} totalCount={0} />)

      expect(screen.getByRole('alert')).toHaveTextContent('Could not load feedback for this window')
    })

    it('offers the retry it tells the user to perform', async () => {
      // The message says "Retry, or narrow the time range" — the time range
      // lives in the app header, but retry has to come from here or the
      // instruction points at nothing.
      const onRetry = vi.fn()
      const user = userEvent.setup()
      render(<WindowCoverageNotice {...complete} hasFailed loadedCount={0} totalCount={0} onRetry={onRetry} />)

      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(onRetry).toHaveBeenCalledOnce()
    })

    it('omits the retry control when no handler is supplied', () => {
      render(<WindowCoverageNotice {...complete} hasFailed loadedCount={0} totalCount={0} />)

      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('prefers the failure message over any coverage message', () => {
      // Failure outranks the rest: a partial count nobody can trust is worse
      // than saying the window is unknown.
      render(
        <WindowCoverageNotice {...complete} hasFailed isPartial loadedCount={0} totalCount={0} />
      )

      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.queryByText(/Counts cover/)).not.toBeInTheDocument()
    })

    it('keeps the partial caveat when a failure still left some rows loaded', () => {
      // Some rows did arrive, so the counts are usable-but-short rather than
      // unknown — that is the partial case, not the failure case.
      render(<WindowCoverageNotice {...complete} hasFailed isPartial loadedCount={100} totalCount={900} />)

      expect(screen.getByText('Counts cover 100 of 900 items in this window.')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
