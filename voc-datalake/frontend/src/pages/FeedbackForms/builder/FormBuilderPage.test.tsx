import { describe, expect, it, vi, beforeEach, onTestFinished } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { FormV2, LoadedForm } from '../model/formsV2'

const api = vi.hoisted(() => ({
  getForm: vi.fn<(formId: string) => Promise<LoadedForm>>(),
  getResults: vi.fn<() => Promise<unknown>>(),
  getResponses: vi.fn<() => Promise<unknown>>(),
  createForm: vi.fn<(form: FormV2) => Promise<LoadedForm>>(),
}))

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) =>
  (await import('../test/formsApiMock')).formsApiWith(importOriginal, api))
vi.mock('../../../store/configStore', async () => (await import('../feedback-forms-fixtures')).configStoreModule())
vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))
vi.mock('../preview/PreviewFrame', async () => import('../test/previewFrameStub'))

import FeedbackForms from '../FeedbackForms'
import { STORED_META, sampleForm } from '../test/draftHarness'
import { handoffState } from './newFormHandoff'
import { parseFormResults, parseResponsesPage } from '../../../api/feedbackFormsV2Results'
import { useAssistantUiStore } from '../../../assistant/store/assistantStore'

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

/** The stored sample form's builder, with `item` of its ⋯ menu picked. */
async function pickInStoredForm(item: string | RegExp) {
  api.getForm.mockResolvedValue(stored(sampleForm()))
  const user = userEvent.setup()
  renderAt('/feedback-forms/f_test/questions')
  await user.click(await screen.findByRole('button', { name: 'More form actions' }))
  await user.click(screen.getByRole('menuitem', { name: item }))
  return user
}

describe('the builder page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAssistantUiStore.getState().reset()
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

  it('offers the way back to the list above a form that could not load (F26)', async () => {
    api.getForm.mockRejectedValue(new Error('unavailable'))
    renderAt('/feedback-forms/f_test/questions')
    expect(await screen.findByText("Couldn't load this form.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Feedback Forms' })).toHaveAttribute('href', '/feedback-forms')
  })

  it('puts the phone\'s save bar after the tab\'s content, and only while a button shows (F15)', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm({ enabled: false })))
    renderAt('/feedback-forms/f_test/questions')
    const [, inBar] = await screen.findAllByRole('button', { name: 'Publish' })
    const bar = inBar?.closest('[data-action-bar]') ?? null
    const tabs = screen.getByRole('tablist', { name: 'Form builder sections' })
    expect({
      bar: bar !== null,
      inHeader: bar?.closest('header') != null,
      afterTabs: (tabs.compareDocumentPosition(bar ?? tabs) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    }).toStrictEqual({ bar: true, inHeader: false, afterTabs: true })
  })

  it('renders no save bar for a Live form without edits: nothing to save, no empty pill under the ⋯ (F15)', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm({ enabled: true })))
    renderAt('/feedback-forms/f_test/questions')
    expect(await screen.findByText('Live')).toBeInTheDocument()
    expect(document.querySelector('[data-action-bar]')).toBeNull()
  })

  it('below md, offers "Ask the assistant" in the ⋯ and opens the assistant from it', async () => {
    await pickInStoredForm('Ask the assistant')
    expect(useAssistantUiStore.getState().open).toBe(true)
  })

  it('from md, leaves the assistant to the floating launcher', async () => {
    // (the setup's matchMedia matches nothing: a phone; here only md and up match)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 768px)', media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }))
    onTestFinished(() => { vi.unstubAllGlobals() })
    api.getForm.mockResolvedValue(stored(sampleForm()))
    const user = userEvent.setup()
    renderAt('/feedback-forms/f_test/questions')
    await user.click(await screen.findByRole('button', { name: 'More form actions' }))
    expect(screen.getByRole('menuitem', { name: 'Duplicate form' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Ask the assistant' })).not.toBeInTheDocument()
  })

  it('shows that the tabs scroll when they are cut: a fade at the cut end and the scroll buttons (F15)', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm()))
    renderAt('/feedback-forms/f_test/questions')
    const tabs = await screen.findByRole('tablist', { name: 'Form builder sections' })
    expect(screen.queryByRole('button', { name: 'Scroll to more tabs' })).not.toBeInTheDocument()
    const strip = tabs.parentElement ?? tabs
    Object.defineProperties(strip, { clientWidth: { configurable: true, value: 358 }, scrollWidth: { configurable: true, value: 739 } })
    fireEvent.scroll(strip)
    expect(await screen.findByRole('button', { name: 'Scroll to more tabs' })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Scroll to earlier tabs' })).toHaveAttribute('aria-disabled', 'true')
    expect(strip).toHaveAttribute('data-cut-end', 'true')
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

  it.each([['languages', /^Languages/], ['hidden-fields', /^Hidden fields/], ['test', /^Test/]])('opens the %s tab from its address', async (tab, name) => {
    api.getForm.mockResolvedValue(stored(sampleForm()))
    renderAt(`/feedback-forms/f_test/${tab}`)
    await waitFor(() => { expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true') })
  })

  it('says once that a version 1 form now uses the new builder', async () => {
    api.getForm.mockResolvedValue(stored(sampleForm(), { migrated_from_v1: true }))
    renderAt('/feedback-forms/f_test/questions')
    expect(await screen.findByRole('note')).toHaveTextContent(/^This form now uses the new builder/)
  })

  it('opens Improve with AI from the ⋯ menu, and closes it again', async () => {
    const user = await pickInStoredForm(/^Improve with AI/)
    await user.click(within(screen.getByRole('dialog', { name: 'Improve with AI' })).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Improve with AI' })).not.toBeInTheDocument() })
  })

  it('keeps the draft when a new form\'s first save gives the address its id', async () => {
    api.createForm.mockImplementation((form) => Promise.resolve(stored(form, { form_id: 'f_new', revision: 1 })))
    const user = userEvent.setup()
    renderAt('/feedback-forms/new/questions', handoffState({ form: sampleForm({ name: 'From a template' }), templateId: 'blank', ai: null }))
    await screen.findByRole('heading', { name: 'From a template' })
    await user.keyboard('{Control>}s{/Control}')
    // (the header's state chip: the welcome card says Off too)
    await waitFor(() => { expect(within(screen.getByRole('banner')).getByText('Off')).toBeInTheDocument() })
    expect(screen.queryByText('Not saved yet')).not.toBeInTheDocument()
    expect(api.getForm).not.toHaveBeenCalledWith('f_new')
  })

  it('leaves for the picker without asking when an AI draft is discarded', async () => {
    const user = userEvent.setup()
    renderAt('/feedback-forms/new/questions', handoffState({
      form: sampleForm(), templateId: null, ai: { notes: [], warnings: [], description: 'Ask why people cancel', channel: 'link', addresses: [] },
    }))
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Discard the AI draft?' })).getByRole('button', { name: 'Discard draft' }))
    expect(await screen.findByRole('heading', { name: 'New form' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument()
  })
})
