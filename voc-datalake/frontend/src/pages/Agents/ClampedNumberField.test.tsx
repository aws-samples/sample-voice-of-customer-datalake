/**
 * The agent editor's whole-number input: what is typed reaches the draft clamped to [min, max], and an empty or
 * unreadable entry reads as `min`, so the draft never holds a value the API refuses.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ClampedNumberField } from './ClampedNumberField'

function renderField(readOnly = false) {
  const onChange = vi.fn<(value: number) => void>()
  render(<ClampedNumberField label="Max runs" hint="Per day" value={3} min={1} max={10} readOnly={readOnly} onChange={onChange} />)
  return { input: screen.getByLabelText('Max runs'), onChange }
}

describe('ClampedNumberField', () => {
  it.each([
    ['7', 7],
    ['42', 10],
    ['0', 1],
    ['', 1],
  ])('hands the draft %j as %d', (typed, expected) => {
    const { input, onChange } = renderField()

    fireEvent.change(input, { target: { value: typed } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('shows the value with its bounds and the hint', () => {
    const { input } = renderField()

    expect(input).toHaveValue(3)
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '10')
    expect(screen.getByText('Per day')).toBeInTheDocument()
  })

  it('is disabled when read-only', () => {
    expect(renderField(true).input).toBeDisabled()
  })
})
