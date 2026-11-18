import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { FormV2, LoadedForm } from '../model/formsV2'

const api = vi.hoisted(() => ({
  getForm: vi.fn<(formId: string) => Promise<LoadedForm>>(),
  getResults: vi.fn<() => Promise<unknown>>(),
  getResponses: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...real, feedbackFormsV2Api: { ...real.feedbackFormsV2Api, ...api } }
})
vi.mock('../../../store/configStore', async () => (await import('../feedback-forms-fixtures')).configStoreModule())
vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))
vi.mock('../preview/PreviewFrame', async () => import('../test/previewFrameStub'))

import FeedbackForms from '../FeedbackForms'
import { STORED_META, sampleForm } from '../test/draftHarness'
import { handoffState } from './newFormHandoff'
import { parseFormResults, parseResponsesPage } from '../../../api/feedbackFormsV2Results'

function renderAt(path: string, state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: path, state }]}>
        <Routes><Route path="/feedback-forms/*" element={<FeedbackForms />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const stored = (form: FormV2, overrides: Partial<LoadedForm['meta']> = {}): LoadedForm => ({ form, meta: { ...STORED_META, ...overrides } })

describe('the builder page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getResults.mockResolvedValue(parseFormResults({ total: 0, test_count: 0 }))
    api.getResponses.mockResolvedValue(parseResponsesPage({ responses: [] }))
  })

  it('opens an unsaved new form on Questions, "Not saved yet", with its tabs', async () => {
    renderAt('/feedback-forms/new/questions', handoffState({ form: sampleForm({ name: 'From a template' }), templateId: 'blank', ai: null }))
    expect(await screen.findByRole('heading', { name: 'From a template' })).toBeInTheDocument()
    expect(screen.getByText('Not saved yet')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist', { name: 'Form builder sections' })).getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'Questions', 'Flow', 'Languages', 'Hidden fields', 'Test', 'Share', 'Results', 'Settings',
    ])
  })

  it('sends a new-form address that carries no form to the picker', async () => {
    renderAt('/feedback-forms/new/questions')
    expect(await screen.findByRole('heading', { name: 'New form' })).toBeInTheDocument()
  })

  it('opens a Live form with responses on Results, and an Off one on Questions', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm({ enabled: true }), { response_count: 12, has_responses: true }))
    renderAt('/feedback-forms/f_test')
    await waitFor(() => { expect(screen.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true') })
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('keeps the draft while switching tabs', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm()))
    const user = userEvent.setup()
    renderAt('/feedback-forms/f_test/settings')
    const name = await screen.findByLabelText('Internal name')
    await user.clear(name)
    await user.type(name, 'Pilot form')
    await user.click(screen.getByRole('tab', { name: /Flow/ }))
    await user.click(screen.getByRole('tab', { name: /Settings/ }))
    expect(screen.getByLabelText('Internal name')).toHaveValue('Pilot form')
  })
})
