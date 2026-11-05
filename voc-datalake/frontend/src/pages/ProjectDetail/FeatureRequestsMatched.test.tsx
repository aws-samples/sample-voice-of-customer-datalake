/**
 * @fileoverview The wizards' board-request count (contract C5): read from the boards' Insights totals
 * (the feedback preview does not count them), one read per picked board or one for every board,
 * summed, "at least" when a board was truncated, and nothing at all when unticked or unreadable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createWizardWrapper } from './wizard-fixtures'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
import FeatureRequestsMatched from './FeatureRequestsMatched'
import FeedbackMatchPreview from './FeedbackMatchPreview'
import type { EvidenceCountSelection } from './FeatureRequestsMatched'
import type { FeatureRequestInsights } from '../../api/featureRequestInsightsSchema'

const getFeatureRequestInsights = vi.hoisted(() => vi.fn())
vi.mock('../../api/featureRequestInsights', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/featureRequestInsights')>(), getFeatureRequestInsights,
}))
const previewFeedback = vi.hoisted(() => vi.fn())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { previewFeedback } }))

const insights = (requests: number, truncated = false): FeatureRequestInsights => ({
  board: null, window_days: 30, totals: { requests, supporters: 0, enriched: 0 }, truncated,
  top: [], by_category: [], by_status: [], by_sentiment: [],
})

const selection = (fields: Partial<EvidenceCountSelection>): EvidenceCountSelection => ({
  useFeatureRequests: true, featureRequestBoardIds: [], days: 30, ...fields,
})

function renderCount(fields: Partial<EvidenceCountSelection>) {
  return render(<FeatureRequestsMatched selection={selection(fields)} />, { wrapper: createWizardWrapper() })
}

beforeEach(() => {
  getFeatureRequestInsights.mockReset().mockResolvedValue(insights(4))
  previewFeedback.mockReset().mockResolvedValue({ matched: 3, matched_is_lower_bound: false, sample_limit: null, estimated: false })
})

describe('FeatureRequestsMatched', () => {
  it('reads every board once in the wizard window when no board is picked', async () => {
    renderCount({})
    expect(await screen.findByTestId('feature-requests-matched')).toHaveTextContent('Also 4 feature requests from the boards.')
    expect(getFeatureRequestInsights).toHaveBeenCalledExactlyOnceWith({ days: 30 })
  })

  it('reads each picked board and adds them up', async () => {
    getFeatureRequestInsights.mockImplementation(({ board }: { board?: string }) => Promise.resolve(insights(board === 'brd_a' ? 1 : 2)))
    renderCount({ featureRequestBoardIds: ['brd_a', 'brd_b'] })
    expect(await screen.findByTestId('feature-requests-matched')).toHaveTextContent('Also 3 feature requests from the boards.')
    expect(getFeatureRequestInsights).toHaveBeenCalledWith({ board: 'brd_a', days: 30 })
    expect(getFeatureRequestInsights).toHaveBeenCalledWith({ board: 'brd_b', days: 30 })
  })

  it('says "at least" when a board stopped at the read budget', async () => {
    getFeatureRequestInsights.mockResolvedValue(insights(1, true))
    renderCount({})
    expect(await screen.findByTestId('feature-requests-matched')).toHaveTextContent('At least 1 feature request from the boards.')
  })

  it.each([[0], [9999]])('reads a %i-day window as all time', async (days) => {
    renderCount({ days })
    await screen.findByTestId('feature-requests-matched')
    expect(getFeatureRequestInsights).toHaveBeenCalledWith({ days: 0 })
  })

  it('reads nothing and shows nothing when the box is not ticked', () => {
    renderCount({ useFeatureRequests: false })
    expect(getFeatureRequestInsights).not.toHaveBeenCalled()
    expect(screen.queryByTestId('feature-requests-matched')).not.toBeInTheDocument()
  })

  it('shows nothing when a read fails', async () => {
    getFeatureRequestInsights.mockRejectedValue(new Error('API Error: 500'))
    renderCount({})
    await waitFor(() => { expect(getFeatureRequestInsights).toHaveBeenCalledWith({ days: 30 }) })
    expect(screen.queryByTestId('feature-requests-matched')).not.toBeInTheDocument()
  })
})

describe('in the wizard preview', () => {
  it('shows the board count under the reviews, and keeps the board fields out of the preview body', async () => {
    render(
      <FeedbackMatchPreview projectId="proj-1" purpose="research"
        contextConfig={{ ...defaultContextConfig, useFeatureRequests: true, featureRequestBoardIds: ['brd_sales'] }} />,
      { wrapper: createWizardWrapper() },
    )
    expect(await screen.findByTestId('feature-requests-matched')).toHaveTextContent('Also 4 feature requests from the boards.')
    expect(getFeatureRequestInsights).toHaveBeenCalledWith({ board: 'brd_sales', days: defaultContextConfig.days })
    expect(previewFeedback.mock.calls[0]?.[1]).not.toHaveProperty('include_feature_requests')
  })
})
