import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetFeedbackForms = vi.fn()
const mockCreateFeedbackForm = vi.fn()
const mockUpdateFeedbackForm = vi.fn()
const mockDeleteFeedbackForm = vi.fn()
const mockGetCategories = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackForms: () => mockGetFeedbackForms(),
    createFeedbackForm: (form: unknown) => mockCreateFeedbackForm(form),
    updateFeedbackForm: (id: string, form: unknown) => mockUpdateFeedbackForm(id, form),
    deleteFeedbackForm: (id: string) => mockDeleteFeedbackForm(id),
    getCategories: () => mockGetCategories(),
  },
  stripTrailingSlashes: (url: string) => url.replace(/\/+$/, ''),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

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
    form: { form_id: string; name: string; enabled: boolean }
    onEdit: (f: unknown) => void
    onDelete: (id: string) => void
    onToggle: (id: string, enabled: boolean) => void
  }) => (
    <div data-testid={`form-card-${form.form_id}`}>
      <span>{form.name}</span>
      <button onClick={() => onEdit(form)}>Edit</button>
      <button onClick={() => onDelete(form.form_id)}>Delete</button>
      <button onClick={() => onToggle(form.form_id, !form.enabled)}>Toggle</button>
    </div>
  ),
}))

import FeedbackForms from './FeedbackForms'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
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
      render(<FeedbackForms />, { wrapper: createWrapper() })

      expect(screen.getByText('Feedback Forms')).toBeInTheDocument()
    })

    it('renders create button', async () => {
      render(<FeedbackForms />, { wrapper: createWrapper() })

      expect(screen.getByRole('button', { name: /create form/i })).toBeInTheDocument()
    })

    it('fetches forms on mount', async () => {
      render(<FeedbackForms />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetFeedbackForms).toHaveBeenCalled()
      })
    })
  })

  describe('empty state', () => {
    it('shows empty state when no forms', async () => {
      mockGetFeedbackForms.mockResolvedValue({ forms: [] })

      render(<FeedbackForms />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('No feedback forms yet')).toBeInTheDocument()
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetFeedbackForms.mockReturnValue(new Promise(() => {}))

      render(<FeedbackForms />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('template wizard', () => {
    it('opens template wizard when create clicked', async () => {
      const user = userEvent.setup()
      render(<FeedbackForms />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /create form/i }))

      expect(screen.getByTestId('template-wizard')).toBeInTheDocument()
    })
  })
})

describe('FeedbackForms - not configured', () => {
  it('shows configuration message when API not configured', () => {
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        config: { apiEndpoint: '' },
      }),
    }))
  })
})
