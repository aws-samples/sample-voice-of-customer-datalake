/**
 * @fileoverview Tests for the persona "View source feedback" modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import PersonaSourceFeedbackModal from './PersonaSourceFeedbackModal'
import type { PersonaSourceFeedbackItem, PersonaSourceFeedbackPage } from '../../api/personaFeedbackSchema'
import type { PersonaFeedbackProvenance, ProjectPersona } from '../../api/types'

const mockGetPersonaSourceFeedback = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getPersonaSourceFeedback: (...args: unknown[]) => mockGetPersonaSourceFeedback(...args),
  },
}))

function feedback(id: string, text: string, extra: Partial<PersonaSourceFeedbackItem> = {}): PersonaSourceFeedbackItem {
  return {
    feedback_id: id, source_id: '', source_platform: 'app_store', source_channel: '', brand_name: '',
    source_created_at: '2025-03-04T10:00:00Z', processed_at: '', original_text: text, original_language: 'en',
    category: '', journey_stage: '', sentiment_label: 'negative', sentiment_score: -0.6, urgency: 'low',
    impact_area: '', ...extra,
  }
}

function page(overrides: Partial<PersonaSourceFeedbackPage> = {}): PersonaSourceFeedbackPage {
  return { available: true, scope: 'cited', total: 0, offset: 0, items: [], missing: 0, provenance: null, ...overrides }
}

const persona: ProjectPersona = {
  persona_id: 'persona-1',
  name: 'Dana',
  tagline: 'Orders late',
  created_at: '',
  evidence_feedback_ids: ['f1', 'f2'],
  input_feedback_ids: ['f1', 'f2', 'f3'],
}

function renderModal(overrides: Partial<ProjectPersona> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PersonaSourceFeedbackModal projectId="proj-1" persona={{ ...persona, ...overrides }} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const sampled: PersonaFeedbackProvenance = { items_used: 145, items_matched: 612, matched_is_lower_bound: false, sample_limit: 145 }

describe('PersonaSourceFeedbackModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the legacy message when the persona predates source tracking', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page({ available: false }))
    renderModal({ evidence_feedback_ids: undefined, input_feedback_ids: undefined })

    expect(await screen.findByText(/generated before source tracking was added/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Source feedback for @Dana' })).toBeInTheDocument()
  })

  it('shows the cited reviews when the modal opens', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page({
      total: 2,
      items: [feedback('f1', 'Delivery was two weeks late'), feedback('f2', 'Tracking never updates', { source_created_at: '', date: '2025-02-01' })],
    }))
    renderModal()

    expect(await screen.findByText('Delivery was two weeks late')).toBeInTheDocument()
    expect(screen.getByText('Tracking never updates')).toBeInTheDocument()
    // Falls back to the row's `date` when the written-at timestamp is empty.
    expect(screen.getByText('Feb 1, 2025')).toBeInTheDocument()
    expect(screen.getAllByText('app store')).toHaveLength(2)
    expect(mockGetPersonaSourceFeedback).toHaveBeenCalledWith('proj-1', 'persona-1', { scope: 'cited', offset: 0, limit: 25 })
  })

  it('shows the recorded counts on the tabs when the persona carries its id lists', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page())
    renderModal()

    expect(screen.getByRole('tab', { name: 'Cited by this persona (2)' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'All reviews used (3)' })).toHaveAttribute('aria-selected', 'false')
    await screen.findByText(/didn't cite specific reviews/)
  })

  it('requests scope "used" when the All reviews used tab is chosen', async () => {
    const user = userEvent.setup()
    mockGetPersonaSourceFeedback.mockImplementation((_project: string, _persona: string, query: { scope: string }) =>
      Promise.resolve(query.scope === 'used'
        ? page({ scope: 'used', total: 1, items: [feedback('f3', 'Read but not cited')] })
        : page({ total: 1, items: [feedback('f1', 'Cited review')] })))
    renderModal()
    await screen.findByText('Cited review')

    await user.click(screen.getByRole('tab', { name: /All reviews used/ }))

    expect(await screen.findByText('Read but not cited')).toBeInTheDocument()
    expect(mockGetPersonaSourceFeedback).toHaveBeenLastCalledWith('proj-1', 'persona-1', { scope: 'used', offset: 0, limit: 25 })
    expect(screen.getByRole('tab', { name: /All reviews used/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the even-sample wording when the persona read a sample of the matches', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page())
    renderModal({ feedback_provenance: sampled })

    expect(screen.getByText('Built from an even sample of 145 of 612 matching reviews')).toBeInTheDocument()
    await screen.findByText(/didn't cite specific reviews/)
  })

  it('shows "N+" in the sample wording when the match count is a lower bound', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page())
    renderModal({ feedback_provenance: { ...sampled, items_matched: 50000, matched_is_lower_bound: true } })

    expect(screen.getByText('Built from an even sample of 145 of 50000+ matching reviews')).toBeInTheDocument()
    await screen.findByText(/didn't cite specific reviews/)
  })

  it('shows the all-reviews wording when the persona read every match', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page())
    renderModal({ feedback_provenance: { items_used: 40, items_matched: 40, matched_is_lower_bound: false, sample_limit: 145 } })

    expect(screen.getByText('Built from all 40 matching reviews')).toBeInTheDocument()
    await screen.findByText(/didn't cite specific reviews/)
  })

  it('shows the provenance from the first page when the persona row lacks it', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page({ total: 1, items: [feedback('f1', 'One')], provenance: sampled }))
    renderModal()

    expect(await screen.findByText('Built from an even sample of 145 of 612 matching reviews')).toBeInTheDocument()
  })

  it('shows the empty-cited message when the model cited nothing', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page({ total: 0 }))
    renderModal({ evidence_feedback_ids: [] })

    expect(await screen.findByText("The model didn't cite specific reviews for this persona.")).toBeInTheDocument()
  })

  it('shows how many reviews were deleted when a page reports missing ids', async () => {
    mockGetPersonaSourceFeedback.mockResolvedValue(page({ total: 3, items: [feedback('f1', 'Still here')], missing: 2 }))
    renderModal()

    expect(await screen.findByText('2 reviews were deleted since this persona was generated.')).toBeInTheDocument()
  })

  it('fetches offset 25 when Load more is clicked, and sums deleted reviews across pages', async () => {
    const user = userEvent.setup()
    const firstPage = Array.from({ length: 24 }, (_, n) => feedback(`f${n}`, `Review ${n}`))
    mockGetPersonaSourceFeedback
      .mockResolvedValueOnce(page({ total: 30, items: firstPage, missing: 1 }))
      .mockResolvedValueOnce(page({ total: 30, offset: 25, items: [feedback('f25', 'Second page review')], missing: 4 }))
    renderModal()
    await screen.findByText('Review 0')

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Second page review')).toBeInTheDocument()
    // The request steps by the page size, not by the 24 rows the first page held.
    expect(mockGetPersonaSourceFeedback).toHaveBeenLastCalledWith('proj-1', 'persona-1', { scope: 'cited', offset: 25, limit: 25 })
    expect(screen.getByText('5 reviews were deleted since this persona was generated.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('shows an error with a Retry button when the request fails, and recovers on retry', async () => {
    const user = userEvent.setup()
    mockGetPersonaSourceFeedback
      .mockRejectedValueOnce(new Error('API Error: 500'))
      .mockResolvedValueOnce(page({ total: 1, items: [feedback('f1', 'Loaded on retry')] }))
    renderModal()

    expect(await screen.findByText("Couldn't load the source feedback.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Loaded on retry')).toBeInTheDocument()
  })

  it('opens the feedback detail overlay on top when a review is clicked', async () => {
    const user = userEvent.setup()
    mockGetPersonaSourceFeedback.mockResolvedValue(page({
      total: 1,
      items: [feedback('f1', 'Delivery was two weeks late', { problem_summary: 'Late delivery' })],
    }))
    renderModal()

    await user.click(await screen.findByRole('button', { name: /Delivery was two weeks late/ }))

    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2))
    const overlay = screen.getAllByRole('dialog')[1]
    expect(within(overlay).getByText('Late delivery')).toBeInTheDocument()
    expect(within(overlay).getByRole('link', { name: 'Open full details' })).toHaveAttribute('href', '/feedback/f1')
  })
})
