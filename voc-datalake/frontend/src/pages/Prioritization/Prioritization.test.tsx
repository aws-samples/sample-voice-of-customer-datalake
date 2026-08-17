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
      // Scoped to the label's own value, not `getByText('3')` over the whole page:
      // that passed as "some element's text is exactly 3", which a stats card or an
      // axis mean could satisfy, and it said nothing about the count rendering the
      // number it was given. Reading the value beside the label instead fails if the
      // count is rendered as anything other than 3.
      const row = screen.getByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(within(row).getByText('Reviewers').previousElementSibling?.textContent).toBe('3')
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

      // The one axis the reader moved, and nothing about the aggregate. The other
      // three are OMITTED even though this row has a stored ballot for them: the verb
      // is PATCH, so an absent axis means "leave it alone", and re-sending a value the
      // reader did not touch is how the save path was able to write scores nobody
      // chose (see the partial-first-ballot case below).
      expect(mockPatchPrioritizationScores).toHaveBeenCalledWith({
        d1: { document_id: 'd1', impact: 1 },
      })
    })

    it('never writes an axis the reader did not set, on a first partial ballot', async () => {
      // The defect: an edit seeded from DEFAULT_SCORE sent
      // `{impact: 5, time_to_market: 3, confidence: 0, strategic_fit: 0}` when the
      // reader moved impact alone on a row with no stored ballot — two axes as a `0`
      // the slider (min=1) cannot express, while all four sliders on screen read 3.
      // The backend counts an explicit value as a vote (`_carries_axis` is distinct
      // from `_axis_value(...) == 0`) and averages each axis over the reviewers who
      // cast one, so a reviewer who cared only about impact dragged the TEAM's
      // confidence and strategic-fit means toward zero for everybody — into the
      // number this row displays, bands, counts and sorts by.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      // Nobody has scored it: no ballot of the caller's own, and no team row.
      mockGetPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      // Exactly one slider moves. The other three display 3 — the seeding that makes
      // the control usable — and that display value must not become a vote.
      fireEvent.change(sliders[0], { target: { value: '5' } })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      await user.click(screen.getByRole('button', { name: /save/i }))

      expect(mockPatchPrioritizationScores).toHaveBeenCalledWith({
        d1: { document_id: 'd1', impact: 5 },
      })
      // Asserted key by key as well: the equality above passes for an axis present as
      // `undefined`, and a regression that sends `0` — the value the backend counts as
      // a vote — is exactly what this test exists to catch.
      const body = mockPatchPrioritizationScores.mock.calls[0][0]
      for (const axis of ['time_to_market', 'confidence', 'strategic_fit', 'notes']) {
        expect(Object.hasOwn(body.d1, axis), axis).toBe(false)
      }
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
      // calculatePriorityScore returns for DEFAULT_SCORE, and 3.0 is what the old
      // summary rendered for an unset time-to-market axis. Asserted as the VALUES
      // the summary would render, not as the substring '3': a bare digit matched
      // against the row's whole text also matches its date and project name, so that
      // assertion held only while unrelated fixture data happened to avoid the digit.
      expect(within(row).queryByText('0.9')).toBeNull()
      expect(within(row).queryByText('3.0')).toBeNull()
      // The em dash stands where the number would be — a placeholder, never a score, and
      // hidden from assistive technology for that reason: announced alone it reads like a
      // value, while the label beneath it carries the actual state.
      expect(within(row).getByText('—')).toHaveAttribute('aria-hidden', 'true')
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
      const grid = screen.getByText('Total Documents').closest<HTMLElement>('div.grid')
      expect(grid).not.toBeNull()
      /** The number printed above one card's label. */
      const cardValue = (label: string) => within(grid ?? document.body)
        .getByText(label).previousElementSibling?.textContent

      // One high (the team's 5.0) and one not scored (absent from the aggregate).
      expect(cardValue('High Priority')).toBe('1')
      expect(cardValue('Not Scored')).toBe('1')
      expect(cardValue('Medium Priority')).toBe('0')
    })

    it('bands a unanimously-lowest team score as low, not as unscored', async () => {
      // Two rows the page must not describe with the same words: one the team all
      // rated 1, one nobody has opened. The band used to read `composite ?? 0` and
      // called both "Not Scored", beside a live 1.0 and a reviewer count — the
      // issue's "distinguishable in the row" criterion failing in the row.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Team Rated Lowest', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prfaq', title: 'Nobody Opened It', content: '', created_at: '2025-01-02' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
        aggregates: {
          d1: {
            impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1,
            reviewer_count: 3, score_spread: 0,
          },
        },
      })

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Team Rated Lowest')).toBeInTheDocument()
      })

      const scoredLow = screen.getByRole('button', { name: /Team Rated Lowest/ })
      expect(scoredLow).toHaveTextContent('Low Priority')
      // The number it is labelled beside, and the count that says it is a real
      // verdict rather than an empty row. Read from the composite slot rather than
      // by text: a unanimous 1 prints 1.0 on every axis too, so `getByText('1.0')`
      // would be satisfied by an axis instead of the headline.
      expect(within(scoredLow).getByText('Team Score').previousElementSibling?.textContent).toBe('1.0')
      expect(within(scoredLow).getByText('Reviewers').previousElementSibling?.textContent).toBe('3')
      // The words reserved for "nobody voted" are not on a row somebody voted on.
      expect(scoredLow).not.toHaveTextContent('Not Scored')
      expect(scoredLow).not.toHaveTextContent('Not scored yet')

      const unscored = screen.getByRole('button', { name: /Nobody Opened It/ })
      expect(unscored).toHaveTextContent('Not Scored')
      expect(unscored).not.toHaveTextContent('Low Priority')
    })

    it('bands and counts a unanimous 4 as high, matching the 4.0 it prints', async () => {
      // 4 on every axis weighs to 3.9999999999999996. The row prints `4.0`; an
      // unrounded `>= 4` banded it Medium and counted it under Medium Priority, so
      // the card, the band and the number all disagreed on one document.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Unanimous Four', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
        aggregates: {
          d1: {
            impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4,
            reviewer_count: 2, score_spread: 0,
          },
        },
      })

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Unanimous Four')).toBeInTheDocument()
      })

      const row = screen.getByRole('button', { name: /Unanimous Four/ })
      // The composite slot specifically: every axis also prints 4.0 on this fixture.
      expect(within(row).getByText('Team Score').previousElementSibling?.textContent).toBe('4.0')
      expect(row).toHaveTextContent('High Priority')
      expect(row).not.toHaveTextContent('Medium Priority')
      // And the card above the row agrees with the label on it.
      const grid = screen.getByText('Total Documents').closest<HTMLElement>('div.grid')
      const cardValue = (label: string) => within(grid ?? document.body)
        .getByText(label).previousElementSibling?.textContent
      expect(cardValue('High Priority')).toBe('1')
      expect(cardValue('Medium Priority')).toBe('0')
    })

    it('shows an out-of-range team mean at the top of the scale, not at the bottom', async () => {
      // Verified defect: an all-out-of-range row cleared the readability floor (each
      // axis IS a number) and every axis was then caught to 0, so a document three
      // reviewers had scored rendered `0.0 / 0.0 / 0.0`, "Reviewers 3", banded "Low
      // Priority", with a "Spread 2.0" badge over numbers the parse had thrown away —
      // and it sorted BELOW a row the team genuinely rated 1 across the board.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Out Of Range', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prfaq', title: 'Genuinely Lowest', content: '', created_at: '2025-01-02' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
        aggregates: {
          d1: {
            impact: 6, time_to_market: 6, confidence: 6, strategic_fit: 6,
            reviewer_count: 3, score_spread: 2,
          },
          d2: {
            impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1,
            reviewer_count: 3, score_spread: 0,
          },
        },
      })

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Out Of Range')).toBeInTheDocument()
      })

      const row = screen.getByRole('button', { name: /Out Of Range/ })
      // Clamped onto the scale, so the row still describes data somebody cast.
      expect(within(row).getByText('Team Score').previousElementSibling?.textContent).toBe('5.0')
      expect(row).toHaveTextContent('High Priority')
      expect(row).not.toHaveTextContent('Low Priority')
      // And it outranks the row the team actually rated lowest, rather than sorting
      // beneath it on a score the parse invented.
      const rowTitles = screen.getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((title) => title !== 'Prioritization Framework')
      expect(rowTitles).toEqual(['Out Of Range', 'Genuinely Lowest'])
    })

    it('prints the axis value the sort ranks by, where the two roundings differ', async () => {
      // 4.35 is the discriminating mean: `(4.35).toFixed(1)` is "4.3" (the stored double
      // is 4.34999…), while `Math.round(4.35 * 10) / 10` is 4.4. So printing the raw mean
      // while ordering by the rounded one puts the row and the list back into
      // disagreement — the thing one shared rounding exists to prevent. The row must show
      // the value the sort uses.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
        aggregates: {
          d1: {
            impact: 4.35, time_to_market: 1, confidence: 1, strategic_fit: 1,
            reviewer_count: 3, score_spread: 0,
          },
        },
      })

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(within(row).getByText('4.4')).toBeInTheDocument()
      expect(within(row).queryByText('4.3')).toBeNull()
    })

    it('keeps the unscored rows last when the reader sorts ascending', async () => {
      // Flipping the direction asks for the worst-RATED proposals. A block of rows
      // nobody has voted on is not an answer to that, so it stays at the bottom.
      const user = userEvent.setup()
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Nobody Scored', content: '', created_at: '2025-01-01' },
          { document_id: 'd2', document_type: 'prfaq', title: 'Team Rated Low', content: '', created_at: '2025-01-02' },
          { document_id: 'd3', document_type: 'prfaq', title: 'Team Rated High', content: '', created_at: '2025-01-03' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {},
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
      const rowTitles = () => screen.getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((title) => title !== 'Prioritization Framework')
      expect(rowTitles()).toEqual(['Team Rated High', 'Team Rated Low', 'Nobody Scored'])

      // Toggle the active sort field to ascending. Matched on the sort control's own
      // accessible name, which carries both the mobile and desktop labels: a bare
      // `/priority/i` also matches every row button whose band label reads "Low
      // Priority" or "High Priority", and picked the sort button only because
      // `SortControls` happens to precede `PRFAQList` in the DOM.
      await user.click(screen.getByRole('button', { name: /Priority Score$/ }))

      await waitFor(() => {
        expect(rowTitles()).toEqual(['Team Rated Low', 'Team Rated High', 'Nobody Scored'])
      })
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

    it('says whose numbers the score sorts order by, reachably', () => {
      // The three score sort buttons still read "Priority Score" / "Impact" / "TTM"
      // while now ordering by the TEAM's means, which is ambiguous in the same way the
      // old "Score" heading was. Delivered as visible text the buttons point at with
      // `aria-describedby`, not only as a `title`: a tooltip never appears on a touch
      // device and screen-reader support for `title` is inconsistent.
      renderPrioritization()

      const sortButton = screen.getByRole('button', { name: /Priority Score$/ })
      const hintId = sortButton.getAttribute('aria-describedby')
      expect(hintId).toBeTruthy()
      const hint = document.getElementById(hintId ?? '')
      expect(hint).toHaveTextContent("order by the team's numbers")
      // And it names WHICH options do, from the same labels the buttons render, so a
      // sighted reader who has only adjacency to go on can still tell which three.
      expect(hint).toHaveTextContent('Priority Score, Impact, Time to Market')
      // The date sort is not team-ordered, so it must NOT claim to be.
      expect(screen.getByRole('button', { name: /Date Created$/ }))
        .not.toHaveAttribute('aria-describedby')
    })

    it('does not claim the list is team-ordered while the reader sorts by date', async () => {
      // The hint is permanently visible — that is the point of moving it out of a
      // `title` — so a sentence about "the list" was false for as long as Date Created
      // was active: an ascending date order sat directly beneath the words "orders the
      // list by the team's numbers". It describes the BUTTONS instead, which is true in
      // every state, including before the reader has clicked anything.
      const user = userEvent.setup()
      renderPrioritization()

      await user.click(screen.getByRole('button', { name: /Date Created$/ }))

      const hint = document.getElementById(
        screen.getByRole('button', { name: /Priority Score$/ }).getAttribute('aria-describedby') ?? '',
      )
      expect(hint).toBeTruthy()
      expect(hint).not.toHaveTextContent(/Orders the list/i)
      expect(hint).toHaveTextContent("order by the team's numbers")
      // Naming the three team-ordered options is what keeps it true here: the sentence
      // must not name the one that is active and is NOT team-ordered.
      expect(hint).not.toHaveTextContent('Date Created')
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

    it('does not tell a reader nobody has scored a row it could not read', async () => {
      // The row copy is the strongest claim on the page — "No reviewer has scored this
      // yet… The sliders below cast the first ballot" — and it was made about every row
      // whenever the read failed, because `aggregates` fell back to `{}` and absence
      // from that map is how this page says "nobody voted". Inviting a reviewer to cast
      // the first ballot on a document the team may already have scored is how a real
      // ballot gets overwritten by a reader who trusted the row.
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).not.toHaveTextContent('Not scored yet')
      expect(row).not.toHaveTextContent('Not Scored')
      // What it says instead names the READ, not the document.
      expect(row).toHaveTextContent('Team score unavailable')
    })

    it('does not count a failed read as an unscored backlog in the stats cards', async () => {
      // "1 Not Scored" over a one-document backlog is a claim about the document, and a
      // read that never arrived cannot support it. A dash says the count is unknown;
      // "Total Documents" is still a number because the PROJECT read succeeded.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })

      // Scoped to the stats grid: these labels are also the rows' own band labels.
      const grid = screen.getByText('Total Documents').closest<HTMLElement>('div.grid')
      const cardValue = (label: string) => within(grid ?? document.body)
        .getByText(label).previousElementSibling?.textContent

      expect(cardValue('Total Documents')).toBe('1')
      // The dash, plus the reason for it in text only a screen reader reads: the em
      // dash alone is announced as nothing or "em dash", which is indistinguishable
      // from a zero count — the very confusion the dash is there to avoid.
      for (const label of ['Not Scored', 'High Priority', 'Medium Priority']) {
        expect(cardValue(label), label).toBe('—Team score unavailable')
      }
      const dashes = within(grid ?? document.body).getAllByText('—')
      expect(dashes).toHaveLength(3)
      for (const dash of dashes) expect(dash).toHaveAttribute('aria-hidden', 'true')
    })

    it('says the team view could not be read inside the expanded row too', async () => {
      // The panel is where the wording invites the first ballot, so it needs the same
      // three-way distinction the collapsed row now makes.
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))

      const panel = (await screen.findByText('What the Team Said')).parentElement
      expect(panel).toBeTruthy()
      expect(panel).not.toHaveTextContent('No reviewer has scored this yet')
      expect(panel).toHaveTextContent('could not be read')
    })

    it('still says nobody voted when the read SUCCEEDED and nobody had', async () => {
      // The discriminating positive control for all three above: "distinguish a failed
      // read" must not become "never say nobody has scored this", which is the honest
      // reading of an empty map that actually arrived.
      mockGetPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).toHaveTextContent('Not scored yet')
      expect(row).not.toHaveTextContent('Team score unavailable')
    })

    it('keeps the team column when the refetch AFTER A SAVE fails', async () => {
      // The failed-read cases above are all FIRST reads, where there is nothing to
      // show. A failed refetch is the other half of `isError`, and it is the half this
      // page creates for itself: saving invalidates `prioritization-scores`, so one
      // unlucky retry used to pay a reviewer for casting a ballot by blanking the whole
      // team column — every row "Team score unavailable", the cards dashed, the score
      // sort stopped — while the previous response sat in the cache, unexpired and
      // still correct.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      // Second call onwards — the post-save refetch — rejects. The first resolves.
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))
      mockGetPrioritizationScores.mockResolvedValueOnce({
        scores: {
          d1: { document_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: 'mine' },
        },
        aggregates: {
          d1: {
            impact: 1, time_to_market: 3, confidence: 4, strategic_fit: 2,
            reviewer_count: 3, score_spread: 1.8,
          },
        },
      })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('2.1')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '1' } })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      await user.click(screen.getByRole('button', { name: /save/i }))

      // The failure is REPORTED — the panel is keyed on the query's own `isError`, and
      // the latest read did fail, so this stays true.
      const panel = await waitFor(() => screen.getByRole('alert', { name: 'Scores could not be loaded' }))
      // But NOT in the first-load wording. Every clause of that sentence is false here,
      // and the last one is dangerous: a reader who obeys "Reload the page before
      // saving" loses the edit this state deliberately lets them save.
      expect(panel).not.toHaveTextContent('are defaults')
      expect(panel).not.toHaveTextContent('Reload the page before saving')
      expect(panel).toHaveTextContent('latest refresh of the saved scores failed')
      expect(panel).toHaveTextContent('last ones read successfully')
      // And the team's answer is still the one on screen, not a retraction of it.
      expect(screen.getByText('2.1')).toBeInTheDocument()
      const row = screen.getByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).not.toHaveTextContent('Team score unavailable')
      expect(row).not.toHaveTextContent('Not scored yet')
      // The cards keep counting the map they are holding rather than dashing it.
      const grid = screen.getByText('Total Documents').closest<HTMLElement>('div.grid')
      expect(within(grid ?? document.body).getByText('Not Scored').previousElementSibling?.textContent).toBe('0')

      // And the save guard follows the same line, which is a BEHAVIOUR change and so
      // asserted rather than left to the rendered column: `saveBlocked` asks "did a map
      // arrive", not "did the query error". The cached response is on screen, sliders
      // included, so this reviewer is editing their own real ballot and may save it.
      // Asserted after a fresh edit because a completed save clears `localEdits`, which
      // disables the button for a different reason.
      fireEvent.change((await screen.findAllByRole('slider'))[1], { target: { value: '2' } })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
    })

    it('still refuses a save on a FIRST-read failure, edit or no edit', async () => {
      // The negative control for the assertion above, and it is not covered by
      // `does not offer to save over scores it could not read`: that one has no pending
      // edit, so the button is disabled by `hasChanges` whatever the guard says. Here a
      // slider has moved, so only the guard can still be holding it — and it must,
      // because with no cached read the sliders are showing DEFAULT_SCORE and saving
      // would write this reviewer's edits over a ballot nobody has seen.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))
      const user = userEvent.setup()

      renderPrioritization()
      // The row first: the scores read fails before the project fan-out settles, so the
      // panel is on screen a tick before there is anything to expand.
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      // The control for the refetch case above: with nothing held, the original wording
      // is accurate and stays — the sliders really are defaults and reloading really is
      // the right move before saving.
      const panel = screen.getByRole('alert', { name: 'Scores could not be loaded' })
      expect(panel).toHaveTextContent('are defaults')
      expect(panel).toHaveTextContent('Reload the page before saving')
      expect(panel).not.toHaveTextContent('last ones read successfully')
      await user.click(screen.getByText('Feature A PR/FAQ'))
      fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '4' } })

      // The edit registered — Reset appears with `hasChanges` — so the disabled Save is
      // the guard's doing and not the absence of anything to save.
      expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    })

    it('refuses the save when the response arrived carrying no ballots at all', async () => {
      // The guard reads the caller's OWN half, not merely "a response arrived". `scores`
      // is passed through the query's `select` untouched — only `aggregates` is validated
      // there — so a response that omits it leaves every slider on DEFAULT_SCORE while a
      // response-level check reads as fine. That is the exact state the guard exists to
      // refuse: saving would write this reviewer's edits over numbers they never saw.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({ aggregates: {} })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '4' } })

      // The edit registered, so only the guard can be holding the button.
      expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    })

    it('refuses the save when the ballots arrive as something other than a map', async () => {
      // The wiring half of the boundary fix. `=== undefined` on the field catches an
      // OMITTED `scores` and nothing else, so a `null` (or a string, or an array) reached
      // the page as "present" while every slider sat on DEFAULT_SCORE. The select now
      // normalizes `scores` the way it already normalized `aggregates`, so anything that
      // is not a readable map answers `undefined` and the guard holds.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({ scores: null, aggregates: {} })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '4' } })

      expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
      // And it SAYS so. The query succeeded, so nothing used to be on screen: a primary
      // action disabled with no explanation, over sliders showing defaults.
      const panel = screen.getByRole('alert', { name: 'Scores could not be loaded' })
      expect(panel).toHaveTextContent('are defaults')
      expect(panel).toHaveTextContent('Reload the page before saving')
    })

    it('never tells a reader no reload is needed while the save is refused', async () => {
      // The two sites used to read different halves of one response: the panel's wording
      // came from the TEAM map and the button from the caller's own ballots. So a response
      // whose `aggregates` were readable and whose `scores` were not — then a failed
      // refetch — put "there is no need to reload before saving" beside a DISABLED Save.
      // Both now ask the same question.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      // First read: team numbers readable, ballots not. Then every refetch fails.
      mockGetPrioritizationScores.mockRejectedValue(new Error('500'))
      mockGetPrioritizationScores.mockResolvedValueOnce({
        scores: 'not a map',
        aggregates: {
          d1: {
            impact: 4, time_to_market: 4, confidence: 4, strategic_fit: 4,
            reviewer_count: 3, score_spread: 0,
          },
        },
      })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      fireEvent.change((await screen.findAllByRole('slider'))[0], { target: { value: '4' } })

      const panel = screen.getByRole('alert', { name: 'Scores could not be loaded' })
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
      expect(panel).not.toHaveTextContent('no need to reload before saving')
      expect(panel).toHaveTextContent('Reload the page before saving')
    })

    it('offers the save when the response carries a ballot but no aggregates at all', async () => {
      // A deployment predating #333. The guard asks about the CALLER'S own half, which
      // did arrive — the sliders hold this reviewer's stored ballot — so the save is
      // honest even though the team column has nothing to show. This is the case where
      // "did the response arrive" and "did a team map arrive" describe different things,
      // and the reason the predicate reads `savedScores` rather than the aggregate.
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: { document_id: 'd1', impact: 5, time_to_market: 4, confidence: 2, strategic_fit: 3, notes: '' },
        },
      })
      const user = userEvent.setup()

      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      // Seeded from the stored ballot, not from defaults — the premise of allowing it.
      expect(sliders[0]).toHaveValue('5')
      fireEvent.change(sliders[0], { target: { value: '1' } })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('a score read still in flight is not an unscored backlog either', () => {
    // The same false claim as a failed read, one state along — and the worse of the two
    // to make, because no error panel is on screen to retract it. `PRFAQList`'s
    // `isLoading` covers only the PROJECT reads, and the scores read scans a whole
    // partition over up to MAX_PRIORITIZATION_PAGES round trips while those are a
    // parallel fan-out, so which settles first is a race rather than an ordering.

    /** Documents resolved, scores still reading — the window under test. */
    function loadDocumentsWithScoresStillReading() {
      mockGetProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      mockGetProject.mockResolvedValue({
        project_id: 'p1',
        documents: [
          { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        ],
      })
      mockGetPrioritizationScores.mockReturnValue(new Promise(() => {}))
    }

    it('does not tell a reader nobody has scored a row it has not read yet', async () => {
      loadDocumentsWithScoresStillReading()

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).not.toHaveTextContent('Not scored yet')
      expect(row).not.toHaveTextContent('Not Scored')
      // Its own words, distinct from the failed read's: this one clears itself, so
      // "reload the page" would be the wrong thing to say.
      expect(row).toHaveTextContent('Loading team score')
      expect(row).not.toHaveTextContent('Team score unavailable')
    })

    it('does not invite a first ballot on a document it has not read the votes for', async () => {
      // The panel carries the claim that can actually cost something: a reader who
      // trusts "the sliders below cast the first ballot" overwrites a real ballot.
      loadDocumentsWithScoresStillReading()
      const user = userEvent.setup()

      renderPrioritization()
      await user.click(await screen.findByText('Feature A PR/FAQ'))

      const panel = (await screen.findByText('What the Team Said')).parentElement
      expect(panel).toBeTruthy()
      expect(panel).not.toHaveTextContent('No reviewer has scored this yet')
      expect(panel).not.toHaveTextContent('cast the first ballot')
      expect(panel).toHaveTextContent('still loading')
    })

    it('does not count a read in flight as an unscored backlog in the stats cards', async () => {
      loadDocumentsWithScoresStillReading()

      renderPrioritization()
      await screen.findByText('Feature A PR/FAQ')

      const grid = screen.getByText('Total Documents').closest<HTMLElement>('div.grid')
      const cardValue = (label: string) => within(grid ?? document.body)
        .getByText(label).previousElementSibling?.textContent

      // The project read succeeded, so the total is a number; nothing else is known.
      expect(cardValue('Total Documents')).toBe('1')
      // And the hidden reason names THIS state, not the failed one — the two dashes
      // look identical and mean different things, so the text a screen reader gets is
      // the only place the difference survives.
      for (const label of ['Not Scored', 'High Priority', 'Medium Priority']) {
        expect(cardValue(label), label).toBe('—Loading team score')
      }
    })

    it('does not offer to save against a ballot it has not read', async () => {
      // The sliders show display defaults in this window, not this reviewer's stored
      // ballot — the same reason the save is blocked when the read has failed.
      loadDocumentsWithScoresStillReading()
      const user = userEvent.setup()

      renderPrioritization()
      await user.click(await screen.findByText('Feature A PR/FAQ'))
      const sliders = await screen.findAllByRole('slider')
      fireEvent.change(sliders[0], { target: { value: '5' } })

      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
      expect(mockPatchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('says nobody voted once the read LANDS on an empty map', async () => {
      // The discriminating positive control: "do not claim it is unscored while
      // loading" must not become "never claim it is unscored". The same fixture, with
      // the promise allowed to resolve.
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
      await waitFor(() => {
        expect(row).toHaveTextContent('Not scored yet')
      })
      expect(row).not.toHaveTextContent('Loading team score')
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

    /**
     * Put an over-long note into a pending edit, the only way one can get there.
     *
     * `maxLength` caps typing, so this arrives as a value the page did not type —
     * which is how the pre-ballot data reaches it in production. Set on the NOTE
     * rather than by moving a slider on a row whose stored note ran long: an edit now
     * carries only the fields the reader set, so a slider-only edit sends no note at
     * all and the API has nothing to refuse. That is the point of the partial body —
     * an untouched note is left alone rather than rewritten — and it narrows this
     * guard to the case that can still reach the API: a reader editing the note.
     */
    async function editARowWhoseNoteIsTooLong() {
      mockGetPrioritizationScores.mockResolvedValue({
        scores: {
          d1: {
            document_id: 'd1', impact: 3, time_to_market: 3, confidence: 3,
            strategic_fit: 3, notes: 'within the bound',
          },
        },
      })
      const user = userEvent.setup()
      renderPrioritization()
      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const notes = await screen.findByPlaceholderText(/add notes/i)
      fireEvent.change(notes, { target: { value: overLong } })
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

    it('lets a slider move on a row whose STORED note ran long, sending no note', async () => {
      // Previously this was blocked, because moving a slider re-sent the whole stored
      // ballot including a note the reviewer had not touched and the API would refuse.
      // A partial edit carries only the axis that moved, so the save is both legal and
      // honest: the over-long note stays exactly as stored, untouched by this write.
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

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
      })
      expect(screen.queryByRole('alert', { name: 'A note is too long to save' }))
        .not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /save/i }))

      expect(mockPatchPrioritizationScores).toHaveBeenCalledWith({
        d1: { document_id: 'd1', impact: 5 },
      })
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
