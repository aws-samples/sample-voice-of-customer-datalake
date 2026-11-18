/**
 * The forms list card (UX §14.2): the name as a link, the Live / Off switch (refusing in words to publish a form
 * with problems), "Test link on", the summary and responses lines, Results, and ⋯ (Preview never the counting live
 * link, Duplicate as an unsaved copy, QR, Delete). It stays render-safe on sparse and v1 records (issue #171).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'

const mockGetFeedbackFormStats = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormStats: (formId: string) => mockGetFeedbackFormStats(formId),
  },
}))

import FormCard from './FormCard'
import { normalizeFeedbackForms } from './formSchema'
import { readHandoff } from './builder/newFormHandoff'
import type { FeedbackForm } from '../../api/types'
import { defined } from '../../test/defined'

const V2 = {
  form_id: 'form_1', name: 'Website Feedback', enabled: true, schema_version: 2, revision: 2,
  language: 'en', languages: ['en', 'pl'],
  welcome: { enabled: false, title: {} },
  questions: [
    { id: 'q_rating', type: 'rating', headline: { en: 'How was it?' }, required: true, scale: 'star', range: 5 },
    { id: 'q_text', type: 'open_text', headline: { en: 'Tell us more' }, required: false, long: true, input_type: 'text' },
  ],
  hidden_fields: [], endings: [{ id: 'end_thanks', title: { en: 'Thanks' } }],
  settings: { test: { link_enabled: true, record: 'tag' } },
}

function record(raw: Record<string, unknown> = {}): FeedbackForm {
  return defined(normalizeFeedbackForms([{ ...V2, ...raw }])[0], 'form')
}

function Where() {
  const location = useLocation()
  return <output data-testid="where" data-name={readHandoff(location.state)?.form.name ?? ''}>{location.pathname}</output>
}

function renderCard(form: FeedbackForm, handlers: { onToggle?: () => void; onDelete?: () => void; apiEndpoint?: string; statsRefreshing?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/feedback-forms']}>
        <FormCard form={form} onToggle={handlers.onToggle ?? vi.fn()} onDelete={handlers.onDelete ?? vi.fn()}
          apiEndpoint={handlers.apiEndpoint ?? 'https://api.example.com'} statsRefreshing={handlers.statsRefreshing ?? false} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function pick(item: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'More actions for Website Feedback' }))
  await user.click(screen.getByRole('menuitem', { name: item }))
}

describe('FormCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: { total_submissions: 3, avg_rating: 4.1, rating_count: 2 } })
  })

  it('names the form as a link to it, with its questions, languages and responses', async () => {
    renderCard(record())
    expect(screen.getByRole('link', { name: 'Website Feedback' })).toHaveAttribute('href', '/feedback-forms/form_1')
    expect(screen.getByText('2 questions · English, Polski')).toBeInTheDocument()
    expect(await screen.findByText('3 responses')).toBeInTheDocument()
  })

  it('says one response, not one responses', async () => {
    mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: { total_submissions: 1, avg_rating: null, rating_count: 0 } })
    renderCard(record())
    expect(await screen.findByText('1 response')).toBeInTheDocument()
  })

  it('shows a placeholder, never a count, while the stats are being read', () => {
    mockGetFeedbackFormStats.mockReturnValue(new Promise(vi.fn()))
    renderCard(record())
    expect(screen.getByText('Reading the responses…').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/responses?$/)).not.toBeInTheDocument()
  })

  it('marks Test link on, and the average of its first rating', async () => {
    renderCard(record())
    expect(screen.getByText('Test link on')).toBeInTheDocument()
    expect(await screen.findByText('Average 4.1 of 5')).toBeInTheDocument()
  })

  it('says Live or Off on a labelled switch and turns the form off', async () => {
    const onToggle = vi.fn()
    renderCard(record(), { onToggle })
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }))
    expect(onToggle).toHaveBeenCalledWith('form_1', false)
  })

  it('refuses in words to publish a form with problems, with the way to them', async () => {
    const onToggle = vi.fn()
    renderCard(record({ enabled: false, questions: [{ id: 'q_text', type: 'open_text', headline: {}, required: true, long: true, input_type: 'text' }] }), { onToggle })
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Off' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Fix 1 problem before publishing.')
    expect(within(screen.getByRole('alert')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/feedback-forms/form_1/questions')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('opens Results', () => {
    renderCard(record())
    expect(screen.getByRole('link', { name: 'Results' })).toHaveAttribute('href', '/feedback-forms/form_1/results')
  })

  it('previews in the full-screen preview that never submits, not the live link', async () => {
    renderCard(record())
    await pick('Preview')
    expect(screen.getByTestId('where')).toHaveTextContent('/feedback-forms/form_1/preview')
  })

  it('duplicates as an unsaved copy in the builder', async () => {
    renderCard(record())
    await pick('Duplicate')
    expect(screen.getByTestId('where')).toHaveTextContent('/feedback-forms/new/questions')
    expect(screen.getByTestId('where')).toHaveAttribute('data-name', 'Website Feedback (copy)')
  })

  it('opens a scannable QR from its menu', async () => {
    renderCard(record())
    await pick('QR code')
    expect(screen.getByRole('img', { name: i18n.t('components:formQrCode.accessibleName', { formName: 'Website Feedback' }) })).toBeInTheDocument()
  })

  it('asks the page to delete it', async () => {
    const onDelete = vi.fn()
    renderCard(record(), { onDelete })
    await pick('Delete…')
    expect(onDelete).toHaveBeenCalledWith('form_1')
  })

  it('marks the form a prototype build created as prototype pins', () => {
    renderCard(record({ form_type: 'prototype_pin' }))
    expect(screen.getByText('Prototype pins')).toBeInTheDocument()
  })

  it('reads a v1 record as its migrated questions (issue #171: a sparse one too)', () => {
    renderCard(defined(normalizeFeedbackForms([{ form_id: 'form_1', name: 'Website Feedback', enabled: true, rating_enabled: true, question: 'How was it?' }])[0], 'form'))
    expect(screen.getByText(/^2 questions · /)).toBeInTheDocument()
    expect(screen.queryByText('Test link on')).not.toBeInTheDocument()
  })
})
