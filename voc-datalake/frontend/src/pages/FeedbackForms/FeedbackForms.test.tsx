import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { at } from '@test/defined'
import { withMemoryLocalStorage } from '../../test/memoryLocalStorage'
import {
  feedbackFormsApiMocks, clientApiModule, configStoreModule,
  CONFIGURED_API_ENDPOINT, formsConfigState,
} from './feedback-forms-fixtures'

// Mock API
const {
  getFeedbackForms: mockGetFeedbackForms,
  updateFeedbackForm: mockUpdateFeedbackForm,
  deleteFeedbackForm: mockDeleteFeedbackForm,
  getCategories: mockGetCategories,
} = feedbackFormsApiMocks

vi.mock('../../api/client', () => clientApiModule())

vi.mock('../../store/configStore', () => configStoreModule())

// The picker the New form button opens (its own spec covers it).
vi.mock('./picker/TemplatePicker', () => ({
  default: () => <div data-testid="template-picker" />,
}))

vi.mock('./FormCard', () => ({
  default: ({ form, onDelete, onToggle }: {
    form: { form_id: string; name: string; enabled: boolean; theme?: { primary_color: string } }
    onDelete: (id: string) => void
    onToggle: (id: string, enabled: boolean) => void
  }) => (
    <div data-testid={`form-card-${form.form_id}`}>
      <span>{form.name}</span>
      {/* Surfaces whether the page delivered a normalized form (issue #171). */}
      <span data-testid={`form-card-${form.form_id}-theme`}>
        {form.theme ? form.theme.primary_color : 'missing-theme'}
      </span>
      <button onClick={() => onDelete(form.form_id)}>Delete</button>
      <button onClick={() => onToggle(form.form_id, !form.enabled)}>Toggle</button>
    </div>
  ),
}))

import FeedbackForms from './FeedbackForms'
import { V1_FORM_DEFAULTS as defaultFormConfig } from './formSchema'

/** The page at one of its paths (/feedback-forms/* reads the rest itself, as routes.tsx mounts it). */
function renderPage(path = '/feedback-forms') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/feedback-forms/*" element={<FeedbackForms />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Resolve the list query with `response` and assert the empty state is shown. */
async function expectEmptyStateFor(response: unknown) {
  mockGetFeedbackForms.mockResolvedValue(response)

  renderPage()

  await waitFor(() => {
    expect(screen.getByText('No feedback forms yet')).toBeInTheDocument()
  })
}

/** Render the page, open the first card's delete and confirm it. */
async function confirmDeleteOfFirstForm() {
  const user = userEvent.setup()
  renderPage()
  await user.click(at(await screen.findAllByRole('button', { name: 'Delete' }), 0))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
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
    mockUpdateFeedbackForm.mockResolvedValue({ success: true })
    mockDeleteFeedbackForm.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders page header', () => {
      renderPage()

      expect(screen.getByText('Feedback Forms')).toBeInTheDocument()
    })

    it('renders the New form button', () => {
      renderPage()

      expect(screen.getByRole('button', { name: 'New form' })).toBeInTheDocument()
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
    it('shows three card skeletons while fetching, never a lone spinner', () => {
      mockGetFeedbackForms.mockReturnValue(new Promise(() => {}))

      renderPage()

      expect(screen.getByRole('status', { name: 'Loading...' })).toBeInTheDocument()
      expect(screen.getAllByTestId('form-card-skeleton')).toHaveLength(3)
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
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

  describe('the template picker', () => {
    it('opens the picker page when New form is pressed', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(screen.getByRole('button', { name: 'New form' }))

      expect(await screen.findByTestId('template-picker')).toBeInTheDocument()
    })

    it('is its own address: /feedback-forms/new', async () => {
      renderPage('/feedback-forms/new')

      expect(await screen.findByTestId('template-picker')).toBeInTheDocument()
    })
  })

  describe('delete confirmation', () => {
    it('names the form it is about to delete', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(at(await screen.findAllByRole('button', { name: 'Delete' }), 0))

      expect(await screen.findByRole('dialog')).toHaveTextContent('Delete the form “Customer Satisfaction”?')
    })

    // Live finding: a deleted card stayed listed until a reload.
    it('removes the card as soon as the delete is confirmed, before the server answers', async () => {
      mockDeleteFeedbackForm.mockReturnValue(new Promise(() => {}))
      await confirmDeleteOfFirstForm()

      await waitFor(() => expect(screen.queryByTestId('form-card-form-1')).not.toBeInTheDocument())
      expect(screen.getByTestId('form-card-form-2')).toBeInTheDocument()
    })

    it('puts the card back when the delete fails', async () => {
      mockDeleteFeedbackForm.mockRejectedValue(new Error('boom'))
      await confirmDeleteOfFirstForm()

      expect(await screen.findByTestId('form-card-form-1')).toBeInTheDocument()
    })
  })

  describe('the empty state is the start', () => {
    it('offers Describe and three templates, each opening the picker on it, and says how forms work', async () => {
      mockGetFeedbackForms.mockResolvedValue({ forms: [] })
      renderPage()

      const starts = await screen.findByRole('list', { name: 'Ways to start' })
      const links = within(starts).getAllByRole('link')
      expect(links.map((link) => link.getAttribute('href'))).toStrictEqual([
        '/feedback-forms/new', '/feedback-forms/new?template=nps', '/feedback-forms/new?template=churn', '/feedback-forms/new?template=old_ui',
      ])
      expect(links[0]).toHaveTextContent('Describe your form')
      expect(screen.getByText('How feedback forms work')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Hide this explanation' })).not.toBeInTheDocument()
    })
  })

  describe('the info banner', () => {
    const saved = withMemoryLocalStorage()

    it('is dismissed per person, and stays dismissed on the next visit', async () => {
      const user = userEvent.setup()
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Hide this explanation' }))
      expect(screen.queryByText('How feedback forms work')).not.toBeInTheDocument()
      expect(JSON.parse(saved.get('voc-feedback-forms-intro-dismissed') ?? '[]')).toHaveLength(1)
      cleanup()
      renderPage()
      await screen.findByTestId('form-card-form-1')
      expect(screen.queryByText('How feedback forms work')).not.toBeInTheDocument()
    })
  })

  describe('past six forms, a toolbar', () => {
    const many = ['Onboarding', 'Beta', 'Churn', 'Delta', 'Echo', 'Foxtrot', 'Alpha'].map((name, index) => ({
      form_id: `f_${String(index)}`, name, enabled: index % 2 === 0, created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-01T10:00:00Z',
    }))
    /** The names of the cards shown, in order (the stand-in card's first span). */
    const shownNames = () => screen.getAllByTestId(/^form-card-f_\d+$/).map((card) => card.querySelector('span')?.textContent ?? '')

    it('is not there with six forms or fewer', async () => {
      renderPage()
      await screen.findByTestId('form-card-form-1')
      expect(screen.queryByRole('search')).not.toBeInTheDocument()
    })

    it('searches by name, filters by state and sorts by name', async () => {
      const user = userEvent.setup()
      mockGetFeedbackForms.mockResolvedValue({ forms: many })
      renderPage()
      const toolbar = await screen.findByRole('search', { name: 'Find a form' })
      expect(screen.getByText('7 of 7 forms')).toHaveAttribute('role', 'status')

      await user.type(within(toolbar).getByRole('searchbox', { name: 'Search forms' }), 'ta')
      expect(screen.getAllByTestId(/^form-card-f_\d+$/).map((card) => card.dataset['testid'])).toStrictEqual(['form-card-f_1', 'form-card-f_3'])
      await user.clear(within(toolbar).getByRole('searchbox', { name: 'Search forms' }))

      await user.click(within(toolbar).getByRole('button', { name: 'Off' }))
      expect(screen.getAllByTestId(/^form-card-f_\d+$/)).toHaveLength(3)
      await user.click(within(toolbar).getByRole('button', { name: 'All' }))

      await user.selectOptions(within(toolbar).getByRole('combobox', { name: 'Sort' }), 'name')
      expect(shownNames()).toStrictEqual(['Alpha', 'Beta', 'Churn', 'Delta', 'Echo', 'Foxtrot', 'Onboarding'])
    })

    it('says when nothing matches, with the way back to every form', async () => {
      const user = userEvent.setup()
      mockGetFeedbackForms.mockResolvedValue({ forms: many })
      renderPage()
      await user.type(await screen.findByRole('searchbox', { name: 'Search forms' }), 'zzz')
      expect(screen.getByText('No form matches this search or filter.')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Show all forms' }))
      expect(screen.getAllByTestId(/^form-card-f_\d+$/)).toHaveLength(7)
    })
  })

  describe('system forms', () => {
    it('keeps a prototype pin form out of the list, under a collapsed "System forms" group', async () => {
      mockGetFeedbackForms.mockResolvedValue({
        forms: [...mockForms, { form_id: 'pf_1', name: 'Pins: Prototype', enabled: true, form_type: 'prototype_pin' }],
      })
      renderPage()

      const group = (await screen.findByText('System forms (1)')).closest('details')
      expect(group).not.toBeNull()
      expect(group).not.toHaveAttribute('open')
      expect(group).toContainElement(screen.getByTestId('form-card-pf_1'))
      expect(group).not.toContainElement(screen.getByTestId('form-card-form-1'))
    })

    it('shows the empty state when only system forms exist', async () => {
      mockGetFeedbackForms.mockResolvedValue({ forms: [{ form_id: 'pf_1', name: 'Pins', enabled: true, form_type: 'prototype_pin' }] })
      renderPage()

      expect(await screen.findByText('No feedback forms yet')).toBeInTheDocument()
      expect(screen.getByText('System forms (1)')).toBeInTheDocument()
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

    expect(screen.getByText('Configure the API endpoint in Administration → General to manage feedback forms.')).toBeInTheDocument()
    expect(mockGetFeedbackForms).not.toHaveBeenCalled()
  })
})
