/**
 * @fileoverview Tests for Prioritization page — the row leads with the team score
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './prioritization-mock-fixtures'
import {
  prioritizationMocks, oneRowPerDocument, installLayout, R, DEFAULT_ROWS, installSingleRow,
  loadSingleRow, unanimousAggregate, unanimousBallot, prfaqDocument, loadRowsWithTeamAggregates,
  resetPrioritizationPage, disagreeingRead,
} from './prioritization-fixtures'
import {
  renderPrioritization, renderUntilRow, renderUntilRowButton, openRow, openRowSliders, rowButton,
  saveButton, expectSaveEnabled, moveSliderAndSave, statsGrid, cardValue, rowTitles,
  expectRowOrderAfterLoad, expectRowNotPresentedAsUnscored,
} from './prioritization-render-fixtures'
import { required } from '../../components/component-spec-fixtures'

describe('Prioritization', () => {
  beforeEach(() => {
    resetPrioritizationPage()
  })

  describe('the row leads with the team score, not the reader own', () => {
    // Prioritization is a group exercise. The resting row shows what the group
    // said, the reader's own ballot moves behind the expansion, and the list is
    // ordered by the number the row displays.

    /** One row, scored top marks by the caller and 2.1 by the team — see `disagreeingRead`. */
    function loadDisagreeingBallotAndAggregate() {
      loadSingleRow(disagreeingRead())
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
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({
        rows: DEFAULT_ROWS,
        scores: {},
        aggregates: {
          [R.d1]: unanimousAggregate(4, 3),
        },
      })

      await renderUntilRow()
      expect(screen.queryByText(/^Spread/)).not.toBeInTheDocument()
    })

    it("keeps the caller own sliders and note editable one level in", async () => {
      loadDisagreeingBallotAndAggregate()
      const { sliders } = await openRowSliders()
      // Four axes, seeded from the CALLER'S ballot (5s), not from the team mean (2s).
      expect(sliders).toHaveLength(4)
      for (const slider of sliders) expect(slider).toHaveValue('5')
      expect(await screen.findByPlaceholderText(/add notes/i)).toHaveValue('mine')
    })

    it("still saves only the caller own ballot from the expanded row", async () => {
      loadDisagreeingBallotAndAggregate()
      const { user, impact } = await openRowSliders()
      await moveSliderAndSave(user, impact, '1')

      // The one axis the reader moved, and nothing about the aggregate. The other
      // three are OMITTED even though this row has a stored ballot for them: the verb
      // is PATCH, so an absent axis means "leave it alone", and re-sending a value the
      // reader did not touch is how the save path was able to write scores nobody
      // chose (see the partial-first-ballot case below).
      expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({
        [R.d1]: { row_id: R.d1, impact: 1 },
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
      installSingleRow()
      // Nobody has scored it: no ballot of the caller's own, and no team row.
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({ scores: {}, aggregates: {} })
      const { user, impact } = await openRowSliders()
      // Exactly one slider moves. The other three read "Not scored" (#343 —
      // the handle rests mid-track as presentation, but no number is asserted
      // on screen), and an unscored axis must not become a vote.
      await moveSliderAndSave(user, impact, '5')

      expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({
        [R.d1]: { row_id: R.d1, impact: 5 },
      })
      // Asserted key by key as well: the equality above passes for an axis present as
      // `undefined`, and a regression that sends `0` — the value the backend counts as
      // a vote — is exactly what this test exists to catch.
      const firstCall = prioritizationMocks.patchPrioritizationScores.mock.calls.at(0)
      const sent = required(firstCall?.[0][R.d1], 'the patched ballot for d1')
      for (const axis of ['time_to_market', 'confidence', 'strategic_fit', 'notes']) {
        expect(Object.hasOwn(sent, axis), axis).toBe(false)
      }
    })

    it('shows a stored partial ballot as it is recorded: the scored axis a number, the rest not scored', async () => {
      // The assertion nothing made before #343. The editor coerced a stored 0
      // to a displayed 3 — purely for display, never written — so after a
      // partial save the sliders read 4/3/3/3 against a record of 4/0/0/0,
      // and the reviewer could never discover on screen that three quarters of
      // their ballot was recorded as nothing. Reproduced on production before
      // it was fixed; this pins that the editor and the record now agree.
      loadSingleRow({
        // Exactly what the API returns after `PATCH {impact: 4}` on a fresh
        // row: the expressed axis, and 0.0 (the wire encoding of "absent") for
        // the rest.
        scores: {
          [R.d1]: { row_id: R.d1, impact: 4, time_to_market: 0, confidence: 0, strategic_fit: 0, notes: '' },
        },
        aggregates: {
          [R.d1]: { impact: 4, time_to_market: 0, confidence: 0, strategic_fit: 0, reviewer_count: 1, score_spread: 0 },
        },
      })
      const { sliders, impact } = await openRowSliders()

      // The one scored axis reads as its number...
      expect(impact).toHaveValue('4')
      expect(impact).not.toHaveAttribute('aria-valuetext')
      // ...and each unscored one says so where a screen reader listens. The
      // handle may REST at mid-track (a range input cannot be valueless), but
      // no number is presented as the axis's value.
      for (const slider of sliders.slice(1)) {
        expect(slider).toHaveAttribute('aria-valuetext', 'Not scored')
      }
    })

    it('releasing a press on an unscored slider commits the resting value, so exactly-3 is reachable by click', async () => {
      // Clicking the track AT the resting position fires no `change` (the value
      // did not move), so without this path a reviewer who wants exactly 3 has
      // no way to say so short of wiggling the handle. The commit reads the
      // value off the CONTROL at release — not this render's props — so a
      // click-at-5 (whose `change` fires first) cannot be rewritten back to 3
      // by a stale closure. Reverting the onPointerUp path fails this test:
      // no change event fires, no edit is recorded, Save stays disabled.
      loadSingleRow({ scores: {}, aggregates: {} })
      const { user, timeToMarket } = await openRowSliders()
      expect(timeToMarket).toHaveAttribute('aria-valuetext', 'Not scored')

      // A press that starts AND ends on the control, without moving: the
      // click-at-the-resting-position case.
      fireEvent.pointerDown(timeToMarket)
      fireEvent.pointerUp(timeToMarket)

      await expectSaveEnabled()
      await user.click(saveButton())
      expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({
        [R.d1]: { row_id: R.d1, time_to_market: 3 },
      })
    })

    it('a pointer released over an unscored slider after going down elsewhere casts nothing', async () => {
      // `pointerup` fires on whatever the pointer is over when it is released,
      // including a press that started on the row header and drifted. A stray
      // release must not cast a vote nobody aimed at the control.
      loadSingleRow({ scores: {}, aggregates: {} })
      const { timeToMarket } = await openRowSliders()

      // Release over the control with NO pointerdown on it first.
      fireEvent.pointerUp(timeToMarket)

      expect(saveButton()).toBeDisabled()
      expect(prioritizationMocks.patchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('a press that starts on an unscored slider and ends elsewhere does not arm the next stray release', async () => {
      // The stuck-flag case: without clearing the guard on pointerleave, a
      // press that started on the slider and ended off it leaves the flag
      // armed, and the NEXT unrelated release over the input casts the resting
      // value — the exact stray vote the guard exists to prevent, one
      // interaction later. Removing the clearing handlers fails this test.
      loadSingleRow({ scores: {}, aggregates: {} })
      const { timeToMarket } = await openRowSliders()

      fireEvent.pointerDown(timeToMarket)
      fireEvent.pointerLeave(timeToMarket)
      // The press ended elsewhere; this later release over the input is stray.
      fireEvent.pointerUp(timeToMarket)

      expect(saveButton()).toBeDisabled()
      expect(prioritizationMocks.patchPrioritizationScores).not.toHaveBeenCalled()
    })

    it('says nobody has scored a document absent from the aggregate', async () => {
      // The defect this closes: DEFAULT_SCORE has time_to_market 3 and the old
      // summary substituted 3 for an unset axis, so an untouched proposal
      // presented as a mid-table score.
      loadSingleRow({ scores: {}, aggregates: {} })

      const row = await renderUntilRowButton()
      expect(row).toHaveTextContent('Not scored yet')
      // No mid-table number invented from the defaults: 0.9 is what
      // calculatePriorityScore returns for DEFAULT_SCORE, and 3.0 is what the old
      // summary rendered for an unset time-to-market axis. Asserted as the VALUES
      // the summary would render, not as the substring '3': a bare digit matched
      // against the row's whole text also matches its date and project name, so that
      // assertion held only while unrelated fixture data happened to avoid the digit.
      expect({
        defaultComposite: within(row).queryByText('0.9'),
        defaultTimeToMarket: within(row).queryByText('3.0'),
      }).toStrictEqual({ defaultComposite: null, defaultTimeToMarket: null })
      // The em dash stands where the number would be — a placeholder, never a score, and
      // hidden from assistive technology for that reason: announced alone it reads like a
      // value, while the label beneath it carries the actual state.
      expect(within(row).getByText('—')).toHaveAttribute('aria-hidden', 'true')
      // And the band beside the title says so too, rather than "Low Priority".
      expect(row).toHaveTextContent('Not Scored')
    })

    it('sorts by the team composite, grouping the unscored below a low score', async () => {
      // Three ROWS, so three projects — one row per project is the rule now, and
      // three documents in one project would be one row with nothing to order.
      // Listed in the order the expectation must NOT be: with no sort applied at
      // all, a stable sort leaves this order (reversed for `desc`) on screen, so
      // an assertion that agreed with it would pass without any ordering.
      loadRowsWithTeamAggregates(
        [
          prfaqDocument('d3', 'Team Rated High', '2025-01-03'),
          prfaqDocument('d2', 'Team Rated Low', '2025-01-02'),
          prfaqDocument('d1', 'Nobody Scored', '2025-01-01'),
        ],
        { d2: unanimousAggregate(1, 2), d3: unanimousAggregate(5, 2) },
        // The caller's own ballot ranks them in the OPPOSITE order, so a list still
        // sorting by the caller's map cannot pass this by coincidence.
        { d1: 5, d2: 4, d3: 1 },
      )

      // Default sort is priority, descending: highest team score first, and the
      // unscored proposal last rather than ahead of the one the team rated low.
      await expectRowOrderAfterLoad(['Team Rated High', 'Team Rated Low', 'Nobody Scored'])
    })

    it('reads as unscored when the deployment sends no aggregates at all', async () => {
      // The field is additive: a deployment predating it answers `scores` alone,
      // and that must not throw or present the caller's own numbers as the team's.
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({
        rows: DEFAULT_ROWS,
        scores: {
          [R.d1]: unanimousBallot(R.d1, 5),
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
      installLayout(oneRowPerDocument([
        { document_id: 'd1', document_type: 'prfaq', title: 'High For Team', content: '', created_at: '2025-01-01' },
        { document_id: 'd2', document_type: 'prfaq', title: 'Unscored By Team', content: '', created_at: '2025-01-02' },
      ]))
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({
        rows: DEFAULT_ROWS,
        // Reading the caller's map would count d1 as neither high nor medium
        // (composite 1.0) and both rows as not-scored — the opposite of the truth.
        scores: {
          [R.d1]: unanimousBallot(R.d1, 1),
        },
        aggregates: {
          [R.d1]: unanimousAggregate(5, 2),
        },
      })

      renderPrioritization()
      await screen.findByText('High For Team')

      // Scoped to the stats grid: "High Priority" and "Not Scored" are also the
      // row's own priority-band labels, so an unscoped query reads a row.
      expect(statsGrid()).not.toBeNull()

      // One high (the team's 5.0) and one not scored (absent from the aggregate).
      expect({
        high: cardValue('High Priority'),
        notScored: cardValue('Not Scored'),
        medium: cardValue('Medium Priority'),
      }).toStrictEqual({ high: '1', notScored: '1', medium: '0' })
    })

    // Two rows the page must not describe with the same words: one the team all
    // rated 1, one nobody has opened. The band used to read `composite ?? 0` and
    // called both "Not Scored", beside a live 1.0 and a reviewer count — the
    // issue's "distinguishable in the row" criterion failing in the row.
    async function renderLowestBesideUnopened() {
      loadRowsWithTeamAggregates([
        prfaqDocument('d1', 'Team Rated Lowest', '2025-01-01'),
        prfaqDocument('d2', 'Nobody Opened It', '2025-01-02'),
      ], { d1: unanimousAggregate(1, 3) })

      renderPrioritization()
      await screen.findByText('Team Rated Lowest')
    }

    it('bands a unanimously-lowest team score as low, not as unscored', async () => {
      await renderLowestBesideUnopened()

      const scoredLow = rowButton(/Team Rated Lowest/)
      expect(scoredLow).toHaveTextContent('Low Priority')
      // The number it is labelled beside, and the count that says it is a real
      // verdict rather than an empty row. Read from the composite slot rather than
      // by text: a unanimous 1 prints 1.0 on every axis too, so `getByText('1.0')`
      // would be satisfied by an axis instead of the headline.
      expect({
        composite: within(scoredLow).getByText('Team Score').previousElementSibling?.textContent,
        reviewers: within(scoredLow).getByText('Reviewers').previousElementSibling?.textContent,
      }).toStrictEqual({ composite: '1.0', reviewers: '3' })
      // The words reserved for "nobody voted" are not on a row somebody voted on.
      expectRowNotPresentedAsUnscored(scoredLow)
    })

    it('still bands the unopened neighbour of a low row as not scored', async () => {
      await renderLowestBesideUnopened()

      const unscored = rowButton(/Nobody Opened It/)
      expect(unscored).toHaveTextContent('Not Scored')
      expect(unscored).not.toHaveTextContent('Low Priority')
    })

    it('bands and counts a unanimous 4 as high, matching the 4.0 it prints', async () => {
      // 4 on every axis weighs to 3.9999999999999996. The row prints `4.0`; an
      // unrounded `>= 4` banded it Medium and counted it under Medium Priority, so
      // the card, the band and the number all disagreed on one document.
      installLayout(oneRowPerDocument([
        { document_id: 'd1', document_type: 'prfaq', title: 'Unanimous Four', content: '', created_at: '2025-01-01' },
      ]))
      prioritizationMocks.getPrioritizationScores.mockResolvedValue({
        rows: DEFAULT_ROWS,
        scores: {},
        aggregates: {
          [R.d1]: unanimousAggregate(4, 2),
        },
      })

      renderPrioritization()
      await screen.findByText('Unanimous Four')

      const row = rowButton(/Unanimous Four/)
      // The composite slot specifically: every axis also prints 4.0 on this fixture.
      expect(within(row).getByText('Team Score').previousElementSibling?.textContent).toBe('4.0')
      expect(row).toHaveTextContent('High Priority')
      expect(row).not.toHaveTextContent('Medium Priority')
      // And the card above the row agrees with the label on it.
      expect({ high: cardValue('High Priority'), medium: cardValue('Medium Priority') })
        .toStrictEqual({ high: '1', medium: '0' })
    })

    it('shows an out-of-range team mean at the top of the scale, not at the bottom', async () => {
      // Verified defect: an all-out-of-range row cleared the readability floor (each
      // axis IS a number) and every axis was then caught to 0, so a document three
      // reviewers had scored rendered `0.0 / 0.0 / 0.0`, "Reviewers 3", banded "Low
      // Priority", with a "Spread 2.0" badge over numbers the parse had thrown away —
      // and it sorted BELOW a row the team genuinely rated 1 across the board.
      loadRowsWithTeamAggregates([
        prfaqDocument('d1', 'Out Of Range', '2025-01-01'),
        prfaqDocument('d2', 'Genuinely Lowest', '2025-01-02'),
      ], { d1: unanimousAggregate(6, 3, 2), d2: unanimousAggregate(1, 3) })

      renderPrioritization()
      await screen.findByText('Out Of Range')

      const row = rowButton(/Out Of Range/)
      // Clamped onto the scale, so the row still describes data somebody cast.
      expect(within(row).getByText('Team Score').previousElementSibling?.textContent).toBe('5.0')
      expect(row).toHaveTextContent('High Priority')
      expect(row).not.toHaveTextContent('Low Priority')
      // And it outranks the row the team actually rated lowest, rather than sorting
      // beneath it on a score the parse invented.
      expect(rowTitles()).toStrictEqual(['Out Of Range', 'Genuinely Lowest'])
    })

    it('prints the axis value the sort ranks by, where the two roundings differ', async () => {
      // 4.35 is the discriminating mean: `(4.35).toFixed(1)` is "4.3" (the stored double
      // is 4.34999…), while `Math.round(4.35 * 10) / 10` is 4.4. So printing the raw mean
      // while ordering by the rounded one puts the row and the list back into
      // disagreement — the thing one shared rounding exists to prevent. The row must show
      // the value the sort uses.
      loadSingleRow({
        rows: DEFAULT_ROWS,
        scores: {},
        aggregates: {
          [R.d1]: {
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
      loadRowsWithTeamAggregates([
        prfaqDocument('d1', 'Nobody Scored', '2025-01-01'),
        prfaqDocument('d2', 'Team Rated Low', '2025-01-02'),
        prfaqDocument('d3', 'Team Rated High', '2025-01-03'),
      ], { d2: unanimousAggregate(1, 2), d3: unanimousAggregate(5, 2) })

      await expectRowOrderAfterLoad(['Team Rated High', 'Team Rated Low', 'Nobody Scored'])

      // Toggle the active sort field to ascending. Matched on the sort control's own
      // accessible name, which carries both the mobile and desktop labels: a bare
      // `/priority/i` also matches every row button whose band label reads "Low
      // Priority" or "High Priority", and picked the sort button only because
      // `SortControls` happens to precede `PRFAQList` in the DOM.
      await user.click(screen.getByRole('button', { name: /Priority Score$/ }))

      await waitFor(() => {
        expect(rowTitles()).toStrictEqual(['Team Rated Low', 'Team Rated High', 'Nobody Scored'])
      })
    })

    it('keeps the customer evidence out of the team score panel', async () => {
      // The row carries two numeric stories and they must stay distinct: the star
      // average comes from customers and deliberately does not feed the priority.
      loadDisagreeingBallotAndAggregate()
      await openRow()

      const teamPanel = (await screen.findByText('What the Team Said')).closest('div')
      expect(teamPanel).not.toBeNull()
      expect(teamPanel?.textContent).not.toMatch(/Avg Rating|Collected Feedback/)
      // Both stories are on the expanded row, in separate panels.
      expect(screen.getByText('Collected Feedback')).toBeInTheDocument()
    })
  })
})
