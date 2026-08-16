/**
 * @fileoverview Tests for Prioritization page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MAX_NOTE_LENGTH } from './prioritizationUtils'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Mock API
const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockPatchPrioritizationScores = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
  },
}))

vi.mock('../../api/client', () => ({
  api: {
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    patchPrioritizationScores: (scores: unknown) => mockPatchPrioritizationScores(scores),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

const mockProjects = [
  { project_id: 'p1', name: 'Project 1', status: 'active', created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 2, document_count: 3 },
  { project_id: 'p2', name: 'Project 2', status: 'active', created_at: '2025-01-02', updated_at: '2025-01-02', persona_count: 1, document_count: 2 },
]

const mockProjectDetails = [
  {
    project_id: 'p1',
    documents: [
      { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '# Feature A\n\nThis is a great feature.', created_at: '2025-01-01' },
      { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: 'PRD content', created_at: '2025-01-01' },
    ],
  },
  {
    project_id: 'p2',
    documents: [
      { document_id: 'd3', document_type: 'prfaq', title: 'Feature B PR/FAQ', content: '# Feature B', created_at: '2025-01-02' },
    ],
  },
]

describe('Prioritization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjects.mockResolvedValue({ projects: mockProjects })
    mockGetProject.mockImplementation((id) => {
      const detail = mockProjectDetails.find(d => d.project_id === id)
      return Promise.resolve(detail || { documents: [] })
    })
    mockGetPrioritizationScores.mockResolvedValue({
      scores: {
        d1: { document_id: 'd1', impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
        d3: { document_id: 'd3', impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
      },
    })
    mockPatchPrioritizationScores.mockResolvedValue({ success: true, updated_count: 1 })
  })

  function renderPrioritization() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    
    const router = createMemoryRouter([
      { path: '/', element: <Prioritization /> },
    ])
    
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
  }

  describe('regression: saved scores stay in sync with the server (#95)', () => {
    it('displays refetched scores instead of the first snapshot', async () => {
      // First fetch: d1 unscored. Later refetch: d1 scored 5/5/5/5 (priority 4.4).
      mockGetPrioritizationScores
        .mockResolvedValueOnce({
          scores: {
            d1: { document_id: 'd1', impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' },
          },
        })
        .mockResolvedValue({
          scores: {
            d1: { document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '' },
          },
        })

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      )

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      // Simulate the post-save invalidation (or any background refetch):
      // the fresh server values must reach the UI. The old implementation
      // seeded local state once and ignored every refetch.
      await queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })

      // All-5s => priority 5×0.4 + 5×0.3 + 5×0.2 + 5×0.1 = 5.0
      await waitFor(() => {
        expect(screen.getAllByText('5.0').length).toBeGreaterThan(0)
      })
    })
  })

  describe('rendering', () => {
    it('renders page header', async () => {
      renderPrioritization()

      expect(screen.getByText('Prioritization')).toBeInTheDocument()
    })

    it('renders stats cards', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Total Documents')).toBeInTheDocument()
        expect(screen.getByText('High Priority')).toBeInTheDocument()
        expect(screen.getByText('Medium Priority')).toBeInTheDocument()
        expect(screen.getByText('Not Scored')).toBeInTheDocument()
      })
    })

    it('renders sort controls', async () => {
      renderPrioritization()

      expect(screen.getByText('Sort by:')).toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      mockGetProjects.mockReturnValue(new Promise(() => {})) // Never resolves

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Loading documents...')).toBeInTheDocument()
      })
    })
  })

  describe('empty state', () => {
    it('shows generic empty state when no projects exist', async () => {
      mockGetProjects.mockResolvedValue({ projects: [] })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('No Documents Found')).toBeInTheDocument()
      })
    })

    it('shows wrong-type empty state when projects have only non-scorable documents', async () => {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'r1', document_type: 'research', title: 'Research Only', content: '', created_at: '2025-01-01' },
        ],
      })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('No Scorable Documents')).toBeInTheDocument()
      })
    })
  })

  describe('PR/FAQ list', () => {
    it('displays PR/FAQ items after loading', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
        expect(screen.getByText('Feature B PR/FAQ')).toBeInTheDocument()
      })
    })

    it('shows project name for each document row', async () => {
      renderPrioritization()

      await waitFor(() => {
        // Project 1 may appear in multiple rows (prfaq + prd); just check at least one exists
        expect(screen.getAllByText('Project 1').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Project 2').length).toBeGreaterThan(0)
      })
    })

    it('shows Not Scored label for unscored items', async () => {
      renderPrioritization()

      await waitFor(() => {
        const notScoredLabels = screen.getAllByText('Not Scored')
        expect(notScoredLabels.length).toBeGreaterThan(0)
      })
    })

    it('displays PRD documents alongside PR/FAQ documents', async () => {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: '', created_at: '2025-01-02' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({ scores: {} })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
        expect(screen.getByText('Feature A PRD')).toBeInTheDocument()
      })
    })

    it('shows document type badge for each row', async () => {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: '', created_at: '2025-01-02' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({ scores: {} })

      renderPrioritization()

      await waitFor(() => {
        // Both type badges must be visible so users can tell them apart
        expect(screen.getByText('PR/FAQ')).toBeInTheDocument()
        expect(screen.getByText('PRD')).toBeInTheDocument()
      })
    })
  })

  describe('expand/collapse', () => {
    it('expands PR/FAQ row when clicked', async () => {
      const user = userEvent.setup()
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Feature A PR/FAQ'))

      await waitFor(() => {
        expect(screen.getByText('Prioritization Scores')).toBeInTheDocument()
        expect(screen.getByText('Document Preview')).toBeInTheDocument()
      })
    })
  })

  describe('sorting', () => {
    it('changes sort when clicking sort button', async () => {
      const user = userEvent.setup()
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      // Click on Impact sort button (multiple matches due to mobile/desktop spans)
      const impactButtons = screen.getAllByRole('button', { name: /impact/i })
      await user.click(impactButtons[0])

      // Button should be highlighted
      expect(impactButtons[0]).toHaveClass('bg-blue-100')
    })
  })

  describe('regression: missing scores do not crash', () => {
    /**
     * Regression test for: TypeError: Cannot read properties of undefined (reading 'impact')
     * When the API returns no saved scores, StatsCards must not crash accessing scores[id].impact.
     */
    it('renders stats cards when scores API returns empty object', async () => {
      mockGetPrioritizationScores.mockResolvedValue({ scores: {} })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      // StatsCards should render without crashing
      expect(screen.getByText('Total Documents')).toBeInTheDocument()
    })

    it('renders stats cards when scores API returns no scores key', async () => {
      mockGetPrioritizationScores.mockResolvedValue({})

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      expect(screen.getByText('Total Documents')).toBeInTheDocument()
    })
  })

  describe('save functionality', () => {
    it('save button is disabled when no changes', async () => {
      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      const saveButton = screen.getByRole('button', { name: /save/i })
      expect(saveButton).toBeDisabled()
    })
  })

  describe('a failed score read is not an unscored backlog', () => {
    // The endpoint raises on a failed read rather than answering an empty map,
    // precisely so "the read failed" and "nobody has scored anything" stop
    // looking identical. Reading only `data` would undo that on screen: every row
    // falls back to DEFAULT_SCORE and the page looks merely unscored.

    it('shows an error rather than presenting defaults as saved scores', async () => {
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByRole('alert', { name: 'Scores could not be loaded' })).toBeInTheDocument()
      })
      // The documents still list — the failure is the SCORES read, not the page.
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
    })

    it('does not offer to save over scores it could not read', async () => {
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    })

    it('shows no error when the backlog is genuinely unscored', async () => {
      mockGetPrioritizationScores.mockResolvedValue({ scores: {} })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('a note the API will refuse never leaves the page', () => {
    // The API refuses a note past MAX_NOTE_LENGTH rather than truncating it, and
    // `fetchApi` throws `API Error: 400` while discarding the body — so a refusal
    // the page cannot anticipate arrives as a Save button that does nothing. Two
    // halves keep that from happening: `maxLength` bounds what a reviewer types,
    // and this panel catches a note that was already over the bound in the
    // pre-ballot data, which is sent along the moment a slider on that row moves.
    const overLong = 'x'.repeat(MAX_NOTE_LENGTH + 1)

    /** Load a score whose note is already over the bound, then move a slider. */
    async function editARowWhoseNoteIsTooLong() {
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: {
            document_id: 'd1', impact: 3, time_to_market: 3, confidence: 3,
            strategic_fit: 3, notes: overLong,
          },
        },
      })
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '5' } })
      return user
    }

    it('bounds the notes textarea at the length the API accepts', async () => {
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Feature A PR/FAQ'))

      const notes = await screen.findByPlaceholderText(/add notes/i)
      // Asserted as a NUMBER against the shared constant, not as the string '2000':
      // a hardcoded literal in the JSX would pass a text comparison while drifting
      // from the bound the API enforces.
      expect(notes).toHaveAttribute('maxlength', String(MAX_NOTE_LENGTH))
    })

    it('blocks the save when an edited row carries an over-long note', async () => {
      await editARowWhoseNoteIsTooLong()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
      })
    })

    it('says why, rather than leaving a dead button', async () => {
      await editARowWhoseNoteIsTooLong()

      await waitFor(() => {
        expect(screen.getByRole('alert', { name: 'A note is too long to save' })).toBeInTheDocument()
      })
      // The bound is the actionable part, so it has to reach the screen — an
      // unresolved interpolation would render the placeholder instead.
      const panel = screen.getByRole('alert', { name: 'A note is too long to save' })
      expect(panel).toHaveTextContent(String(MAX_NOTE_LENGTH))
      expect(panel).not.toHaveTextContent('{{max}}')
      // And WHICH row, by title: the ids the check returns mean nothing to a
      // reviewer, and rows are collapsed by default.
      expect(panel).toHaveTextContent('Feature A PR/FAQ')
    })

    it('never sends the body the API would refuse', async () => {
      const user = await editARowWhoseNoteIsTooLong()

      await user.click(screen.getByRole('button', { name: /save/i }))

      expect(mockPatchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('leaves an untouched row with a long note alone', async () => {
      // Only pending edits are sent, so a pre-ballot note that ran long on a row
      // nobody edited blocks nothing. Without this the panel would fire on load
      // and disable a page that has nothing wrong with it.
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: {
            document_id: 'd1', impact: 3, time_to_market: 3, confidence: 3,
            strategic_fit: 3, notes: overLong,
          },
        },
      })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps both panels separately addressable when a read also failed', async () => {
      // Nothing stops a failed read and a long pending note from coexisting, and
      // two same-role regions with no accessible name are indistinguishable — to a
      // screen reader, and to a `getByRole('alert')` that throws on the second
      // rather than saying which state was missing.
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const notes = await screen.findByPlaceholderText(/add notes/i)
      // Past the bound in one go: `maxLength` caps typing, so the case has to
      // arrive the way it does in production — as a value the page did not type.
      fireEvent.change(notes, { target: { value: overLong } })

      await waitFor(() => {
        expect(screen.getAllByRole('alert')).toHaveLength(2)
      })
      expect(screen.getByRole('alert', { name: 'Scores could not be loaded' })).toBeInTheDocument()
      expect(screen.getByRole('alert', { name: 'A note is too long to save' })).toBeInTheDocument()
    })

    it('measures the note in the unit the API measures it in', async () => {
      // `.length` is UTF-16 code units, Python's `len()` is code points. A note of
      // 1500 emoji is 3000 units and 1500 code points, so a code-unit count would
      // block a save the API accepts, quoting a limit the reviewer never reached.
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: {
            document_id: 'd1', impact: 3, time_to_market: 3, confidence: 3,
            strategic_fit: 3, notes: '😀'.repeat(MAX_NOTE_LENGTH - 500),
          },
        },
      })
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '5' } })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      expect(screen.queryByRole('alert', { name: 'A note is too long to save' }))
        .not.toBeInTheDocument()
    })

    it('still saves a row whose note is within the bound', async () => {
      // The positive control: the block must be the note's length and nothing
      // else, or "save is disabled" would be satisfied by a page that never saves.
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: {
            document_id: 'd1', impact: 3, time_to_market: 3, confidence: 3,
            strategic_fit: 3, notes: 'x'.repeat(MAX_NOTE_LENGTH),
          },
        },
      })
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '5' } })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      await user.click(screen.getByRole('button', { name: /save/i }))
      expect(mockPatchPrioritizationScores).toHaveBeenCalled()
    })
  })
})
