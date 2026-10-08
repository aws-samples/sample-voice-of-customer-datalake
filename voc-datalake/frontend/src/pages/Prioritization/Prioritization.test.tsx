/**
 * @fileoverview Tests for Prioritization page — rendering, list, sorting and saving
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './prioritization-mock-fixtures'
import enCommon from '../../../public/locales/en/common.json'
import {
  prioritizationMocks, mockProjects, oneRowPerDocument, installLayout, R, DEFAULT_ROWS,
  TWO_ROW_DOCUMENTS, installSingleRow, unanimousAggregate, unanimousBallot,
  resetPrioritizationPage,
} from './prioritization-fixtures'
import {
  renderPrioritization, renderUntilRow, openRow, saveButton,
} from './prioritization-render-fixtures'
import { required } from '../../components/component-spec-fixtures'

describe('Prioritization', () => {
  beforeEach(() => {
    resetPrioritizationPage()
  })

  describe('regression: saved scores stay in sync with the server (#95)', () => {
    it('displays refetched scores instead of the first snapshot', async () => {
      // First fetch: nobody has scored d1. Later refetch: the team scored it
      // 5/5/5/5, composite 5.0. The assertion reads the ROW's headline, which is
      // now the team's aggregate — the caller's own refetched ballot is covered by
      // the sibling case below, through the sliders it now lives behind.
      prioritizationMocks.getPrioritizationScores
        .mockResolvedValueOnce({
          rows: DEFAULT_ROWS,
          scores: {},
          aggregates: {},
        })
        .mockResolvedValue({
          rows: DEFAULT_ROWS,
          scores: {},
          aggregates: {
            [R.d1]: unanimousAggregate(5, 3),
          },
        })

      const queryClient = await renderUntilRow()

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
      prioritizationMocks.getPrioritizationScores
        .mockResolvedValueOnce({
          rows: DEFAULT_ROWS,
          scores: {
            [R.d1]: unanimousBallot(R.d1, 1),
          },
        })
        .mockResolvedValue({
          rows: DEFAULT_ROWS,
          scores: {
            [R.d1]: { row_id: R.d1, impact: 4, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '' },
          },
        })
      const queryClient = await renderUntilRow()
      const user = userEvent.setup()
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const impact = (await screen.findAllByRole('slider'))[0]
      expect(impact).toHaveValue('1')

      await queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })

      await waitFor(() => {
        expect(impact).toHaveValue('4')
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
        expect(screen.getByText('Total Proposals')).toBeInTheDocument()
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
      prioritizationMocks.getProjects.mockReturnValue(new Promise(() => {})) // Never resolves

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Loading documents...')).toBeInTheDocument()
      })
    })
  })

  describe('load failed vs empty', () => {
    it('a failed projects read says so instead of "No Documents Found"', async () => {
      prioritizationMocks.getProjects.mockRejectedValue(new Error('Failed to fetch'))

      renderPrioritization()

      expect(await screen.findByText(enCommon.loadFailed.message)).toBeInTheDocument()
      expect(screen.queryByText('No Documents Found')).not.toBeInTheDocument()
    })

    it('Try again refetches the projects and the empty state is then the truth', async () => {
      prioritizationMocks.getProjects.mockRejectedValueOnce(new Error('API Error: 500'))
      prioritizationMocks.getProjects.mockResolvedValue({ projects: [] })
      const user = userEvent.setup()
      renderPrioritization()

      await user.click(await screen.findByRole('button', { name: enCommon.loadFailed.retry }))

      expect(await screen.findByText('No Documents Found')).toBeInTheDocument()
      expect(screen.queryByText(enCommon.loadFailed.message)).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows generic empty state when no projects exist', async () => {
      prioritizationMocks.getProjects.mockResolvedValue({ projects: [] })

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('No Documents Found')).toBeInTheDocument()
      })
    })

    it('shows wrong-type empty state when projects have only non-scorable documents', async () => {
      prioritizationMocks.getProjects.mockResolvedValue({ projects: [mockProjects[0]] })
      prioritizationMocks.getProject.mockResolvedValue({
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

  describe('the heading says how long the list is', () => {
    // A reader cannot tell from the heading alone whether everything loaded, so the
    // count goes beside it. The number is the LIST's own length rather than a second
    // count computed from the documents, which is what keeps the badge and the rows
    // beneath it from disagreeing.

    /**
     * The count badge, or null when the heading is showing none.
     *
     * By testid, which is the only handle that holds for the ABSENCE cases in both of
     * the directions they can rot. Querying for the text "0 proposals" rules out one
     * spelling of the claim, so a later `rowCount_zero` form would pass unnoticed;
     * reading the heading wrapper's whole text is spelling-proof but goes vacuous the
     * moment anything is nested around the h1, which is a test that fails open.
     */
    const rowCountBadge = () => screen.queryByTestId('prioritization-row-count')

    it('counts the rows beside the heading', async () => {
      // Two projects in the shared fixture, so TWO rows — p1's PRD and PR/FAQ are one
      // row, which is why this is not "three documents".
      renderPrioritization()

      // Read off the BADGE, not merely found somewhere on the page. The two cases below
      // assert this node is absent, and if nothing ever asserts it is present, deleting
      // the testid leaves those two passing for the wrong reason and the zero-gate
      // unguarded. Keeping the string in the assertion still proves the plural resolved
      // through the real locale JSON rather than falling back to the key.
      expect((await screen.findByTestId('prioritization-row-count')).textContent)
        .toBe('2 proposals')
      // Beside the h1, not inside it: this heading has to keep reading as the page's
      // name to a screen reader and the document outline, and it is what the breadcrumb
      // names.
      //
      // `level: 1` is unambiguous HERE ONLY because this suite renders the page without
      // the app shell. The DEPLOYED page has two level-1 headings — Layout renders the
      // brand as one — so this query would be ambiguous in a test that mounted Layout,
      // and no assertion in this file can speak for the page's overall heading
      // structure. Verified in a browser, not here.
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Prioritization$/)
    })

    it('agrees with the Total Proposals card', async () => {
      // The badge counts `sortedRows` and the card counts `allRows`, so they agree only
      // while the sort preserves length — which nothing else on the page asserts. They
      // are two statements of the same quantity in the same viewport, and a reader who
      // finds them disagreeing has reason to trust neither.
      renderPrioritization()

      expect(await screen.findByText('2 proposals')).toBeInTheDocument()
      // `toBe` on the text, not `toHaveTextContent`: that matcher is a SUBSTRING test
      // for a string argument, so a card reading "12" or "20" would satisfy the very
      // assertion this case exists to make.
      expect(screen.getByText('Total Proposals').previousElementSibling?.textContent)
        .toBe('2')
    })

    it('uses the singular form for a list of one', async () => {
      // Not cosmetic. A count-only key needs both `rowCount_one` and `rowCount_other`
      // under i18next's JSON v4 plurals, and a missing form renders the raw key path —
      // the failure this page's own comments warn about elsewhere. Tests run the real
      // locale JSON through the real i18next, so this case is what proves the forms
      // resolve rather than that they merely exist in the file.
      installSingleRow()

      renderPrioritization()

      // No companion "the raw key is absent" assertion: finding `1 proposal` already
      // proves the `_one` form resolved, and a missing form renders the key path
      // INSTEAD of the text, so the two can never disagree.
      expect(await screen.findByText('1 proposal')).toBeInTheDocument()
    })

    it('says nothing while the list is still loading', async () => {
      // The badge must not appear over the spinner: a count is a claim about a list,
      // and there is no list yet.
      prioritizationMocks.getProjects.mockReturnValue(new Promise(() => {})) // Never resolves

      renderPrioritization()

      expect(await screen.findByText('Loading documents...')).toBeInTheDocument()
      expect(rowCountBadge()).toBeNull()
    })

    // EVERY empty branch, because the count is withheld for a reason that names them:
    // the list says which emptiness this is, and a bare zero cannot. The badge takes one
    // path through all three, so this is one case run three times — and `projects` is
    // its own column rather than inferred from `documents`, which is what lets the middle
    // case have a project at all instead of collapsing into "no projects".
    it.each([
      { emptiness: 'no projects at all', title: 'No Documents Found', projects: [], documents: [] },
      // Named for the state it actually reaches: the shared fixture's rows still name
      // `d1`/`d2`, which this project no longer has, so `collectRows` drops every row.
      // The one case where a detail IS loaded and holds no documents at all.
      { emptiness: 'a project whose documents are gone', title: 'No Documents Found', projects: [mockProjects[0]], documents: [] },
      {
        emptiness: 'only non-scorable documents', title: 'No Scorable Documents', projects: [mockProjects[0]],
        documents: [{ document_id: 'r1', document_type: 'research', title: 'Research Only', content: '', created_at: '2025-01-01' }],
      },
    ])('shows no count over the empty state for $emptiness', async ({ title, projects, documents }) => {
      prioritizationMocks.getProjects.mockResolvedValue({ projects })
      prioritizationMocks.getProject.mockResolvedValue({ project_id: 'p1', documents })

      renderPrioritization()

      expect(await screen.findByText(title)).toBeInTheDocument()
      expect(rowCountBadge()).toBeNull()
    })

    it('counts the rows still on screen when the score read fails', async () => {
      // The count follows the LIST, and the list deliberately survives a failed scores
      // read on the rows the ensure confirmed (see the sibling suite). Withholding the
      // badge on that failure would leave the heading silent above rows the reader can
      // see and count by hand — and the count is not one of the numbers that read
      // failed, so it has nothing to retract.
      installLayout(oneRowPerDocument(TWO_ROW_DOCUMENTS))
      prioritizationMocks.getPrioritizationScores.mockRejectedValue(new Error('API Error: 500'))

      renderPrioritization()

      expect(await screen.findByText('2 proposals')).toBeInTheDocument()
      // And the failure is still reported. Counting the rows is not claiming the read
      // worked.
      expect(screen.getByRole('alert', { name: 'Scores could not be loaded' })).toBeInTheDocument()
    })
  })

  describe('PR/FAQ list', () => {
    /** A PR/FAQ row and a PRD row, one project each, nobody's scores on either. */
    function loadPrfaqAndPrdRows() {
      installLayout(oneRowPerDocument([
        { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'prd', title: 'Feature A PRD', content: '', created_at: '2025-01-02' },
      ]))
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {} })
    }

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
      loadPrfaqAndPrdRows()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
        expect(screen.getByText('Feature A PRD')).toBeInTheDocument()
      })
    })

    it('shows document type badge for each row', async () => {
      loadPrfaqAndPrdRows()

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
      await openRow()

      await waitFor(() => {
        expect(screen.getByText('Prioritization Scores')).toBeInTheDocument()
        expect(screen.getByText('Document Preview')).toBeInTheDocument()
      })
    })
  })

  describe('sorting', () => {
    it('changes sort when clicking sort button', async () => {
      const user = userEvent.setup()
      await renderUntilRow()

      // Click on Impact sort button (multiple matches due to mobile/desktop spans)
      const impactButton = required(
        screen.getAllByRole('button', { name: /impact/i }).at(0), 'the Impact sort button',
      )
      await user.click(impactButton)

      // Button should be highlighted
      expect(impactButton).toHaveClass('tab-active')
    })
  })

  describe('regression: missing scores do not crash', () => {
    /**
     * Regression test for: TypeError: Cannot read properties of undefined (reading 'impact')
     * When the API returns no saved scores, StatsCards must not crash accessing scores[id].impact.
     */
    it('renders stats cards when scores API returns empty object', async () => {
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {} })

      await renderUntilRow()

      // StatsCards should render without crashing
      expect(screen.getByText('Total Proposals')).toBeInTheDocument()
      // And with every named row readable (there are none), no line under the cards
      // claims otherwise — the unreadable-count sentence is for a gap that exists.
      // The phrase is the stats line's own, not `team.unavailableDescription`'s, so
      // this cannot pass or fail on a row label.
      expect(screen.queryByText(/counted in the total but in none/)).toBeNull()
    })

    it('renders stats cards when scores API returns no scores key', async () => {
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({})

      await renderUntilRow()

      expect(screen.getByText('Total Proposals')).toBeInTheDocument()
    })
  })

  describe('save functionality', () => {
    it('save button is disabled when no changes', async () => {
      await renderUntilRow()

      expect(saveButton()).toBeDisabled()
    })
  })
})
