/**
 * @fileoverview Tests for WindowCoverageNotice.
 *
 * Asserts the real English strings rather than key names — the test setup loads
 * the actual `problemAnalysis` catalogue, so a key that goes missing or stops
 * resolving fails here instead of rendering a raw key into the UI.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { WindowCoverageNotice } from './WindowCoverageNotice'

const complete = { isPartial: false, hasFailed: false }

describe('WindowCoverageNotice', () => {
  it('renders nothing when the server read the window in full', () => {
    const { container } = render(<WindowCoverageNotice {...complete} />)
    // A complete count needs no caveat, and an always-present line would train
    // people to ignore it.
    expect(container).toBeEmptyDOMElement()
  })

  it('names the oldest day read when the read stopped early', () => {
    render(<WindowCoverageNotice {...complete} isPartial scannedThrough="2026-03-14" />)
    expect(screen.getByRole('status')).toHaveTextContent(/^Counts cover reviews back to Mar 14, 2026 only/)
  })

  it('says the counts are partial when the read hit its row cap', () => {
    render(<WindowCoverageNotice {...complete} isPartial scannedThrough={null} />)
    expect(screen.getByRole('status')).toHaveTextContent(/^Counts cover part of this period only/)
  })

  it('says only the largest problems are listed while the counts cover all', () => {
    render(<WindowCoverageNotice {...complete} truncated={{ listed: 2000, total: 5310 }} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'The 2,000 largest of 5,310 problems are listed; every count above includes all of them.')
  })

  it('reports a failed read as unknown, with a retry control', async () => {
    const onRetry = vi.fn()
    render(<WindowCoverageNotice isPartial={false} hasFailed onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent(/^Could not load feedback for this window/)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
  })

  it('outranks the partial caveat with the failure', () => {
    render(<WindowCoverageNotice isPartial hasFailed onRetry={vi.fn()} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
