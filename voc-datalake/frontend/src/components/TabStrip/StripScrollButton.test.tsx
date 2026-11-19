/**
 * A tab strip's scroll button: named by its label, out of the tab order, and off (`aria-disabled`, still there for its
 * Tooltip) while its side of the strip is not cut, so a press then scrolls nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StripScrollButton } from './StripScrollButton'

describe('StripScrollButton', () => {
  it.each([
    { side: 'start' as const, label: 'Scroll left' },
    { side: 'end' as const, label: 'Scroll right' },
  ])('scrolls toward the $side when that side is cut', async ({ side, label }) => {
    const user = userEvent.setup()
    const onPress = vi.fn<() => void>()
    render(<StripScrollButton side={side} label={label} cut onPress={onPress} />)
    const button = screen.getByRole('button', { name: label })
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(button).toHaveAttribute('tabindex', '-1')
    await user.click(button)
    expect(onPress).toHaveBeenCalledExactlyOnceWith()
  })

  it('is off, and scrolls nothing, while its side is not cut', async () => {
    const user = userEvent.setup()
    const onPress = vi.fn<() => void>()
    render(<StripScrollButton side="end" label="Scroll right" cut={false} onPress={onPress} />)
    const button = screen.getByRole('button', { name: 'Scroll right' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.click(button)
    expect(onPress).not.toHaveBeenCalled()
  })
})
