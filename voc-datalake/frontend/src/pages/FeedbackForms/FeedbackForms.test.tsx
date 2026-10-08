import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  feedbackFormsApiMocks, clientApiModule, configStoreModule, createFormsWrapper,
  CONFIGURED_API_ENDPOINT, formsConfigState,
} from './feedback-forms-fixtures'

// Mock API
const {
  getFeedbackForms: mockGetFeedbackForms,
  createFeedbackForm: mockCreateFeedbackForm,
  updateFeedbackForm: mockUpdateFeedbackForm,
  deleteFeedbackForm: mockDeleteFeedbackForm,
  getCategories: mockGetCategories,
} = feedbackFormsApiMocks

vi.mock('../../api/client', () => clientApiModule())

vi.mock('../../store/configStore', () => configStoreModule())

// Mock subcomponents
vi.mock('./TemplateWizard', () => ({
  default: ({ onSelect, onClose }: { onSelect: (config: unknown) => void; onClose: () => void }) => (
    <div data-testid="template-wizard">
      <button onClick={() => onSelect({ name: 'Test Form', type: 'nps' })}>Select Template</button>
      <button onClick={onClose}>Close Wizard</button>
    </div>
  ),
}))

vi.mock('./FormCard', () => ({
  default: ({ form, onEdit, onDelete, onToggle }: { 
    form: { form_id: string; name: string; enabled: boolean; theme?: { primary_color: string } }
    onEdit: (f: unknown) => void
    onDelete: (id: string) => void
    onToggle: (id: string, enabled: boolean) => void
  }) => (
    <div data-testid={`form-card-${form.form_id}`}>
      <span>{form.name}</span>
      {/* Surfaces whether the page delivered a normalized form (issue #171). */}
      <span data-testid={`form-card-${form.form_id}-theme`}>
        {form.theme ? form.theme.primary_color : 'missing-theme'}
      </span>
      <button onClick={() => onEdit(form)}>Edit</button>
      <button onClick={() => onDelete(form.form_id)}>Delete</button>
      <button onClick={() => onToggle(form.form_id, !form.enabled)}>Toggle</button>
    </div>
  ),
}))

import FeedbackForms from './FeedbackForms'
import { defaultFormConfig } from './formTemplates'

function renderPage() {
  render(<FeedbackForms />, { wrapper: createFormsWrapper() })
}

/** Resolve the list query with `response` and assert the empty state is shown. */
async function expectEmptyStateFor(response: unknown) {
  mockGetFeedbackForms.mockResolvedValue(response)

  renderPage()

  await waitFor(() => {
    expect(screen.getByText('No feedback forms yet')).toBeInTheDocument()
  })
}

const mockForms = [
  {
    form_id: 'form-1',
    name: 'Customer Satisfaction',
    type: 'csat',
    enabled: true,
    category: 'general',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
  },
  {
    form_id: 'form-2',
    name: 'NPS Survey',
    type: 'nps',
    enabled: false,
    category: 'product',
    created_at: '2026-01-02T10:00:00Z',
    updated_at: '2026-01-02T10:00:00Z',
  },
]

describe('FeedbackForms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackForms.mockResolvedValue({ forms: mockForms })
    mockGetCategories.mockResolvedValue({ categories: { general: 10, product: 5 } })
    mockCreateFeedbackForm.mockResolvedValue({ success: true, form_id: 'new-form' })
    mockUpdateFeedbackForm.mockResolvedValue({ success: true })
    mockDeleteFeedbackForm.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders page header', async () => {
      renderPage()

      expect(screen.getByText('Feedback Forms')).toBeInTheDocument()
    })

    it('renders create button', async () => {
      renderPage()

      expect(screen.getByRole('button', { name: /create form/i })).toBeInTheDocument()
    })

    it('fetches forms on mount', async () => {
      renderPage()

      await waitFor(() => {
        expect(mockGetFeedbackForms).toHaveBeenCalledWith()
      })
    })
  })

  describe('empty state', () => {
    it('shows empty state when no forms', async () => {
      await expectEmptyStateFor({ forms: [] })
    })

    // Regression (e2e network.spec.ts, P3): a failed list read used to fall
    // through to "No feedback forms yet" and a create prompt — offline, the page
    // claimed the user had no forms.
    it('says the list could not be loaded, not "no forms", when the read fails, and recovers on retry', async () => {
      mockGetFeedbackForms.mockRejectedValueOnce(new Error('Failed to fetch'))
      const user = userEvent.setup()

      renderPage()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('This could not be loaded. Check your connection and try again.')
      expect(screen.queryByText('No feedback forms yet')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Try again' }))

      expect(await screen.findByText('Customer Satisfaction')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetFeedbackForms.mockReturnValue(new Promise(() => {}))

      renderPage()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('sparse wire records (issue #171)', () => {
    it('normalizes theme-less legacy forms at the query boundary before they reach cards', async () => {
      // Exactly what the wire delivered when /feedback-forms crashed:
      // identity fields only, no theme, no custom_fields.
      mockGetFeedbackForms.mockResolvedValue({
        forms: [{ form_id: 'form-legacy', name: 'Legacy Form', enabled: false }],
      })

      renderPage()

      await waitFor(() => {
        expect(screen.getByTestId('form-card-form-legacy')).toBeInTheDocument()
      })
      // The card must receive a normalized form with a usable theme.
      expect(screen.getByTestId('form-card-form-legacy-theme')).toHaveTextContent(
        defaultFormConfig.theme.primary_color,
      )
    })

    it('renders an empty list when the response has no forms array', async () => {
      await expectEmptyStateFor({})
    })
  })

  describe('template wizard', () => {
    it('opens template wizard when create clicked', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(screen.getByRole('button', { name: /create form/i }))

      expect(screen.getByTestId('template-wizard')).toBeInTheDocument()
    })
  })
})

describe('FeedbackForms - not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    formsConfigState.apiEndpoint = ''
  })
  afterEach(() => {
    formsConfigState.apiEndpoint = CONFIGURED_API_ENDPOINT
  })

  it('shows configuration message when API not configured', () => {
    renderPage()

    expect(screen.getByText('Configure the API endpoint in Settings to manage feedback forms.')).toBeInTheDocument()
    expect(mockGetFeedbackForms).not.toHaveBeenCalled()
  })
})
