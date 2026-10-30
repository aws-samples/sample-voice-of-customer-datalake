/**
 * The prioritization slider is named by its visible label and described by its
 * hint, explicitly — a production audit reported these range inputs unlabelled.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ScoreSlider from './ScoreSlider'

const noop = () => {}

describe('ScoreSlider accessible name', () => {
  it('is labelled by the visible axis name', () => {
    render(<ScoreSlider label="Impact" value={4} onChange={noop} canBeUnscored={false} description="How much it moves" />)

    const slider = screen.getByRole('slider', { name: 'Impact' })
    expect(document.getElementById(slider.getAttribute('aria-labelledby') ?? '')).toHaveTextContent('Impact')
    expect(slider).toHaveAccessibleDescription('How much it moves')
  })

  it('carries no dangling description when the axis has none', () => {
    render(<ScoreSlider label="Confidence" value={0} onChange={noop} canBeUnscored />)

    expect(screen.getByRole('slider', { name: 'Confidence' })).not.toHaveAttribute('aria-describedby')
  })
})

describe('ScoreSlider unscored state', () => {
  it('shows "Not scored" as visible text, not only to a screen reader', () => {
    render(<ScoreSlider label="Impact" value={0} onChange={noop} canBeUnscored />)

    expect(screen.getByText('Not scored')).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Impact' })).toHaveAttribute('aria-valuetext', 'Not scored')
  })
})
