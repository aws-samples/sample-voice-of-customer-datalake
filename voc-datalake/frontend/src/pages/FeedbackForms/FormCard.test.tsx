/**
 * Regression test for issue #171: FormCard crashed the whole /feedback-forms
 * route with "Cannot read properties of undefined (reading 'primary_color')"
 * when a form record arrived without a theme. The list normalizes at its
 * query boundary, but FormCard must stay render-safe standalone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'

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

  // U12: these icon-only controls carried hardcoded English titles, so they read
  // the same in every locale. They now take translated aria-labels — the
  // accessible name is what assistive tech actually announces.
  it('gives every icon-only card action an accessible name', () => {
    renderCard({ ...buildForm(), enabled: true })

    // Resolve through the same i18n instance the component uses, so these stay
    // correct whether the harness echoes keys or returns real strings.
    const { t } = i18n
    expect(screen.getByRole('button', { name: t('feedbackForms:card.disableForm') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('feedbackForms:card.editForm') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('feedbackForms:card.deleteForm') })).toBeInTheDocument()
  })

  // Resolving through i18n.t alone cannot catch a WRONG key path: the harness
  // echoes the key, so component and expectation agree even when the key does
  // not exist. This asserts against the real en catalogue instead, which is what
  // caught these labels rendering as raw keys in the deployed build.
  it('uses key paths that actually exist in the en catalogue', async () => {
    const en = (await import('../../../public/locales/en/feedbackForms.json')).default
    const card = en.card as Record<string, string>

    for (const key of ['editForm', 'deleteForm', 'enableForm', 'disableForm']) {
      expect(card[key], `feedbackForms:card.${key} missing from en catalogue`).toBeTruthy()
    }
  })

  it('names the toggle for the action it performs when the form is disabled', () => {
    renderCard({ ...buildForm(), enabled: false })

    const { t } = i18n
    expect(screen.getByRole('button', { name: t('feedbackForms:card.enableForm') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('feedbackForms:card.disableForm') })).not.toBeInTheDocument()
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
