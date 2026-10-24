/**
 * The prioritization slider is named by its visible label and described by its
 * hint, explicitly — a production audit reported these range inputs unlabelled.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ScoreSlider from './ScoreSlider'

const noop = () => undefined

describe('ScoreSlider accessible name', () => {
  it('is labelled by the visible axis name', () => {
    render(<ScoreSlider label="Impact" value={4} onChange={noop} description="How much it moves" />)

    const slider = screen.getByRole('slider', { name: 'Impact' })
    expect(document.getElementById(slider.getAttribute('aria-labelledby') ?? '')).toHaveTextContent('Impact')
    expect(slider).toHaveAccessibleDescription('How much it moves')
  })

  it('carries no dangling description when the axis has none', () => {
    render(<ScoreSlider label="Confidence" value={0} onChange={noop} />)

    expect(screen.getByRole('slider', { name: 'Confidence' })).not.toHaveAttribute('aria-describedby')
  })
})
