/**
 * @fileoverview Tests for Prioritization page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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
      // First fetch: nobody has scored d1. Later refetch: the team scored it
      // 5/5/5/5, composite 5.0. The assertion reads the ROW's headline, which is
      // now the team's aggregate — the caller's own refetched ballot is covered by
      // the sibling case below, through the sliders it now lives behind.
      mockGetPrioritizationScores
        .mockResolvedValueOnce({
          scores: {},
          aggregates: {},
        })
        .mockResolvedValue({
          scores: {},
          aggregates: {
            d1: {
              impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5,
              reviewer_count: 3, score_spread: 0,
            },
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

    it("displays the caller's own refetched ballot on the sliders", async () => {
      // The other half of #95, on the axes' new home: a refetch has to reach the
      // sliders too, not only the row's team headline.
      mockGetPrioritizationScores
        .mockResolvedValueOnce({
          scores: {
            d1: { document_id: 'd1', impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '' },
          },
        })
        .mockResolvedValue({
          scores: {
            d1: { document_id: 'd1', impact: 4, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '' },
          },
        })
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
      const user = userEvent.setup()
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      )
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const impact = (await screen.findAllByRole('slider'))[0]
      expect(impact).toHaveValue('1')

      await queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })

      await waitFor(() => {
        expect(impact).toHaveValue('4')
      })
    })
  })

  describe('the row leads with the team score, not the reader own', () => {
    // Prioritization is a group exercise. The resting row shows what the group
    // said, the reader's own ballot moves behind the expansion, and the list is
    // ordered by the number the row displays.

    /**
     * Load one document with a caller ballot and a team aggregate that differ.
     *
     * The team's axes are deliberately unequal, so its composite (2.1) is a value
     * no single axis on the row also renders — otherwise "the composite is on
     * screen" would be satisfied by an axis that happens to match it.
     */
    function loadDisagreeingBallotAndAggregate() {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        // The caller scored it top marks: composite 5.0.
        scores: {
          d1: { document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: 'mine' },
        },
        // The team: 1*0.4 + 3*0.3 + 2*0.2 + 4*0.1 = 2.1.
        aggregates: {
          d1: {
            impact: 1, time_to_market: 3, confidence: 4, strategic_fit: 2,
            reviewer_count: 3, score_spread: 1.8,
          },
        },
      })
    }

    it("shows the team composite on the collapsed row, not the caller own", async () => {
      loadDisagreeingBallotAndAggregate()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('2.1')).toBeInTheDocument()
      })
      // And the caller's own 5.0 is NOT on the resting row — this is the half that
      // fails if the row keeps rendering the caller's ballot, whose composite is
      // the only other number the same summary could show.
      expect(screen.queryByText('5.0')).not.toBeInTheDocument()
      expect(screen.getByText('Team Score')).toBeInTheDocument()
    })

    it('names the number as the team score rather than plain "Score"', async () => {
      loadDisagreeingBallotAndAggregate()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Team Score')).toBeInTheDocument()
      })
      // The old label. The number changed meaning from "my composite" to "the
      // team's mean composite", and a row a reader cannot attribute is worse than
      // either alone.
      expect(screen.queryByText('Score')).not.toBeInTheDocument()
    })

    it('shows the reviewer count wherever the mean appears', async () => {
      // One ballot yields a mean equal to that ballot and a spread of zero, which
      // reads as agreement. The count is what tells "we agree" from "one looked".
      loadDisagreeingBallotAndAggregate()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Reviewers')).toBeInTheDocument()
      })
      expect(screen.getByText('3')).toBeInTheDocument()
    })

    it('leads a reader to the notes with the spread, on the resting row', async () => {
      loadDisagreeingBallotAndAggregate()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Spread 1.8')).toBeInTheDocument()
      })
    })

    it('shows no spread badge when the reviewers agreed', async () => {
      // The positive control for the badge: "spread 0.0" would say "look at the
      // disagreement here" about a row with none.
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
        aggregates: {
          d1: {
            impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4,
            reviewer_count: 3, score_spread: 0,
          },
        },
      })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      expect(screen.queryByText(/^Spread/)).not.toBeInTheDocument()
    })

    it("keeps the caller own sliders and note editable one level in", async () => {
      loadDisagreeingBallotAndAggregate()
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))

      const sliders = await screen.findAllByRole('slider')
      // Four axes, seeded from the CALLER'S ballot (5s), not from the team mean (2s).
      expect(sliders).toHaveLength(4)
      for (const slider of sliders) expect(slider).toHaveValue('5')
      expect(await screen.findByPlaceholderText(/add notes/i)).toHaveValue('mine')
    })

    it("still saves only the caller own ballot from the expanded row", async () => {
      loadDisagreeingBallotAndAggregate()
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '1' } })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      await user.click(screen.getByRole('button', { name: /save/i }))

      // The caller's own axes, and nothing about the aggregate.
      expect(mockPatchPrioritizationScores).toHaveBeenCalledWith({
        d1: {
          document_id: 'd1', impact: 1, time_to_market: 5, confidence: 5,
          strategic_fit: 5, notes: 'mine',
        },
      })
    })

    it('says nobody has scored a document absent from the aggregate', async () => {
      // The defect this closes: DEFAULT_SCORE has time_to_market 3 and the old
      // summary substituted 3 for an unset axis, so an untouched proposal
      // presented as a mid-table score.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).toHaveTextContent('Not scored yet')
      // No mid-table number invented from the defaults: 0.9 is what
      // calculatePriorityScore returns for DEFAULT_SCORE, and 3 is what the old
      // summary rendered for an unset time-to-market axis.
      expect(row).not.toHaveTextContent('0.9')
      expect(row).not.toHaveTextContent('3')
      // And the band beside the title says so too, rather than "Low Priority".
      expect(row).toHaveTextContent('Not Scored')
    })

    it('sorts by the team composite, grouping the unscored below a low score', async () => {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      // Listed in the order the expectation must NOT be: with no sort applied at
      // all, a stable sort leaves this order (reversed for `desc`) on screen, so
      // an assertion that agreed with it would pass without any ordering.
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd3', document_type: 'prfaq', title: 'Team Rated High', content: '', created_at: '2025-01-03' },
          { document_id: 'd2', document_type: 'prfaq', title: 'Team Rated Low', content: '', created_at: '2025-01-02' },
          { document_id: 'd1', document_type: 'prfaq', title: 'Nobody Scored', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        // The caller's own ballot ranks them in the OPPOSITE order, so a list still
        // sorting by the caller's map cannot pass this by coincidence.
        scores: {
          d1: { document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '' },
          d2: { document_id: 'd2', impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4, notes: '' },
          d3: { document_id: 'd3', impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '' },
        },
        aggregates: {
          d2: {
            impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1,
            reviewer_count: 2, score_spread: 0,
          },
          d3: {
            impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5,
            reviewer_count: 2, score_spread: 0,
          },
        },
      })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Nobody Scored')).toBeInTheDocument()
      })
      // Default sort is priority, descending: highest team score first, and the
      // unscored proposal last rather than ahead of the one the team rated low.
      const rowTitles = screen.getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((title) => title !== 'Prioritization Framework')
      expect(rowTitles).toEqual(['Team Rated High', 'Team Rated Low', 'Nobody Scored'])
    })

    it('reads as unscored when the deployment sends no aggregates at all', async () => {
      // The field is additive: a deployment predating it answers `scores` alone,
      // and that must not throw or present the caller's own numbers as the team's.
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: { document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '' },
        },
      })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getAllByText('Not scored yet').length).toBeGreaterThan(0)
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('counts the stats cards off the team aggregate, not the reader own map', async () => {
      // The cards sit directly above the rows and use the same headings the rows'
      // priority band does, so counting the reader's own opinion under them would
      // make the totals disagree with the list they summarise.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'High For Team', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prfaq', title: 'Unscored By Team', content: '', created_at: '2025-01-02' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        // Reading the caller's map would count d1 as neither high nor medium
        // (composite 1.0) and both rows as not-scored — the opposite of the truth.
        scores: {
          d1: { document_id: 'd1', impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '' },
        },
        aggregates: {
          d1: {
            impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5,
            reviewer_count: 2, score_spread: 0,
          },
        },
      })

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('High For Team')).toBeInTheDocument()
      })

      // Scoped to the stats grid: "High Priority" and "Not Scored" are also the
      // row's own priority-band labels, so an unscoped query reads a row.
      const grid = screen.getByText('Total Documents').closest('div.grid')
      expect(grid).not.toBeNull()
      /** The number printed above one card's label. */
      const cardValue = (label: string) => within(grid ?? document.body)
        .getByText(label).previousElementSibling?.textContent

      // One high (the team's 5.0) and one not scored (absent from the aggregate).
      expect(cardValue('High Priority')).toBe('1')
      expect(cardValue('Not Scored')).toBe('1')
      expect(cardValue('Medium Priority')).toBe('0')
    })

    it('keeps the customer evidence out of the team score panel', async () => {
      // The row carries two numeric stories and they must stay distinct: the star
      // average comes from customers and deliberately does not feed the priority.
      loadDisagreeingBallotAndAggregate()
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))

      const teamPanel = (await screen.findByText('What the Team Said')).closest('div')
      expect(teamPanel).not.toBeNull()
      expect(teamPanel?.textContent).not.toMatch(/Avg Rating|Collected Feedback/)
      // Both stories are on the expanded row, in separate panels.
      expect(screen.getByText('Collected Feedback')).toBeInTheDocument()
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
