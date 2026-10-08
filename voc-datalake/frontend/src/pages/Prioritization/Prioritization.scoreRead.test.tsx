/**
 * @fileoverview Tests for Prioritization page — score reads that fail, are in flight, or would be refused
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MAX_NOTE_LENGTH } from './prioritizationUtils'
import './prioritization-mock-fixtures'
import {
  prioritizationMocks, oneRowPerDocument, installLayout, R, DEFAULT_ROWS, TWO_ROW_DOCUMENTS,
  installSingleRow, loadSingleRow, unanimousAggregate, unanimousBallot, loadRowsWithTeamAggregates,
  ROW_ID, resetPrioritizationPage, givenTheScoresReadFails, disagreeingRead,
} from './prioritization-fixtures'
import {
  renderPrioritization, renderUntilRow, renderUntilRowButton, openRow, openRowSliders, saveButton,
  expectSaveEnabled, moveSlider, moveSliderAndSave, statsGrid, cardValue,
  expectRowNotPresentedAsUnscored, expectTeamPanelOpened, expectEditHeldByTheGuard,
  expectScoresPanelSaysDefaults,
} from './prioritization-render-fixtures'

describe('Prioritization', () => {
  beforeEach(() => {
    resetPrioritizationPage()
  })

  describe('the rows a project has do not depend on the score read succeeding', () => {
    // A row is the page's CONTENT, not a number on it, and rows arrive on the same
    // response as the scores. Read from that one query alone, a 500 on the scores took
    // the whole backlog with it — "Create a PRD or PR/FAQ to start prioritizing" over
    // projects full of them — which is the same conflation the rest of this page exists
    // to refuse, one level up: a failed read presented as an absence of data.
    //
    // What closes it is the row-ensure's own answer. The create route is idempotent and
    // returns the STORED row either way, so every ask that lands is the server vouching
    // for that row, and the page keeps it.

    it('still lists the rows the ensure confirmed when the score read fails', async () => {
      installSingleRow()
      prioritizationMocks.getPrioritizationScores.mockRejectedValue(new Error('API Error: 500'))

      renderPrioritization()

      // The row is on screen, named, and expandable.
      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      // And it says what is actually unknown — the TEAM's numbers — rather than
      // presenting the project as having nothing to score.
      expect(row).toHaveTextContent('Team score unavailable')
      expect(screen.queryByText('Create a PRD or PR/FAQ in your projects to start prioritizing.')).toBeNull()
      // The failure is still reported. Keeping the rows is not the same as pretending
      // the read worked.
      expect(screen.getByRole('alert', { name: 'Scores could not be loaded' })).toBeInTheDocument()
    })

    it('leaves the empty state alone when there is nothing to confirm', async () => {
      // The discriminating control: the fallback must not manufacture a row. With no
      // project needing one, no ask is made, nothing is confirmed, and a failed read
      // leaves the page saying what is true — there is nothing here to score.
      prioritizationMocks.getProjects.mockResolvedValue({ projects: [] })
      prioritizationMocks.getProject.mockResolvedValue({ documents: [] })
      prioritizationMocks.getPrioritizationScores.mockRejectedValue(new Error('API Error: 500'))

      renderPrioritization()

      expect(await screen.findByText('Create a PRD or PR/FAQ in your projects to start prioritizing.'))
        .toBeInTheDocument()
      expect(prioritizationMocks.createPrioritizationRow).not.toHaveBeenCalled()
    })

    it('asks again after a transient failure, and not after a refusal', async () => {
      // Two rules in one case because they are one decision. A rejected ask is released
      // so a later pass retries it — marked-and-never-cleared hid that project for the
      // whole mount — but a 4xx is the server's settled answer, and releasing that
      // re-asks on every project refetch and never gets a different reply.
      installLayout(oneRowPerDocument(TWO_ROW_DOCUMENTS))
      prioritizationMocks.createPrioritizationRow.mockImplementation((projectId: string) => Promise.reject(
        new Error(projectId === 'p1' ? 'API Error: 500' : 'API Error: 400'),
      ))

      const queryClient = renderPrioritization()
      await waitFor(() => {
        expect(prioritizationMocks.createPrioritizationRow).toHaveBeenCalledTimes(2)
      })

      // A project refetch, as the hourly prototype re-sign performs, drives the effect
      // again with a project list that has moved on — which is when the released ids get
      // their second chance.
      const third = installLayout(oneRowPerDocument([
        { document_id: 'd1', document_type: 'prfaq', title: 'Feature A PR/FAQ', content: '', created_at: '2025-01-01' },
        { document_id: 'd3', document_type: 'prfaq', title: 'Feature B PR/FAQ', content: '', created_at: '2025-01-02' },
        { document_id: 'd4', document_type: 'prfaq', title: 'Feature C PR/FAQ', content: '', created_at: '2025-01-03' },
      ]))
      expect(third.projects).toHaveLength(3)
      prioritizationMocks.createPrioritizationRow.mockImplementation((projectId: string) => Promise.reject(
        new Error(projectId === 'p1' ? 'API Error: 500' : 'API Error: 400'),
      ))
      await queryClient.invalidateQueries()

      // p1's transient 500 is asked again.
      await waitFor(() => {
        expect(prioritizationMocks.createPrioritizationRow.mock.calls.filter((call) => call[0] === 'p1').length)
          .toBeGreaterThan(1)
      })
      // p2's 400 is NOT. The server has answered about that project, and asking again
      // would spend a request per project refetch for the rest of the mount. p3 is new to
      // this pass and asked for the FIRST time — asserted, not merely described, because
      // it is what proves the second pass actually reached the effect rather than p1's
      // retry coming from something else. A never-marked id must always be asked,
      // whatever the release rule does with the ones that failed. One structured
      // assertion, so p2 is still at one ask at the moment p3 has had its first.
      const asksFor = (projectId: string) => prioritizationMocks.createPrioritizationRow.mock.calls
        .filter((call) => call[0] === projectId).length
      await waitFor(() => {
        expect({ p2: asksFor('p2'), p3: asksFor('p3') }).toStrictEqual({ p2: 1, p3: 1 })
      })
    })
  })

  describe('a failed score read is not an unscored backlog', () => {
    // The endpoint raises on a failed read rather than answering an empty map,
    // precisely so "the read failed" and "nobody has scored anything" stop
    // looking identical. Reading only `data` would undo that on screen: every row
    // falls back to DEFAULT_SCORE and the page looks merely unscored.

    it('shows an error rather than presenting defaults as saved scores', async () => {
      givenTheScoresReadFails()

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
      givenTheScoresReadFails()

      renderPrioritization()

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
      expect(saveButton()).toBeDisabled()
    })

    it('shows no error when the backlog is genuinely unscored', async () => {
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {} })

      await renderUntilRow()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('does not tell a reader nobody has scored a row it could not read', async () => {
      // The row copy is the strongest claim on the page — "No reviewer has scored this
      // yet… The sliders below cast the first ballot" — and it was made about every row
      // whenever the read failed, because `aggregates` fell back to `{}` and absence
      // from that map is how this page says "nobody voted". Inviting a reviewer to cast
      // the first ballot on a document the team may already have scored is how a real
      // ballot gets overwritten by a reader who trusted the row.
      givenTheScoresReadFails()

      const row = await renderUntilRowButton()
      expectRowNotPresentedAsUnscored(row)
      // What it says instead names the READ, not the document.
      expect(row).toHaveTextContent('Team score unavailable')
    })

    it('does not count a failed read as an unscored backlog in the stats cards', async () => {
      // "1 Not Scored" over a one-document backlog is a claim about the document, and a
      // read that never arrived cannot support it. A dash says the count is unknown;
      // "Total Proposals" is still a number because the PROJECT read succeeded.
      installSingleRow()
      givenTheScoresReadFails()

      await renderUntilRow()

      // Scoped to the stats grid: these labels are also the rows' own band labels.

      expect(cardValue('Total Proposals')).toBe('1')
      // The dash, plus the reason for it in text only a screen reader reads: the em
      // dash alone is announced as nothing or "em dash", which is indistinguishable
      // from a zero count — the very confusion the dash is there to avoid.
      for (const label of ['Not Scored', 'High Priority', 'Medium Priority']) {
        expect(cardValue(label), label).toBe('—Team score unavailable')
      }
      const dashes = within(statsGrid() ?? document.body).getAllByText('—')
      expect(dashes).toHaveLength(3)
      for (const dash of dashes) expect(dash).toHaveAttribute('aria-hidden', 'true')
    })

    it('says the team view could not be read inside the expanded row too', async () => {
      // The panel is where the wording invites the first ballot, so it needs the same
      // three-way distinction the collapsed row now makes.
      givenTheScoresReadFails()

      const panel = await expectTeamPanelOpened()
      expect(panel).not.toHaveTextContent('No reviewer has scored this yet')
      expect(panel).toHaveTextContent('could not be read')
    })

    it('still says nobody voted when the read SUCCEEDED and nobody had', async () => {
      // The discriminating positive control for all three above: "distinguish a failed
      // read" must not become "never say nobody has scored this", which is the honest
      // reading of an empty map that actually arrived.
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })

      const row = await renderUntilRowButton()
      expect(row).toHaveTextContent('Not scored yet')
      expect(row).not.toHaveTextContent('Team score unavailable')
    })

    // Three claims about one screen, asserted as three cases over `saveThenRefetchFails`.
    async function saveThenRefetchFails() {
      // The failed-read cases above are all FIRST reads, where there is nothing to
      // show. A failed refetch is the other half of `isError`, and it is the half this
      // page creates for itself: saving invalidates `prioritization-scores`, so one
      // unlucky retry used to pay a reviewer for casting a ballot by blanking the whole
      // team column — every row "Team score unavailable", the cards dashed, the score
      // sort stopped — while the previous response sat in the cache, unexpired and
      // still correct.
      installSingleRow()
      // Second call onwards — the post-save refetch — rejects. The first resolves.
      givenTheScoresReadFails()
      prioritizationMocks.getPrioritizationScores.mockResolvedValueOnce(disagreeingRead())
      const user = userEvent.setup()

      renderPrioritization()
      await screen.findByText('2.1')
      await user.click(screen.getByText('Feature A PR/FAQ'))
      const slider = (await screen.findAllByRole('slider')).at(0)
      if (slider === undefined) throw new Error('fixture: the open row has no slider')
      await moveSliderAndSave(user, slider, '1')
      // The failure is REPORTED — the panel is keyed on the query's own `isError`, and
      // the latest read did fail, so this stays true.
      return waitFor(() => screen.getByRole('alert', { name: 'Scores could not be loaded' }))
    }

    it('reports a failed refetch AFTER A SAVE in its own wording, not the first-load one', async () => {
      const panel = await saveThenRefetchFails()

      // NOT the first-load wording. Every clause of that sentence is false here,
      // and the last one is dangerous: a reader who obeys "Reload the page before
      // saving" loses the edit this state deliberately lets them save.
      expect(panel).not.toHaveTextContent('are defaults')
      expect(panel).not.toHaveTextContent('Reload the page before saving')
      expect(panel).toHaveTextContent('latest refresh of the saved scores failed')
      expect(panel).toHaveTextContent('last ones read successfully')
    })

    it('keeps the team column when the refetch AFTER A SAVE fails', async () => {
      await saveThenRefetchFails()

      // The team's answer is still the one on screen, not a retraction of it.
      expect(screen.getByText('2.1')).toBeInTheDocument()
      const row = screen.getByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).not.toHaveTextContent('Team score unavailable')
      expect(row).not.toHaveTextContent('Not scored yet')
      // The cards keep counting the map they are holding rather than dashing it.
      expect(cardValue('Not Scored')).toBe('0')
    })

    it('lets the reviewer save a fresh edit after the refetch AFTER A SAVE fails', async () => {
      await saveThenRefetchFails()

      // The save guard follows the same line, which is a BEHAVIOUR change and so
      // asserted rather than left to the rendered column: `saveBlocked` asks "did a map
      // arrive", not "did the query error". The cached response is on screen, sliders
      // included, so this reviewer is editing their own real ballot and may save it.
      // Asserted after a fresh edit because a completed save clears `localEdits`, which
      // disables the button for a different reason.
      await moveSlider(1, '2')
      await expectSaveEnabled()
    })

    it('still refuses a save on a FIRST-read failure, edit or no edit', async () => {
      // The negative control for the assertion above, and it is not covered by
      // `does not offer to save over scores it could not read`: that one has no pending
      // edit, so the button is disabled by `hasChanges` whatever the guard says. Here a
      // slider has moved, so only the guard can still be holding it — and it must,
      // because with no cached read the sliders are showing DEFAULT_SCORE and saving
      // would write this reviewer's edits over a ballot nobody has seen.
      installSingleRow()
      givenTheScoresReadFails()
      const user = userEvent.setup()

      await renderUntilRow()
      // The row first: the scores read fails before the project fan-out settles, so the
      // panel is on screen a tick before there is anything to expand.
      // The control for the refetch case above: with nothing held, the original wording
      // is accurate and stays — the sliders really are defaults and reloading really is
      // the right move before saving.
      const panel = expectScoresPanelSaysDefaults()
      expect(panel).not.toHaveTextContent('last ones read successfully')
      await user.click(screen.getByText('Feature A PR/FAQ'))

      await expectEditHeldByTheGuard()
    })

    it('refuses the save when the response arrived carrying no ballots at all', async () => {
      // The guard reads the caller's OWN half, not merely "a response arrived". `scores`
      // is passed through the query's `select` untouched — only `aggregates` is validated
      // there — so a response that omits it leaves every slider on DEFAULT_SCORE while a
      // response-level check reads as fine. That is the exact state the guard exists to
      // refuse: saving would write this reviewer's edits over numbers they never saw.
      loadSingleRow({ aggregates: {} })
      await openRow()

      // The edit registered, so only the guard can be holding the button.
      await expectEditHeldByTheGuard()
    })

    it('refuses the save when the ballots arrive as something other than a map', async () => {
      // The wiring half of the boundary fix. `=== undefined` on the field catches an
      // OMITTED `scores` and nothing else, so a `null` (or a string, or an array) reached
      // the page as "present" while every slider sat on DEFAULT_SCORE. The select now
      // normalizes `scores` the way it already normalized `aggregates`, so anything that
      // is not a readable map answers `undefined` and the guard holds.
      loadSingleRow({ scores: null, aggregates: {} })
      await openRow()

      await expectEditHeldByTheGuard()
      // And it SAYS so. The query succeeded, so nothing used to be on screen: a primary
      // action disabled with no explanation, over sliders showing defaults.
      expectScoresPanelSaysDefaults()
    })

    it('does not present a document whose OWN team row was unreadable as unscored', async () => {
      // The discontinuity this closes: a single unreadable row used to be dropped, so that
      // document rendered "Not scored yet" — a scored document presented as unscored, which
      // is the one claim this page exists to prevent — while the SAME row alone made the
      // whole page "unavailable". Per-row marking removes the dependency on its neighbours.
      loadRowsWithTeamAggregates(TWO_ROW_DOCUMENTS, {
        // Readable, and its sibling is not.
        d1: unanimousAggregate(4, 3),
        // Keyed by the ROW holding d3, like its readable sibling: an entry naming a
        // document names no row, so the page would read it as absent — "nobody
        // voted" — and the case would pass for the wrong reason.
        d3: { reviewer_count: 0 },
      })

      renderPrioritization()

      const bad = await screen.findByRole('button', { name: /Feature B PR\/FAQ/ })
      expect(bad).toHaveTextContent('Team score unavailable')
      expect(bad).not.toHaveTextContent('Not scored yet')
      // The readable sibling is unaffected — one bad row is not a page-wide failure.
      const good = screen.getByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(good).toHaveTextContent('4.0')
      // And the page still counts what it can: the cards are numbers, not dashes.
      expect(cardValue('High Priority')).toBe('1')
    })

    it('explains, beside the cards, the row that counts in the total and nowhere else', async () => {
      // The per-row consequence of per-row marking: a marked row has no number (not
      // high, medium or low) and calling it "Not Scored" is the conflation the row
      // label refuses — so it is in "Total Proposals" and in no other card, and the
      // counts stop adding up. That gap must not be silent: the total says 2, the
      // other cards account for 1, and the line under the grid is what says why.
      loadRowsWithTeamAggregates(TWO_ROW_DOCUMENTS, { d1: unanimousAggregate(4, 3), d3: 'junk' })

      renderPrioritization()

      expect(await screen.findByText(/The team score for 1 proposal could not be read/))
        .toBeInTheDocument()
      // Not folded into "Not Scored" instead: that card stays 0, because the marked
      // row is not a document nobody voted on.
      expect(cardValue('Not Scored')).toBe('0')
      // And with a readable row in the map, the score sorts still order — the hint
      // stays up for the ordering that IS happening.
      expect(screen.getByText(/order by the team's numbers/)).toBeInTheDocument()
    })

    it('treats a response whose EVERY named row is unreadable as the failure it is', async () => {
      // The state that stopped reaching 'unavailable' when the container-wide rule
      // became per-row marking: a response ARRIVED, named documents, and not one row
      // carries a number. It says exactly as little about the backlog as an unreadable
      // container, so the row-aggregating surfaces treat it identically — counting it
      // printed `0 / 0 / 0`, three confident claims about documents no read has
      // described, and left the sort hint attributing an ordering that was not
      // happening. (An EMPTY map still counts and keeps the hint: nobody voting is an
      // answer that fixes itself with the first ballot, not a failure.)
      loadSingleRow({
        rows: DEFAULT_ROWS,
        scores: {},
        // Named by ROW, so the map genuinely NAMES the row on screen and can then fail
        // to describe it — which is the state under test. Keyed by document id the entry
        // names no row at all, so the map reads as empty, and an empty map counts and
        // keeps the sort hint: the opposite of every assertion below.
        aggregates: { [R.d1]: { reviewer_count: 0 } },
      })

      renderPrioritization()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).toHaveTextContent('Team score unavailable')
      // The hint is withdrawn: no button can order by numbers that do not exist.
      expect(screen.queryByText(/order by the team's numbers/)).toBeNull()
      // The cards DASH with the read-state sentence, exactly as for an unreadable
      // container — same fault, same dashes — rather than printing confident zeros.
      expect(cardValue('High Priority')).toBe('—Team score unavailable')
      // And no gap line: there are no numbers on screen for a gap to exist in.
      expect(screen.queryByText(/counted in the total but in none/)).toBeNull()
    })

    /** A response whose ballots were fine and whose team half was garbage. */
    function renderWithUnreadableTeamHalf() {
      loadSingleRow({
        rows: DEFAULT_ROWS,
        scores: { [R.d1]: unanimousBallot(R.d1, 5) },
        aggregates: 'boom',
      })

      renderPrioritization()
    }

    it('does not tell a reader nobody voted when the TEAM half was unreadable', async () => {
      // The mirror of the ballots fix, and the same false claim: an unreadable `aggregates`
      // container used to normalize to an empty map, and an empty map is this page's
      // assertion that nobody has voted on any document. So a response whose ballots were
      // fine and whose team half was garbage showed every row "Not scored yet", counted the
      // whole backlog as unscored, and raised no alert at all.
      renderWithUnreadableTeamHalf()

      const row = await screen.findByRole('button', { name: /Feature A PR\/FAQ/ })
      expect(row).toHaveTextContent('Team score unavailable')
      expect(row).not.toHaveTextContent('Not scored yet')
      // And the sort hint is withdrawn: those three buttons cannot order anything without
      // a team map, so a permanently-visible line attributing the order to the team's
      // numbers would describe an effect the reader can click for and not get.
      expect(screen.queryByText(/order by the team's numbers/)).toBeNull()
      // The cards say "unknown", not "all of them are unscored".
      expect(cardValue('Not Scored')).toBe('—Team score unavailable')
    })

    it('leaves the caller\'s own ballot untouched when the TEAM half was unreadable', async () => {
      renderWithUnreadableTeamHalf()
      // Waited on the read-state sentence, so the scores read has settled before the
      // save button and the alert are read.
      await screen.findAllByText(/Team score unavailable/)

      // The caller's own ballot is untouched by the team half being unreadable: their
      // sliders and their save still work.
      expect(saveButton()).toBeDisabled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('never tells a reader no reload is needed while the save is refused', async () => {
      // The two sites used to read different halves of one response: the panel's wording
      // came from the TEAM map and the button from the caller's own ballots, so a response
      // whose `aggregates` were readable and whose `scores` were not put "there is no need
      // to reload before saving" beside a DISABLED Save. Both now ask the same question.
      // (No refetch is needed to reach it — under the fix the panel no longer waits for the
      // query to error, which is the second half of that finding.)
      installSingleRow()
      // First read: team numbers readable, ballots not. Then every refetch fails.
      givenTheScoresReadFails()
      prioritizationMocks.getPrioritizationScores.mockResolvedValueOnce({
        rows: DEFAULT_ROWS,
        scores: 'not a map',
        aggregates: {
          [R.d1]: unanimousAggregate(4, 3),
        },
      })
      await openRow()
      await moveSlider(0, '4')

      const panel = screen.getByRole('alert', { name: 'Scores could not be loaded' })
      expect(saveButton()).toBeDisabled()
      expect(panel).not.toHaveTextContent('no need to reload before saving')
      expect(panel).toHaveTextContent('Reload the page before saving')
    })

    it('offers the save when the response carries a ballot but no aggregates at all', async () => {
      // A deployment predating #333. The guard asks about the CALLER'S own half, which
      // did arrive — the sliders hold this reviewer's stored ballot — so the save is
      // honest even though the team column has nothing to show. This is the case where
      // "did the response arrive" and "did a team map arrive" describe different things,
      // and the reason the predicate reads `savedScores` rather than the aggregate.
      loadSingleRow({
        rows: DEFAULT_ROWS,
        scores: {
          [R.d1]: { row_id: R.d1, impact: 5, time_to_market: 4, confidence: 2, strategic_fit: 3, notes: '' },
        },
      })
      const { impact } = await openRowSliders()
      // Seeded from the stored ballot, not from defaults — the premise of allowing it.
      expect(impact).toHaveValue('5')
      fireEvent.change(impact, { target: { value: '1' } })

      await expectSaveEnabled()
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
      installSingleRow()
      prioritizationMocks.getPrioritizationScores.mockReturnValue(new Promise(() => {}))
    }

    it('does not tell a reader nobody has scored a row it has not read yet', async () => {
      loadDocumentsWithScoresStillReading()

      const row = await renderUntilRowButton()
      expectRowNotPresentedAsUnscored(row)
      // Its own words, distinct from the failed read's: this one clears itself, so
      // "reload the page" would be the wrong thing to say.
      expect(row).toHaveTextContent('Loading team score')
      expect(row).not.toHaveTextContent('Team score unavailable')
    })

    it('does not invite a first ballot on a document it has not read the votes for', async () => {
      // The panel carries the claim that can actually cost something: a reader who
      // trusts "the sliders below cast the first ballot" overwrites a real ballot.
      loadDocumentsWithScoresStillReading()

      const panel = await expectTeamPanelOpened()
      expect(panel).not.toHaveTextContent('No reviewer has scored this yet')
      expect(panel).not.toHaveTextContent('cast the first ballot')
      expect(panel).toHaveTextContent('still loading')
    })

    it('does not count a read in flight as an unscored backlog in the stats cards', async () => {
      loadDocumentsWithScoresStillReading()

      renderPrioritization()
      await screen.findByText('Feature A PR/FAQ')

      // The project read succeeded, so the total is a number; nothing else is known.
      expect(cardValue('Total Proposals')).toBe('1')
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
      const { impact } = await openRowSliders()
      fireEvent.change(impact, { target: { value: '5' } })

      expect(saveButton()).toBeDisabled()
      expect(prioritizationMocks.patchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('says nobody voted once the read LANDS on an empty map', async () => {
      // The discriminating positive control: "do not claim it is unscored while
      // loading" must not become "never claim it is unscored". The same fixture, with
      // the promise allowed to resolve.
      loadSingleRow({ scores: {}, aggregates: {} })

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

    /** The default two rows, with the caller's ballot on d1 carrying `notes`. */
    function loadRowWithStoredNote(notes: string) {
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({
        rows: DEFAULT_ROWS,
        scores: {
          [R.d1]: { row_id: R.d1, impact: 3, time_to_market: 3, confidence: 3, strategic_fit: 3, notes },
        },
      })
    }

    /**
     * Open the row holding a stored note and move a slider: Save arms and no note panel
     * appears, because the untouched note is not part of this write.
     */
    async function expectSliderMoveArmsSaveWithoutNotePanel() {
      const { user, impact } = await openRowSliders()
      fireEvent.change(impact, { target: { value: '5' } })

      await expectSaveEnabled()
      expect(screen.queryByRole('alert', { name: 'A note is too long to save' }))
        .not.toBeInTheDocument()
      return user
    }

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
      loadRowWithStoredNote('within the bound')
      const user = await openRow()
      const notes = await screen.findByPlaceholderText(/add notes/i)
      fireEvent.change(notes, { target: { value: overLong } })
      return user
    }

    it('bounds the notes textarea at the length the API accepts', async () => {
      await openRow()

      const notes = await screen.findByPlaceholderText(/add notes/i)
      // Asserted as a NUMBER against the shared constant, not as the string '2000':
      // a hardcoded literal in the JSX would pass a text comparison while drifting
      // from the bound the API enforces.
      expect(notes).toHaveAttribute('maxlength', String(MAX_NOTE_LENGTH))
    })

    it('blocks the save when an edited row carries an over-long note', async () => {
      await editARowWhoseNoteIsTooLong()

      await waitFor(() => {
        expect(saveButton()).toBeDisabled()
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

      await user.click(saveButton())

      expect(prioritizationMocks.patchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('lets a slider move on a row whose STORED note ran long, sending no note', async () => {
      // Previously this was blocked, because moving a slider re-sent the whole stored
      // ballot including a note the reviewer had not touched and the API would refuse.
      // A partial edit carries only the axis that moved, so the save is both legal and
      // honest: the over-long note stays exactly as stored, untouched by this write.
      loadRowWithStoredNote(overLong)
      const user = await expectSliderMoveArmsSaveWithoutNotePanel()
      await user.click(saveButton())

      expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({
        [R.d1]: { row_id: R.d1, impact: 5 },
      })
    })

    it('leaves an untouched row with a long note alone', async () => {
      // Only pending edits are sent, so a pre-ballot note that ran long on a row
      // nobody edited blocks nothing. Without this the panel would fire on load
      // and disable a page that has nothing wrong with it.
      loadRowWithStoredNote(overLong)

      await renderUntilRow()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps both panels separately addressable when a read also failed', async () => {
      // Nothing stops a failed read and a long pending note from coexisting, and
      // two same-role regions with no accessible name are indistinguishable — to a
      // screen reader, and to a `getByRole('alert')` that throws on the second
      // rather than saying which state was missing.
      givenTheScoresReadFails()
      await openRow()
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
      loadRowWithStoredNote('😀'.repeat(MAX_NOTE_LENGTH - 500))

      await expectSliderMoveArmsSaveWithoutNotePanel()
    })

    it('still saves a row whose note is within the bound', async () => {
      // The positive control: the block must be the note's length and nothing
      // else, or "save is disabled" would be satisfied by a page that never saves.
      loadRowWithStoredNote('x'.repeat(MAX_NOTE_LENGTH))
      const { user, impact } = await openRowSliders()
      await moveSliderAndSave(user, impact, '5')
      expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({
        [ROW_ID]: { impact: 5, row_id: ROW_ID },
      })
    })
  })
})
