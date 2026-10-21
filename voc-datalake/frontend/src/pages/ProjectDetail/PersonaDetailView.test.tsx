/**
 * @fileoverview Tests for PersonaDetailView's header review count and its
 * "View source feedback" entry point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import PersonaDetailView from './PersonaDetailView'
import type { ProjectPersona } from '../../api/types'

const mockGetPersonaSourceFeedback = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getPersonaSourceFeedback: (...args: unknown[]) => mockGetPersonaSourceFeedback(...args),
  },
}))

const basePersona: ProjectPersona = {
  persona_id: 'persona-1',
  name: 'Dana',
  tagline: 'Orders late',
  created_at: '',
  confidence: 'high',
  feedback_count: 14,
}

function renderView(
  persona: ProjectPersona,
  { onToggleProtected = vi.fn(), isTogglingProtected = false } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PersonaDetailView
          projectId="proj-1"
          persona={persona}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSaveNotes={vi.fn()}
          onToggleProtected={onToggleProtected}
          isDeleting={false}
          isSavingNotes={false}
          isTogglingProtected={isTogglingProtected}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PersonaDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the cited-review count when the persona recorded the reviews it cites', () => {
    renderView({ ...basePersona, evidence_feedback_ids: ['f1', 'f2', 'f3'] })

    expect(screen.getByText(/high confidence/)).toHaveTextContent('high confidence • 3 cited reviews')
    expect(screen.queryByText(/14 reviews/)).not.toBeInTheDocument()
  })

  it('shows the singular cited-review count when one review is cited', () => {
    renderView({ ...basePersona, evidence_feedback_ids: ['f1'] })

    expect(screen.getByText(/high confidence/)).toHaveTextContent('high confidence • 1 cited review')
  })

  it('shows the model estimate unchanged when the persona predates source tracking', () => {
    renderView(basePersona)

    expect(screen.getByText(/high confidence/)).toHaveTextContent('high confidence • 14 reviews')
  })

  it('opens the source feedback modal for this persona when the menu item is chosen', async () => {
    const user = userEvent.setup()
    mockGetPersonaSourceFeedback.mockResolvedValue({
      available: false, scope: 'cited', total: 0, offset: 0, items: [], missing: 0, provenance: null,
    })
    renderView(basePersona)

    await user.click(screen.getByLabelText('Export persona'))
    await user.click(screen.getByRole('menuitem', { name: 'View source feedback' }))

    expect(screen.getByRole('dialog', { name: 'Source feedback for @Dana' })).toBeInTheDocument()
    expect(mockGetPersonaSourceFeedback).toHaveBeenCalledWith('proj-1', 'persona-1', { scope: 'cited', offset: 0, limit: 25 })
    expect(await screen.findByText(/generated before source tracking was added/)).toBeInTheDocument()
  })

  it('offers to protect an unprotected persona and shows no protected badge', async () => {
    const user = userEvent.setup()
    const onToggleProtected = vi.fn()
    renderView(basePersona, { onToggleProtected })

    const toggle = screen.getByRole('button', { name: 'Protect from regeneration' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Protected')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(onToggleProtected).toHaveBeenCalledTimes(1)
  })

  it('marks a protected persona and offers to release it', () => {
    renderView({ ...basePersona, protected: true })

    expect(screen.getByRole('button', { name: 'Stop protecting' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Protected')).toHaveAttribute('title', 'Kept when personas are regenerated')
  })

  it('disables the protect toggle while the change is saving', () => {
    renderView(basePersona, { isTogglingProtected: true })

    expect(screen.getByRole('button', { name: 'Protect from regeneration' })).toBeDisabled()
  })
})
