/**
 * A strip's scroll button (components/TabStrip): named by its label (also its `title`), chevron by its side, out of
 * the tab order, and off (`aria-disabled`, pressing does nothing) while its side of the strip is not cut.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StripScrollButton } from './StripScrollButton'

describe('StripScrollButton', () => {
  it('scrolls toward its side while that side is cut', async () => {
    const onPress = vi.fn<() => void>()
    render(<StripScrollButton side="end" label="Scroll the tabs forward" cut onPress={onPress} />)
    const button = screen.getByRole('button', { name: 'Scroll the tabs forward' })
    expect([button.getAttribute('aria-disabled'), button.tabIndex, button.title]).toStrictEqual(['false', -1, 'Scroll the tabs forward'])
    await userEvent.setup().click(button)
    expect(onPress).toHaveBeenCalledExactlyOnceWith()
  })

  it('stays put, and says it is off, while its side is all in view', async () => {
    const onPress = vi.fn<() => void>()
    render(<StripScrollButton side="start" label="Scroll the tabs back" cut={false} onPress={onPress} />)
    const button = screen.getByRole('button', { name: 'Scroll the tabs back' })
    await userEvent.setup().click(button)
    expect([button.getAttribute('aria-disabled'), onPress.mock.calls.length]).toStrictEqual(['true', 0])
    expect(button.querySelector('svg')).toHaveClass('lucide-chevron-left')
  })
})
