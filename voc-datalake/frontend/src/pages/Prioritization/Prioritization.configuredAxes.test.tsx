/**
 * @fileoverview The board on a CONFIGURED scoring setup (RICE): every axis list — sliders,
 * the collapsed row's numbers, the sort buttons, the banner — comes from `axes`, and a save
 * sends the configured ids.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import './prioritization-mock-fixtures'
import { prioritizationMocks, DEFAULT_ROWS, R, resetPrioritizationPage } from './prioritization-fixtures'
import { openRowSliders, renderUntilRow, moveSliderAndSave } from './prioritization-render-fixtures'

const axis = (id: string, label: string | null, weight: number, extra: Record<string, unknown> = {}) => ({
  id, builtin: label === null, label, description: null, weight, direction: 'higher_better',
  low_label: null, high_label: null, archived: false, ...extra,
})
const RICE = [
  axis('reach', 'Reach', 30),
  axis('impact', null, 30),
  axis('confidence', null, 20),
  axis('effort', 'Effort', 20, { direction: 'lower_better', low_label: 'Little work', high_label: 'A lot of work' }),
  axis('time_to_market', null, 30, { archived: true }),
]

function loadRice() {
  prioritizationMocks.getPrioritizationScores.mockResolvedValue({
    rows: DEFAULT_ROWS,
    scores: { [R.d1]: { row_id: R.d1, reach: 4, effort: 2, time_to_market: 5, notes: '' } },
    axes: RICE,
    config_version: 2,
    // reach 4 · impact 2 · effort 5 (worst) → (120 + 60 + 20) / 80 = 2.5
    aggregates: { [R.d1]: { reach: 4, impact: 2, confidence: 0, effort: 5, time_to_market: 5, reviewer_count: 1, score_spread: 0 } },
  })
}

describe('a RICE setup on the board', () => {
  beforeEach(() => {
    resetPrioritizationPage()
    loadRice()
  })

  it('composites by the configured weights with Effort inverted, and shows the two heaviest metrics', async () => {
    await renderUntilRow()

    await waitFor(() => { expect(screen.getByText('2.5')).toBeInTheDocument() })
    const summary = within(screen.getByTestId('team-summary'))
    expect([summary.queryByText('Reach'), summary.queryByText('Impact')].every((el) => el !== null)).toBe(true)
    expect(summary.queryByText('Effort')).toBeNull()
  })

  it('offers a sort per active metric and none for an archived one', async () => {
    await renderUntilRow()

    // The sort segments are the toggle buttons (aria-pressed); each renders a short and a full name.
    const sorts = screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-pressed')).map((button) => button.textContent).join('|')
    expect(sorts).toContain('ReachReach|ImpactImpact|ConfidenceConfidence|EffortEffort')
    expect(sorts).not.toContain('Time to Market')
  })

  it('renders one slider per active metric, seeded from the stored ballot', async () => {
    const { sliders } = await openRowSliders()

    expect(sliders).toHaveLength(4)
    expect(sliders.map((slider) => slider.getAttribute('aria-label'))).toStrictEqual(['Reach', 'Impact', 'Confidence', 'Effort'])
    expect(screen.getByText('A lot of work')).toBeInTheDocument()
  })

  it('saves under the configured axis id', async () => {
    const { user, impact: reach } = await openRowSliders()
    await moveSliderAndSave(user, reach, '5')

    expect(prioritizationMocks.patchPrioritizationScores).toHaveBeenCalledWith({ [R.d1]: { row_id: R.d1, reach: 5 } })
  })
})
