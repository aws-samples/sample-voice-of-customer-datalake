/**
 * The forms list card (UX §14.2): the whole card a link to the form (a quiet title link), the Live / Off switch
 * (refusing in words to publish a form with problems; asking before a Live form with responses goes Off), "Test link
 * on", the summary, the headline figure as a number and the responses, Results, and ⋯ (Preview never the counting live
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

import { setCurrentTrial } from '../../workspace/currentTrial'
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

/** The card's stats: three responses and no figure (no rating, no headline), plus `extra`. */
function threeResponses(extra: Record<string, unknown> = {}) {
  mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: {
    total_submissions: 3, avg_rating: null, rating_count: 0, headline: null, ...extra,
  } })
}

/** The card with only its three responses said (no time, no channel): rendered once they show. */
async function renderPlainCard() {
  threeResponses()
  renderCard(record())
  await screen.findByText('3 responses')
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

  it('marks Test link on, and shows the headline figure as a number with its label under it', async () => {
    mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: {
      total_submissions: 3, avg_rating: 4.1, rating_count: 2, headline: { question_id: 'q_rating', type: 'rating', value: 4.1, count: 2, scale_max: 5 },
    } })
    renderCard(record())
    expect(screen.getByText('Test link on')).toBeInTheDocument()
    expect(await screen.findByText('4.1 / 5')).toBeInTheDocument()
    expect(screen.getByText('Average rating')).toBeInTheDocument()
  })

  it.each([
    [{ type: 'nps', value: 32.4, count: 40, scale_max: 10 }, '+32', 'NPS'],
    [{ type: 'nps', value: -8, count: 40, scale_max: 10 }, '−8', 'NPS'],
    [{ type: 'csat', value: 84, count: 40, scale_max: 5 }, '84%', 'CSAT'],
  ])('writes the %o figure as people read it', async (headline, value, label) => {
    mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: { total_submissions: 40, avg_rating: null, rating_count: 0, headline } })
    renderCard(record())
    expect(await screen.findByText(value)).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('says when the last response came, and nothing when the stats carry no time', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000).toISOString()
    threeResponses({ last_response_at: twoHoursAgo })
    const { unmount } = renderCard(record())
    expect(await screen.findByText(/^Last response: /)).toHaveTextContent(/2 hr\. ago|Yesterday/)
    unmount()
    await renderPlainCard()
    expect(screen.queryByText(/^Last response: /)).not.toBeInTheDocument()
  })

  it('names the ways the form was answered in the last 30 days, and nothing without one', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    threeResponses({ last_response_at: daysAgo(1), channels: { iframe: daysAgo(2), link: daysAgo(40), script: daysAgo(1) } })
    const { unmount } = renderCard(record())
    const chips = await screen.findByRole('list', { name: 'Answered through' })
    expect(within(chips).getAllByRole('listitem').map((chip) => chip.textContent)).toStrictEqual(['Website script', 'Embedded'])
    unmount()
    await renderPlainCard()
    expect(screen.queryByRole('list', { name: 'Answered through' })).not.toBeInTheDocument()
  })

  it('shows no figure when the form has no measuring answer yet', async () => {
    await renderPlainCard()
    expect(screen.queryByText(/ \/ 5$/)).not.toBeInTheDocument()
  })

  it('makes the whole card the way into the form, its title a quiet link', () => {
    renderCard(record())
    const title = screen.getByRole('link', { name: 'Website Feedback' })
    expect(title).toHaveClass('link-quiet', 'after:absolute', 'after:inset-0')
    expect(screen.getByRole('article', { name: 'Website Feedback' })).toHaveClass('relative')
  })

  it('keeps the switch label as wide as its widest word, so Results never moves', () => {
    renderCard(record())
    const label = screen.getByRole('switch', { name: 'Live' }).closest('label')
    expect(label).toHaveTextContent('LiveOffLive')
  })

  it('asks before turning off a Live form people are answering, and turns it off only when told', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderCard(record(), { onToggle })
    await screen.findByText('3 responses')
    await user.click(screen.getByRole('switch', { name: 'Live' }))
    const dialog = screen.getByRole('dialog', { name: 'Turn off “Website Feedback”?' })
    expect(dialog).toHaveTextContent('Its link and embeds will show “Feedback form unavailable.” to the next respondents.')
    expect(onToggle).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onToggle).not.toHaveBeenCalled()
    await user.click(screen.getByRole('switch', { name: 'Live' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }))
    expect(onToggle).toHaveBeenCalledWith('form_1', false)
  })

  it('turns off a Live form nobody answered at once', async () => {
    mockGetFeedbackFormStats.mockResolvedValue({ success: true, form_id: 'form_1', stats: { total_submissions: 0, avg_rating: null, rating_count: 0 } })
    const onToggle = vi.fn()
    renderCard(record(), { onToggle })
    await screen.findByText('0 responses')
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onToggle).toHaveBeenCalledWith('form_1', false)
  })

  it('turns a form on without asking', async () => {
    const onToggle = vi.fn()
    renderCard(record({ enabled: false }), { onToggle })
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Off' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onToggle).toHaveBeenCalledWith('form_1', true)
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

  it('previews in the preview window that never submits, not the live link (a tab on a narrow screen)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderCard(record())
    await pick('Preview')
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/form-preview\.html#s=[\w-]+&ui=en&p=phone&n=\w+&tab=1$/u), 'voc-form-preview')
    expect(screen.getByTestId('where')).toHaveTextContent('/feedback-forms')
    open.mockRestore()
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

  // 7.71.00: a paused trial puts no form live; a live form can still be turned off.
  it('holds an Off form\'s switch back in a paused trial, and leaves a live one\'s', () => {
    setCurrentTrial({ trial: { days: 30, expires_at: null, paused_at: '2026-12-21T09:00:05+00:00', converted_at: null,
      paused: { plugins: 0, forms: 1 } }, playbook: null })
    renderCard(record({ enabled: false }))
    expect(screen.getByRole('switch', { name: 'Off' })).toBeDisabled()
    renderCard(record({ form_id: 'form_2' }))
    expect(screen.getByRole('switch', { name: 'Live' })).toBeEnabled()
    setCurrentTrial({ trial: null, playbook: null })
  })

  it('reads a v1 record as its migrated questions (issue #171: a sparse one too)', () => {
    renderCard(defined(normalizeFeedbackForms([{ form_id: 'form_1', name: 'Website Feedback', enabled: true, rating_enabled: true, question: 'How was it?' }])[0], 'form'))
    expect(screen.getByText(/^2 questions · /)).toBeInTheDocument()
    expect(screen.queryByText('Test link on')).not.toBeInTheDocument()
  })
})
