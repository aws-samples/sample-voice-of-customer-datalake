/**
 * @fileoverview Tests for the Chat page's filter panel — specifically the live
 * count line and the non-blocking over-cap warning, which are the only parts
 * this component adds on top of the shared FeedbackFilterPanel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import { MAX_CHAT_FEEDBACK_ITEMS } from '../../api/streamLimits'
import ChatFilterPanel from './ChatFilterPanel'

const mockGetFeedback = vi.fn()
const mockGetEntities = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    getEntities: (params: unknown) => mockGetEntities(params),
  },
}))

// The custom-field controls and web-search availability are unrelated to the
// count/warning behaviour under test; stub them to their "nothing extra" state.
vi.mock('../Categories/useCustomFilterControls', () => ({
  useCustomFilterControls: () => [],
}))
vi.mock('../../runtimeConfig', () => ({
  isWebSearchAvailable: () => false,
}))

const EMPTY_CONV_FILTERS = { feedback: EMPTY_FEEDBACK_FILTERS }

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatFilterPanel
        filters={EMPTY_CONV_FILTERS}
        onChange={vi.fn()}
        days={7}
        apiEndpoint="https://api.example.com"
      />
    </QueryClientProvider>,
  )
}

function feedbackResponse(total: number, isPartial = false) {
  return { count: Math.min(total, 1), total, offset: 0, limit: MAX_CHAT_FEEDBACK_ITEMS + 1, is_partial_window: isPartial, items: [] }
}

describe('ChatFilterPanel count and warning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEntities.mockResolvedValue({ entities: { sources: { webscraper: 10 }, categories: { delivery: 5 } } })
  })

  it('shows the matched review count when the scope is within the cap', async () => {
    mockGetFeedback.mockResolvedValue(feedbackResponse(42))
    renderPanel()

    expect(await screen.findByText('42 reviews')).toBeInTheDocument()
    // No over-cap warning when the set fits.
    expect(screen.queryByText(/some feedback will be dropped/i)).not.toBeInTheDocument()
  })

  it('warns, without disabling anything, when the scope exceeds the cap', async () => {
    mockGetFeedback.mockResolvedValue(feedbackResponse(MAX_CHAT_FEEDBACK_ITEMS + 500))
    renderPanel()

    // The warning names the real cap and says the rest is dropped.
    const warning = await screen.findByText(/some feedback will be dropped/i)
    expect(warning).toBeInTheDocument()
    expect(warning).toHaveTextContent(String(MAX_CHAT_FEEDBACK_ITEMS))
    // Non-blocking: there is no disabled control anywhere in the panel.
    expect(screen.queryByRole('button', { name: /disabled/i })).not.toBeInTheDocument()
  })

  it('shows a "N+" lower bound when the candidate window was truncated', async () => {
    mockGetFeedback.mockResolvedValue(feedbackResponse(MAX_CHAT_FEEDBACK_ITEMS + 1, true))
    renderPanel()

    expect(await screen.findByText(`${MAX_CHAT_FEEDBACK_ITEMS + 1}+ reviews`)).toBeInTheDocument()
    // Over the cap, so the warning shows too.
    expect(screen.getByText(/some feedback will be dropped/i)).toBeInTheDocument()
  })

  it('treats a count exactly at the cap as within bounds (no warning)', async () => {
    mockGetFeedback.mockResolvedValue(feedbackResponse(MAX_CHAT_FEEDBACK_ITEMS))
    renderPanel()

    await screen.findByText(`${MAX_CHAT_FEEDBACK_ITEMS} reviews`)
    expect(screen.queryByText(/some feedback will be dropped/i)).not.toBeInTheDocument()
  })

  it('asks the count query for one item past the cap so over-cap is detectable', async () => {
    mockGetFeedback.mockResolvedValue(feedbackResponse(5))
    renderPanel()

    await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
    const params = mockGetFeedback.mock.calls[0][0]
    expect(params.limit).toBe(MAX_CHAT_FEEDBACK_ITEMS + 1)
    expect(params.days).toBe(7)
  })
})
