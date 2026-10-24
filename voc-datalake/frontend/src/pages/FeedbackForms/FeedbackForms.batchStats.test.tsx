/**
 * The Feedback Forms page reads every card's stats with the list (E2E F11).
 *
 * Each FormCard used to fetch `/feedback-forms/{id}/stats` on its own, so N
 * cards meant N requests — each one a scan of the brand partition server-side.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { feedbackFormsApiMocks, clientApiModule, configStoreModule, createFormsWrapper } from './feedback-forms-fixtures'

vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../store/configStore', () => configStoreModule())

import FeedbackForms from './FeedbackForms'

const { getFeedbackForms, getFeedbackFormStats, getCategoriesConfig } = feedbackFormsApiMocks
const FORMS = [
  { form_id: 'form_1', name: 'Website Feedback', enabled: true, title: 'Website' },
  { form_id: 'form_2', name: 'Checkout Survey', enabled: true, title: 'Checkout' },
]

/** The Submissions figure on the card that shows `name`. */
async function submissionsOn(name: string): Promise<string | null> {
  const card = (await screen.findByText(name)).closest('.card')
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${name}`)
  return within(card).getByText('Submissions').previousElementSibling?.textContent ?? null
}

describe('FeedbackForms: card stats come with the list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCategoriesConfig.mockResolvedValue({ categories: [] })
    getFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'x', stats: { total_submissions: 99, avg_rating: null, rating_count: 0 } })
  })

  it('renders every card from the list stats with no per-card request', async () => {
    getFeedbackForms.mockResolvedValue({
      forms: FORMS,
      stats: {
        form_1: { total_submissions: 12, avg_rating: 4.5, rating_count: 10 },
        form_2: { total_submissions: 3, avg_rating: null, rating_count: 0 },
      },
    })

    render(<FeedbackForms />, { wrapper: createFormsWrapper() })

    expect(await submissionsOn('Website Feedback')).toBe('12')
    expect(await submissionsOn('Checkout Survey')).toBe('3')
    expect(getFeedbackForms).toHaveBeenCalledTimes(1)
    expect(getFeedbackFormStats).not.toHaveBeenCalled()
  })

  it('falls back to one request per card when the list carries no stats', async () => {
    getFeedbackForms.mockResolvedValue({ forms: FORMS, stats_error: 'Failed to fetch form stats' })

    render(<FeedbackForms />, { wrapper: createFormsWrapper() })

    await screen.findByText('Website Feedback')
    await vi.waitFor(() => expect(getFeedbackFormStats).toHaveBeenCalledTimes(2))
  })
})
