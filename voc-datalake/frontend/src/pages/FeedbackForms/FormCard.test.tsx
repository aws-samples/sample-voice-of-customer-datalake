/**
 * Regression test for issue #171: FormCard crashed the whole /feedback-forms
 * route with "Cannot read properties of undefined (reading 'primary_color')"
 * when a form record arrived without a theme. The list normalizes at its
 * query boundary, but FormCard must stay render-safe standalone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetFeedbackFormStats = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormStats: (formId: string) => mockGetFeedbackFormStats(formId),
  },
}))

vi.mock('./SubmissionsModal', () => ({
  default: () => <div data-testid="submissions-modal" />,
}))

import FormCard from './FormCard'
import { defaultFormConfig } from './formTemplates'
import type { FeedbackForm } from '../../api/client'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function buildForm(): FeedbackForm {
  return {
    ...defaultFormConfig,
    form_id: 'form_1',
    name: 'Website Feedback',
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

const noop = () => undefined

function renderCard(form: FeedbackForm) {
  return render(
    <FormCard form={form} onEdit={noop} onDelete={noop} onToggle={noop} apiEndpoint="https://api.example.com" />,
    { wrapper: createWrapper() },
  )
}

describe('FormCard (issue #171)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackFormStats.mockResolvedValue({
      success: true,
      form_id: 'form_1',
      stats: { total_submissions: 3, avg_rating: 4.5, rating_count: 2 },
    })
  })

  it('renders a fully populated form with its own theme color', () => {
    renderCard(buildForm())

    expect(screen.getByText('Website Feedback')).toBeInTheDocument()
    expect(screen.getByText(defaultFormConfig.theme.primary_color)).toBeInTheDocument()
  })

  it('survives a runtime record without a theme (the #171 crash)', () => {
    const form = buildForm()
    // The wire can deliver records persisted before the theme field existed;
    // static types say theme is required, runtime reality disagrees.
    Reflect.deleteProperty(form, 'theme')

    renderCard(form)

    expect(screen.getByText('Website Feedback')).toBeInTheDocument()
    // Falls back to the default theme swatch instead of crashing.
    expect(screen.getByText(defaultFormConfig.theme.primary_color)).toBeInTheDocument()
  })
})
